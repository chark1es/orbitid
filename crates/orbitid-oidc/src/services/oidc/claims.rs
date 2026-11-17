//! Claims shared by the ID token and the userinfo endpoint, ported from
//! `services/oidc/claims.ts`: profile, email, phone, groups and organization
//! data.

use serde_json::{Map, Value};
use sqlx::PgConnection;

use orbitid_core::error::Result;
use orbitid_core::models::{EmailAddressRow, PhoneNumberRow, UserRow};
use orbitid_core::state::AppState;

use orbitid_identity::rbac::permissions_for_role_keys_on;
use orbitid_identity::user_roles::role_claims_for_user;

use super::applications::ApplicationRow;

pub async fn primary_email(state: &AppState, user: &UserRow) -> Result<Option<EmailAddressRow>> {
    let Some(id) = user.primary_email_address_id.as_deref() else {
        return Ok(None);
    };
    Ok(
        sqlx::query_as::<_, EmailAddressRow>("SELECT * FROM email_addresses WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

pub async fn primary_phone(state: &AppState, user: &UserRow) -> Result<Option<PhoneNumberRow>> {
    let Some(id) = user.primary_phone_number_id.as_deref() else {
        return Ok(None);
    };
    Ok(
        sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

/// Unix seconds of the authorizing session's first factor, for `auth_time` /
/// `max_age`.
pub async fn session_auth_time(state: &AppState, session_id: &str) -> Result<Option<i64>> {
    if session_id.is_empty() {
        return Ok(None);
    }
    let row: Option<(i64, Option<i64>)> =
        sqlx::query_as("SELECT created_at, first_factor_verified_at FROM sessions WHERE id = $1")
            .bind(session_id)
            .fetch_optional(&state.pool)
            .await?;
    Ok(row.map(|(created_at, first_factor)| first_factor.unwrap_or(created_at) / 1000))
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct OrgMembershipClaim {
    pub id: String,
    pub slug: Option<String>,
    pub name: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveOrgClaim {
    pub id: String,
    pub slug: Option<String>,
    pub role: String,
    pub permissions: Vec<String>,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OrganizationClaims {
    pub active: Option<ActiveOrgClaim>,
    pub memberships: Vec<OrgMembershipClaim>,
}

/// Active organization (from the authorizing session) + every membership.
pub async fn organization_claims(
    state: &AppState,
    user_id: &str,
    session_id: Option<&str>,
) -> Result<OrganizationClaims> {
    let mut conn = state.pool.acquire().await?;
    organization_claims_on(&mut conn, state, user_id, session_id).await
}

/// [`organization_claims`] on one connection: every row is read through `conn`,
/// so the result is one self-consistent view when `conn` is in a transaction.
pub async fn organization_claims_on(
    conn: &mut PgConnection,
    state: &AppState,
    user_id: &str,
    session_id: Option<&str>,
) -> Result<OrganizationClaims> {
    if !state.settings.get().organizations.enabled {
        return Ok(OrganizationClaims::default());
    }
    let mut active_org_id: Option<String> = None;
    if let Some(session_id) = session_id.filter(|value| !value.is_empty()) {
        let row: Option<(String, Option<String>)> = sqlx::query_as(
            "SELECT user_id, last_active_organization_id FROM sessions WHERE id = $1",
        )
        .bind(session_id)
        .fetch_optional(&mut *conn)
        .await?;
        if let Some((session_user, org)) = row {
            if session_user == user_id {
                active_org_id = org;
            }
        }
    }
    let rows: Vec<(String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT o.id, o.slug, o.name, m.role_key FROM organization_memberships m \
         JOIN organizations o ON o.id = m.organization_id \
         WHERE m.user_id = $1 ORDER BY o.name ASC, o.id ASC",
    )
    .bind(user_id)
    .fetch_all(&mut *conn)
    .await?;
    let memberships: Vec<OrgMembershipClaim> = rows
        .into_iter()
        .map(|(id, slug, name, role)| OrgMembershipClaim {
            id,
            slug,
            name,
            role,
        })
        .collect();
    let mut active = None;
    if let Some(found) = active_org_id
        .as_deref()
        .and_then(|id| memberships.iter().find(|membership| membership.id == id))
    {
        let mut permissions =
            permissions_for_role_keys_on(&mut *conn, std::slice::from_ref(&found.role)).await?;
        active = Some(ActiveOrgClaim {
            id: found.id.clone(),
            slug: found.slug.clone(),
            role: found.role.clone(),
            permissions: permissions.remove(&found.role).unwrap_or_default(),
        });
    }
    Ok(OrganizationClaims {
        active,
        memberships,
    })
}

/// Adds `org_*` and `organizations` claims when the `organizations` scope was granted.
pub fn append_org_claims(claims: &mut Map<String, Value>, orgs: OrganizationClaims) {
    if let Some(active) = orgs.active {
        claims.insert("org_id".into(), Value::String(active.id));
        claims.insert(
            "org_slug".into(),
            active.slug.map(Value::String).unwrap_or(Value::Null),
        );
        claims.insert("org_role".into(), Value::String(active.role));
        claims.insert(
            "org_permissions".into(),
            serde_json::json!(active.permissions),
        );
    }
    claims.insert(
        "organizations".into(),
        Value::Array(
            orgs.memberships
                .into_iter()
                .map(|membership| {
                    serde_json::json!({
                        "id": membership.id,
                        "slug": membership.slug,
                        "name": membership.name,
                        "role": membership.role,
                    })
                })
                .collect(),
        ),
    );
}

/// The `groups` claim for this application (stable identifiers only). Token
/// issuers pass the organization claims of their authority snapshot as `orgs`;
/// `None` reads them (userinfo).
pub async fn groups_for_user(
    state: &AppState,
    application: &ApplicationRow,
    user_id: &str,
    orgs: Option<&OrganizationClaims>,
) -> Result<Option<Vec<String>>> {
    let mode = if application.groups_claim.is_empty() {
        "all"
    } else {
        application.groups_claim.as_str()
    };
    if mode == "none" {
        return Ok(None);
    }
    let mut values: Vec<String> = Vec::new();
    let mut push = |value: String| {
        if !values.contains(&value) {
            values.push(value);
        }
    };
    if mode == "organizations" || mode == "all" || mode == "roles" {
        let loaded;
        let orgs = match orgs {
            Some(orgs) => orgs,
            None => {
                loaded = organization_claims(state, user_id, None).await?;
                &loaded
            }
        };
        if mode == "organizations" || mode == "all" {
            for membership in &orgs.memberships {
                if let Some(slug) = &membership.slug {
                    push(slug.clone());
                }
            }
        }
        if mode == "roles" || mode == "all" {
            for membership in &orgs.memberships {
                push(membership.role.clone());
            }
        }
    }
    if mode == "roles" || mode == "all" {
        for role in role_claims_for_user(state, user_id).await?.roles {
            push(role);
        }
    }
    values.sort();
    Ok(Some(values))
}

/// OIDC `at_hash`: base64url of the left half of SHA-256 over the ASCII access
/// token (RS256).
pub fn access_token_hash(access_token: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(access_token.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(&digest[..16])
}

/// Profile/email/phone claims shared by the ID token and userinfo.
pub async fn profile_claims(
    state: &AppState,
    user: &UserRow,
    scopes: &[String],
) -> Result<Map<String, Value>> {
    let mut claims = Map::new();
    let needs_email = scopes.iter().any(|s| s == "profile" || s == "email");
    let email = if needs_email {
        primary_email(state, user).await?
    } else {
        None
    };
    if scopes.iter().any(|s| s == "profile") {
        let full_name = [user.first_name.clone(), user.last_name.clone()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        let name = if !full_name.is_empty() {
            full_name
        } else if let Some(username) = &user.username {
            username.clone()
        } else if let Some(email) = &email {
            email.email.clone()
        } else {
            user.id.clone()
        };
        claims.insert("name".into(), Value::String(name));
        if let Some(first) = &user.first_name {
            claims.insert("given_name".into(), Value::String(first.clone()));
        }
        if let Some(last) = &user.last_name {
            claims.insert("family_name".into(), Value::String(last.clone()));
        }
        if let Some(image) = &user.image_url {
            claims.insert("picture".into(), Value::String(image.clone()));
        }
        let preferred = user
            .username
            .clone()
            .or_else(|| {
                email
                    .as_ref()
                    .and_then(|email| email.email.split('@').next())
                    .map(str::to_string)
            })
            .unwrap_or_else(|| user.id.clone());
        claims.insert("preferred_username".into(), Value::String(preferred));
        claims.insert("updated_at".into(), Value::from(user.updated_at / 1000));
        if let Some(Value::String(locale)) = user.public_metadata.0.get("locale") {
            if !locale.is_empty() {
                claims.insert("locale".into(), Value::String(locale.clone()));
            }
        }
    }
    if scopes.iter().any(|s| s == "email") {
        if let Some(email) = &email {
            claims.insert("email".into(), Value::String(email.email.clone()));
            claims.insert("email_verified".into(), Value::Bool(email.verified));
        }
    }
    if scopes.iter().any(|s| s == "phone") {
        if let Some(phone) = primary_phone(state, user).await? {
            claims.insert("phone_number".into(), Value::String(phone.phone.clone()));
            claims.insert("phone_number_verified".into(), Value::Bool(phone.verified));
        }
    }
    Ok(claims)
}

#[derive(Debug, Clone)]
pub struct IdTokenInput<'a> {
    pub user: &'a UserRow,
    pub application: &'a ApplicationRow,
    pub scopes: &'a [String],
    pub nonce: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub access_token: &'a str,
    /// The organization claims of the issuer's authority snapshot.
    pub organizations: &'a OrganizationClaims,
}

pub async fn build_id_token_claims(
    state: &AppState,
    input: IdTokenInput<'_>,
) -> Result<Map<String, Value>> {
    let mut claims = Map::new();
    claims.insert("sub".into(), Value::String(input.user.id.clone()));
    claims.insert(
        "azp".into(),
        Value::String(input.application.client_id.clone()),
    );
    claims.insert(
        "at_hash".into(),
        Value::String(access_token_hash(input.access_token)),
    );
    if let Some(session_id) = input.session_id.filter(|value| !value.is_empty()) {
        claims.insert("sid".into(), Value::String(session_id.to_string()));
        if let Some(auth_time) = session_auth_time(state, session_id).await? {
            claims.insert("auth_time".into(), Value::from(auth_time));
        }
    }
    if let Some(nonce) = input.nonce.filter(|value| !value.is_empty()) {
        claims.insert("nonce".into(), Value::String(nonce.to_string()));
    }
    for (key, value) in profile_claims(state, input.user, input.scopes).await? {
        claims.insert(key, value);
    }
    if input.scopes.iter().any(|s| s == "groups") {
        if let Some(groups) = groups_for_user(
            state,
            input.application,
            &input.user.id,
            Some(input.organizations),
        )
        .await?
        {
            claims.insert("groups".into(), serde_json::json!(groups));
        }
    }
    if input.scopes.iter().any(|s| s == "organizations") {
        append_org_claims(&mut claims, input.organizations.clone());
    }
    Ok(claims)
}

/// OIDC userinfo payload, filtered by the granted scopes.
pub async fn user_info_claims(
    state: &AppState,
    grant: &orbitid_core::models::OauthGrantRow,
    user: &UserRow,
) -> Result<Value> {
    let scopes = super::shared::parse_scopes(&grant.scopes);
    let application = super::applications::get_application(state, &grant.application_id).await?;
    let mut claims = Map::new();
    claims.insert("sub".into(), Value::String(user.id.clone()));
    for (key, value) in profile_claims(state, user, &scopes).await? {
        claims.insert(key, value);
    }
    if scopes.iter().any(|s| s == "groups") {
        if let Some(application) = &application {
            if let Some(groups) = groups_for_user(state, application, &user.id, None).await? {
                claims.insert("groups".into(), serde_json::json!(groups));
            }
        }
    }
    if scopes.iter().any(|s| s == "organizations") {
        let orgs = organization_claims(state, &user.id, grant.session_id.as_deref()).await?;
        append_org_claims(&mut claims, orgs);
    }
    Ok(Value::Object(claims))
}
