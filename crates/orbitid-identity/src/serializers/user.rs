//! User, identification and trusted-device serializers.

use std::collections::HashMap;

use orbitid_core::error::Result;
use orbitid_core::http::now;
use orbitid_core::models::{
    EmailAddressRow, ExternalAccountRow, PasskeyRow, PhoneNumberRow, TrustedDeviceRow, UserRow,
};
use orbitid_core::resources::{
    EmailAddressJson, ExternalAccountJson, PasskeyJson, PhoneNumberJson, TrustedDeviceJson,
    UserJson,
};
use orbitid_core::state::AppState;
use orbitid_platform::default_avatar;

use super::{unverified, verified};
use crate::user_roles::{role_claims_for_user, role_claims_for_users};

#[derive(Debug, Clone, Copy, Default)]
pub struct UserSerializeOptions {
    /// Include `private_metadata` (Backend API only).
    pub backend: bool,
}

/// `user.first_name last_name` (or username/email/id), used for the avatar seed.
pub(crate) fn display_name(user: &UserRow, primary_email: Option<&str>) -> String {
    let name = [user.first_name.as_deref(), user.last_name.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    if !name.is_empty() {
        return name;
    }
    if let Some(username) = &user.username {
        return username.clone();
    }
    if let Some(email) = primary_email {
        return email.to_string();
    }
    user.id.clone()
}

pub fn serialize_email(row: &EmailAddressRow) -> EmailAddressJson {
    let verification = if row.verified {
        verified(
            row.verified_strategy
                .clone()
                .unwrap_or_else(|| "email_code".into()),
        )
    } else {
        unverified("email_code")
    };
    EmailAddressJson {
        object: "email_address".into(),
        id: row.id.clone(),
        email_address: row.email.clone(),
        verification: Some(verification),
        linked_to: Vec::new(),
        reserved: row.reserved,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub fn serialize_phone(row: &PhoneNumberRow) -> PhoneNumberJson {
    let verification = if row.verified {
        verified("phone_code")
    } else {
        unverified("phone_code")
    };
    PhoneNumberJson {
        object: "phone_number".into(),
        id: row.id.clone(),
        phone_number: row.phone.clone(),
        reserved_for_second_factor: row.reserved_for_second_factor,
        default_second_factor: row.default_second_factor,
        verification: Some(verification),
        linked_to: Vec::new(),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub fn serialize_external_account(row: &ExternalAccountRow) -> ExternalAccountJson {
    ExternalAccountJson {
        object: "external_account".into(),
        id: row.id.clone(),
        provider: row.provider.clone(),
        provider_user_id: row.provider_user_id.clone(),
        identification_id: row.id.clone(),
        email_address: row.email_address.clone(),
        first_name: row.first_name.clone(),
        last_name: row.last_name.clone(),
        username: row.username.clone(),
        image_url: row.image_url.clone(),
        avatar_url: row.image_url.clone(),
        approved_scopes: row.approved_scopes.clone(),
        public_metadata: row.public_metadata.0.clone(),
        label: None,
        verification: Some(verified(format!("from_oauth_{}", row.provider))),
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

pub fn serialize_passkey(row: &PasskeyRow) -> PasskeyJson {
    PasskeyJson {
        object: "passkey".into(),
        id: row.id.clone(),
        name: row.name.clone(),
        verification: Some(verified("passkey")),
        last_used_at: row.last_used_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// A remembered browser. The token hash is never exposed, and neither is the
/// token itself.
pub fn serialize_trusted_device(row: &TrustedDeviceRow) -> TrustedDeviceJson {
    TrustedDeviceJson {
        object: "trusted_device".into(),
        id: row.id.clone(),
        user_id: row.user_id.clone(),
        label: row.label.clone(),
        user_agent: row.user_agent.clone(),
        ip_address: row.ip_address.clone(),
        expires_at: row.expires_at,
        last_used_at: row.last_used_at,
        revoked_at: row.revoked_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    }
}

/// Everything `serialize_user` needs from the other tables.
#[derive(Clone)]
pub(crate) struct UserRelations {
    pub emails: Vec<EmailAddressRow>,
    pub phones: Vec<PhoneNumberRow>,
    pub externals: Vec<ExternalAccountRow>,
    pub passkeys: Vec<PasskeyRow>,
}

impl UserRelations {
    fn primary_email(&self, user: &UserRow) -> Option<&EmailAddressRow> {
        user.primary_email_address_id
            .as_ref()
            .and_then(|id| self.emails.iter().find(|row| &row.id == id))
            .or_else(|| self.emails.first())
    }
}

pub(crate) async fn load_user_relations(state: &AppState, user: &UserRow) -> Result<UserRelations> {
    let emails =
        sqlx::query_as::<_, EmailAddressRow>("SELECT * FROM email_addresses WHERE user_id = $1")
            .bind(&user.id)
            .fetch_all(&state.pool)
            .await?;
    let phones =
        sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE user_id = $1")
            .bind(&user.id)
            .fetch_all(&state.pool)
            .await?;
    let externals = sqlx::query_as::<_, ExternalAccountRow>(
        "SELECT * FROM external_accounts WHERE user_id = $1",
    )
    .bind(&user.id)
    .fetch_all(&state.pool)
    .await?;
    let passkeys = sqlx::query_as::<_, PasskeyRow>("SELECT * FROM passkeys WHERE user_id = $1")
        .bind(&user.id)
        .fetch_all(&state.pool)
        .await?;
    Ok(UserRelations {
        emails,
        phones,
        externals,
        passkeys,
    })
}

/// [`load_user_relations`] on a caller-owned connection. Webhook payloads are
/// serialized inside the same transaction as the change they announce, so this
/// must never touch the pool.
pub(crate) async fn load_user_relations_on(
    conn: &mut sqlx::PgConnection,
    user: &UserRow,
) -> Result<UserRelations> {
    let emails =
        sqlx::query_as::<_, EmailAddressRow>("SELECT * FROM email_addresses WHERE user_id = $1")
            .bind(&user.id)
            .fetch_all(&mut *conn)
            .await?;
    let phones =
        sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE user_id = $1")
            .bind(&user.id)
            .fetch_all(&mut *conn)
            .await?;
    let externals = sqlx::query_as::<_, ExternalAccountRow>(
        "SELECT * FROM external_accounts WHERE user_id = $1",
    )
    .bind(&user.id)
    .fetch_all(&mut *conn)
    .await?;
    let passkeys = sqlx::query_as::<_, PasskeyRow>("SELECT * FROM passkeys WHERE user_id = $1")
        .bind(&user.id)
        .fetch_all(&mut *conn)
        .await?;
    Ok(UserRelations {
        emails,
        phones,
        externals,
        passkeys,
    })
}

/// Batch-load relations for many users with four queries (list endpoints).
pub(crate) async fn load_relations_for_users(
    state: &AppState,
    user_ids: &[String],
) -> Result<HashMap<String, UserRelations>> {
    let mut map: HashMap<String, UserRelations> = user_ids
        .iter()
        .map(|id| {
            (
                id.clone(),
                UserRelations {
                    emails: Vec::new(),
                    phones: Vec::new(),
                    externals: Vec::new(),
                    passkeys: Vec::new(),
                },
            )
        })
        .collect();
    if user_ids.is_empty() {
        return Ok(map);
    }
    let emails = sqlx::query_as::<_, EmailAddressRow>(
        "SELECT * FROM email_addresses WHERE user_id = ANY($1)",
    )
    .bind(user_ids)
    .fetch_all(&state.pool)
    .await?;
    for row in emails {
        if let Some(user_id) = &row.user_id {
            if let Some(entry) = map.get_mut(user_id) {
                entry.emails.push(row);
            }
        }
    }
    let phones =
        sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE user_id = ANY($1)")
            .bind(user_ids)
            .fetch_all(&state.pool)
            .await?;
    for row in phones {
        if let Some(user_id) = &row.user_id {
            if let Some(entry) = map.get_mut(user_id) {
                entry.phones.push(row);
            }
        }
    }
    let externals = sqlx::query_as::<_, ExternalAccountRow>(
        "SELECT * FROM external_accounts WHERE user_id = ANY($1)",
    )
    .bind(user_ids)
    .fetch_all(&state.pool)
    .await?;
    for row in externals {
        if let Some(user_id) = &row.user_id {
            if let Some(entry) = map.get_mut(user_id) {
                entry.externals.push(row);
            }
        }
    }
    let passkeys =
        sqlx::query_as::<_, PasskeyRow>("SELECT * FROM passkeys WHERE user_id = ANY($1)")
            .bind(user_ids)
            .fetch_all(&state.pool)
            .await?;
    for row in passkeys {
        if let Some(entry) = map.get_mut(&row.user_id) {
            entry.passkeys.push(row);
        }
    }
    Ok(map)
}

pub(crate) fn user_json(
    state: &AppState,
    user: &UserRow,
    relations: &UserRelations,
    roles: Vec<String>,
    permissions: Vec<String>,
    opts: UserSerializeOptions,
) -> UserJson {
    let settings = state.settings.get();
    let now_ms = now();
    let locked_now = user.locked
        && user
            .lockout_expires_at
            .map(|expires| expires > now_ms)
            .unwrap_or(true);
    let primary_email = relations.primary_email(user);
    let name = display_name(user, primary_email.map(|row| row.email.as_str()));
    let two_factor_enabled = user.totp_verified
        || relations
            .phones
            .iter()
            .any(|phone| phone.reserved_for_second_factor && phone.verified);
    let lockout_expires_in_seconds = if locked_now {
        user.lockout_expires_at
            .map(|expires| ((expires - now_ms) as f64 / 1000.0).ceil() as i64)
    } else {
        None
    };
    UserJson {
        object: "user".into(),
        id: user.id.clone(),
        external_id: user.external_id.clone(),
        username: user.username.clone(),
        first_name: user.first_name.clone(),
        last_name: user.last_name.clone(),
        image_url: user
            .image_url
            .clone()
            .unwrap_or_else(|| default_avatar(&name)),
        has_image: user.has_image,
        primary_email_address_id: user.primary_email_address_id.clone(),
        primary_phone_number_id: user.primary_phone_number_id.clone(),
        password_enabled: user.password_hash.is_some(),
        totp_enabled: user.totp_verified,
        backup_code_enabled: user
            .backup_codes
            .as_ref()
            .map(|codes| !codes.0.is_empty())
            .unwrap_or(false),
        two_factor_enabled,
        passkeys: relations.passkeys.iter().map(serialize_passkey).collect(),
        email_addresses: relations.emails.iter().map(serialize_email).collect(),
        phone_numbers: relations.phones.iter().map(serialize_phone).collect(),
        external_accounts: relations
            .externals
            .iter()
            .map(serialize_external_account)
            .collect(),
        public_metadata: user.public_metadata.0.clone(),
        unsafe_metadata: user.unsafe_metadata.0.clone(),
        private_metadata: opts.backend.then(|| user.private_metadata.0.clone()),
        is_anonymous: user.is_anonymous,
        banned: user.banned,
        locked: locked_now,
        lockout_expires_in_seconds,
        verification_attempts_remaining: Some(
            (settings.mfa.max_attempts - user.failed_attempts).max(0),
        ),
        delete_self_enabled: user.delete_self_enabled,
        create_organization_enabled: user.create_organization_enabled,
        create_organizations_limit: user.create_organizations_limit,
        roles,
        role_permissions: permissions,
        last_sign_in_at: user.last_sign_in_at,
        last_active_at: user.last_active_at,
        legal_accepted_at: user.legal_accepted_at,
        created_at: user.created_at,
        updated_at: user.updated_at,
    }
}

/// Wire representation of a user including identifications and instance roles.
pub async fn serialize_user(
    state: &AppState,
    user: &UserRow,
    opts: UserSerializeOptions,
) -> Result<UserJson> {
    let relations = load_user_relations(state, user).await?;
    let claims = role_claims_for_user(state, &user.id).await?;
    Ok(user_json(
        state,
        user,
        &relations,
        claims.roles,
        claims.permissions,
        opts,
    ))
}

/// [`serialize_user`] on a caller-owned connection, for transactional webhook
/// payloads. No query in this path may acquire a pool connection.
pub async fn serialize_user_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    user: &UserRow,
    opts: UserSerializeOptions,
) -> Result<UserJson> {
    let relations = load_user_relations_on(conn, user).await?;
    let claims = crate::user_roles::role_claims_for_user_on(conn, &user.id).await?;
    Ok(user_json(
        state,
        user,
        &relations,
        claims.roles,
        claims.permissions,
        opts,
    ))
}

/// Batch serializer for list endpoints: four relation queries plus the two
/// role-claim queries, regardless of the number of users.
pub async fn serialize_users(
    state: &AppState,
    users: &[UserRow],
    opts: UserSerializeOptions,
) -> Result<Vec<UserJson>> {
    let ids: Vec<String> = users.iter().map(|user| user.id.clone()).collect();
    let mut relations = load_relations_for_users(state, &ids).await?;
    let mut claims = role_claims_for_users(state, &ids).await?;
    let mut out = Vec::with_capacity(users.len());
    for user in users {
        let entry = relations.remove(&user.id).unwrap_or(UserRelations {
            emails: Vec::new(),
            phones: Vec::new(),
            externals: Vec::new(),
            passkeys: Vec::new(),
        });
        let claims = claims.remove(&user.id).unwrap_or_default();
        out.push(user_json(
            state,
            user,
            &entry,
            claims.roles,
            claims.permissions,
            opts,
        ));
    }
    Ok(out)
}

pub(crate) fn public_user_data_for(
    user: &UserRow,
    relations: &UserRelations,
) -> orbitid_core::resources::PublicUserData {
    let primary_email = relations.primary_email(user);
    let name = display_name(user, primary_email.map(|row| row.email.as_str()));
    orbitid_core::resources::PublicUserData {
        user_id: user.id.clone(),
        first_name: user.first_name.clone(),
        last_name: user.last_name.clone(),
        image_url: user
            .image_url
            .clone()
            .unwrap_or_else(|| default_avatar(&name)),
        has_image: user.has_image,
        identifier: primary_email
            .map(|row| row.email.clone())
            .or_else(|| user.username.clone())
            .unwrap_or_default(),
    }
}
