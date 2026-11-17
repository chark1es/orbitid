//! Planning and persistence of OIDC token sets, ported from
//! `services/oidc/token-set.ts`. Reads and signing happen in `plan_token_set`;
//! the rows are written by `insert_planned_token_set`, so callers can persist
//! them inside one transaction (refresh rotation) or immediately.

use serde::Serialize;
use serde_json::{Map, Value};
use sqlx::PgConnection;

use orbitid_core::crypto::{random_token, sha256};
use orbitid_core::error::Result;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::UserRow;
use orbitid_core::settings::AccessTokenFormat;
use orbitid_core::state::AppState;

use orbitid_credentials::session::SignJwtOptions;
use orbitid_credentials::sign_jwt;

use super::applications::{application_lifetimes, ApplicationRow};
use super::claims::{
    append_org_claims, build_id_token_claims, groups_for_user, organization_claims_on,
    OrganizationClaims,
};

#[derive(Clone, Serialize)]
pub struct TokenSet {
    pub access_token: String,
    pub token_type: &'static str,
    pub expires_in: i64,
    pub scope: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub refresh_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id_token: Option<String>,
}

impl std::fmt::Debug for TokenSet {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("TokenSet")
            .field("access_token", &"<redacted>")
            .field("token_type", &self.token_type)
            .field("expires_in", &self.expires_in)
            .field("scope", &self.scope)
            .field("refresh_token", &"<redacted>")
            .field("id_token", &"<redacted>")
            .finish()
    }
}

/// Every column the planner writes on a new grant row.
#[derive(Debug, Clone)]
pub struct GrantInsert {
    pub id: String,
    pub kind: &'static str,
    pub application_id: String,
    pub user_id: String,
    pub token_hash: String,
    pub scopes: String,
    pub redirect_uri: Option<String>,
    pub code_challenge: Option<String>,
    pub code_challenge_method: Option<String>,
    pub nonce: Option<String>,
    pub family_id: Option<String>,
    pub session_id: Option<String>,
    pub revoked: bool,
    pub expires_at: i64,
    pub created_at: i64,
}

#[derive(Debug, Clone)]
pub struct TokenSetInput<'a> {
    pub application: &'a ApplicationRow,
    pub user: &'a UserRow,
    pub scopes: &'a [String],
    pub family: &'a str,
    pub nonce: Option<&'a str>,
    pub session_id: Option<&'a str>,
    pub issuer: Option<&'a str>,
    /// A pre-generated refresh-token id/value. The refresh exchange claims the
    /// old token (storing this successor) before inserting the new row.
    pub refresh: Option<(String, String)>,
    /// Return this existing refresh token instead of rotating.
    pub reuse_refresh_token: Option<&'a str>,
}

#[derive(Debug, Clone)]
pub struct PlannedTokenSet {
    pub set: TokenSet,
    pub access: GrantInsert,
    pub refresh: Option<GrantInsert>,
}

/// The organization authority a token's claims are built from: the session it
/// is read for and every organization-derived claim (memberships with slug,
/// name and role, the active organization and its role's permission keys).
/// Planning builds the claims **from this value**, never from the pool, so the
/// value compared under the user lock ([`authority_unchanged_on`]) is exactly
/// what the token carries.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AuthoritySnapshot {
    pub session_id: Option<String>,
    pub organizations: OrganizationClaims,
}

/// Reads the [`AuthoritySnapshot`] of `user_id` on `conn`.
pub async fn authority_snapshot_on(
    conn: &mut PgConnection,
    state: &AppState,
    user_id: &str,
    session_id: Option<&str>,
) -> Result<AuthoritySnapshot> {
    let session_id = session_id
        .filter(|value| !value.is_empty())
        .map(str::to_string);
    let organizations = organization_claims_on(conn, state, user_id, session_id.as_deref()).await?;
    Ok(AuthoritySnapshot {
        session_id,
        organizations,
    })
}

/// [`authority_snapshot_on`] on a pooled connection, taken **before** planning.
/// Planning derives every organization claim from this value; each issuer
/// re-reads it under the user lock ([`authority_unchanged_on`]) and refuses on
/// any difference. A promote-then-demote (or add-then-remove) that commits
/// between the two reads can only make the re-read equal to the snapshot again,
/// and the token carries the snapshot, not whatever was current in between.
pub async fn authority_snapshot(
    state: &AppState,
    user_id: &str,
    session_id: Option<&str>,
) -> Result<AuthoritySnapshot> {
    let mut conn = state.pool.acquire().await?;
    authority_snapshot_on(&mut conn, state, user_id, session_id).await
}

/// Whether the organization authority still equals `snapshot`. Call after
/// `key_share_active_user_on` and before the first grant write; organization
/// authority changes hold the user `FOR UPDATE`, so afterwards they wait for the
/// issuing commit and their revocation sees the rows inserted.
pub async fn authority_unchanged_on(
    conn: &mut PgConnection,
    state: &AppState,
    user_id: &str,
    snapshot: &AuthoritySnapshot,
) -> Result<bool> {
    let current =
        authority_snapshot_on(conn, state, user_id, snapshot.session_id.as_deref()).await?;
    Ok(current == *snapshot)
}

/// Computes a token set and every row it needs, without writing anything. The
/// organization claims come from `authority` only.
pub async fn plan_token_set(
    state: &AppState,
    input: &TokenSetInput<'_>,
    authority: &AuthoritySnapshot,
) -> Result<PlannedTokenSet> {
    let now = orbitid_core::http::now();
    let scope = input.scopes.join(" ");
    let session_id = input.session_id.filter(|value| !value.is_empty());
    let issuer = input
        .issuer
        .map(str::to_string)
        .unwrap_or_else(|| state.env.base_url.clone());
    let (access_lifetime, refresh_lifetime, id_lifetime) = application_lifetimes(input.application);
    let grant_id = new_id(id_prefix::OAUTH_GRANT);
    let jwt_format =
        state.settings.get().oidc_provider.access_token_format == AccessTokenFormat::Jwt;

    let access_token = if jwt_format {
        let mut claims = Map::new();
        claims.insert("sub".into(), Value::String(input.user.id.clone()));
        claims.insert(
            "azp".into(),
            Value::String(input.application.client_id.clone()),
        );
        claims.insert("scope".into(), Value::String(scope.clone()));
        claims.insert("jti".into(), Value::String(grant_id.clone()));
        if let Some(session_id) = session_id {
            claims.insert("sid".into(), Value::String(session_id.to_string()));
        }
        if input.scopes.iter().any(|value| value == "groups") {
            if let Some(groups) = groups_for_user(
                state,
                input.application,
                &input.user.id,
                Some(&authority.organizations),
            )
            .await?
            {
                claims.insert("groups".into(), serde_json::json!(groups));
            }
        }
        if input.scopes.iter().any(|value| value == "organizations") {
            append_org_claims(&mut claims, authority.organizations.clone());
        }
        sign_jwt(
            state,
            &claims,
            SignJwtOptions {
                expires_in_seconds: access_lifetime,
                audience: Some(input.application.client_id.clone()),
                issuer: Some(issuer.clone()),
                kid: None,
            },
        )
        .await?
    } else {
        format!("oat_{}", random_token(32))
    };

    let mut set = TokenSet {
        access_token: access_token.clone(),
        token_type: "Bearer",
        expires_in: access_lifetime,
        scope: scope.clone(),
        refresh_token: None,
        id_token: None,
    };

    let mut refresh = None;
    if input.scopes.iter().any(|value| value == "offline_access") {
        if let Some(existing) = input.reuse_refresh_token {
            set.refresh_token = Some(existing.to_string());
        } else {
            let (refresh_id, refresh_token) = match &input.refresh {
                Some((id, token)) => (id.clone(), token.clone()),
                None => (
                    new_id(id_prefix::OAUTH_GRANT),
                    format!("ort_{}", random_token(32)),
                ),
            };
            refresh = Some(GrantInsert {
                id: refresh_id,
                kind: "refresh",
                application_id: input.application.id.clone(),
                user_id: input.user.id.clone(),
                token_hash: sha256(&refresh_token),
                scopes: scope.clone(),
                redirect_uri: None,
                code_challenge: None,
                code_challenge_method: None,
                nonce: None,
                family_id: Some(input.family.to_string()),
                session_id: session_id.map(str::to_string),
                revoked: false,
                expires_at: now + refresh_lifetime * 1000,
                created_at: now,
            });
            set.refresh_token = Some(refresh_token);
        }
    }

    if input.scopes.iter().any(|value| value == "openid") {
        let claims = build_id_token_claims(
            state,
            super::claims::IdTokenInput {
                user: input.user,
                application: input.application,
                scopes: input.scopes,
                nonce: input.nonce,
                session_id,
                access_token: &access_token,
                organizations: &authority.organizations,
            },
        )
        .await?;
        set.id_token = Some(
            sign_jwt(
                state,
                &claims,
                SignJwtOptions {
                    expires_in_seconds: id_lifetime,
                    audience: Some(input.application.client_id.clone()),
                    issuer: Some(issuer),
                    kid: None,
                },
            )
            .await?,
        );
    }

    Ok(PlannedTokenSet {
        set,
        access: GrantInsert {
            id: grant_id,
            kind: "access",
            application_id: input.application.id.clone(),
            user_id: input.user.id.clone(),
            token_hash: sha256(&access_token),
            scopes: scope,
            redirect_uri: None,
            code_challenge: None,
            code_challenge_method: None,
            nonce: None,
            family_id: Some(input.family.to_string()),
            session_id: session_id.map(str::to_string),
            revoked: false,
            expires_at: now + access_lifetime * 1000,
            created_at: now,
        },
        refresh,
    })
}

/// Persists a planned token set on the given connection (inside the caller's
/// transaction when there is one).
pub async fn insert_planned_token_set(
    conn: &mut PgConnection,
    plan: &PlannedTokenSet,
) -> Result<()> {
    insert_grant(conn, &plan.access).await?;
    if let Some(refresh) = &plan.refresh {
        insert_grant(conn, refresh).await?;
    }
    Ok(())
}

async fn insert_grant(conn: &mut PgConnection, grant: &GrantInsert) -> Result<()> {
    sqlx::query(
        "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, \
         redirect_uri, code_challenge, code_challenge_method, nonce, family_id, session_id, \
         revoked, expires_at, created_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
    )
    .bind(&grant.id)
    .bind(grant.kind)
    .bind(&grant.application_id)
    .bind(&grant.user_id)
    .bind(&grant.token_hash)
    .bind(&grant.scopes)
    .bind(&grant.redirect_uri)
    .bind(&grant.code_challenge)
    .bind(&grant.code_challenge_method)
    .bind(&grant.nonce)
    .bind(&grant.family_id)
    .bind(&grant.session_id)
    .bind(grant.revoked)
    .bind(grant.expires_at)
    .bind(grant.created_at)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

/// Inserts one grant row on a caller-owned connection (consent + code issuance
/// must commit together).
pub async fn insert_grant_on(conn: &mut PgConnection, grant: &GrantInsert) -> Result<()> {
    insert_grant(conn, grant).await
}
