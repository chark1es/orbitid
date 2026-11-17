//! Shared fixtures for the credentials integration tests.

#![allow(dead_code)]

use orbitid_core::http::now;
use orbitid_core::keys::SESSION_NEVER_EXPIRES_AT;
use orbitid_core::models::UserRow;
use orbitid_core::resources::{
    EmailAddressJson, PasskeyJson, PhoneNumberJson, UserJson, VerificationJson, VerificationStatus,
};
use serde_json::json;
use sqlx::PgPool;

pub async fn insert_user(pool: &PgPool, id: &str, email: &str) -> UserRow {
    let timestamp = now();
    let email_id = format!("idn_e_{id}");
    sqlx::query(
        "INSERT INTO users (id, username, first_name, last_name, \
         public_metadata, private_metadata, unsafe_metadata, created_at, updated_at) \
         VALUES ($1, $2, 'Ada', 'Lovelace', $3, '{}', '{}', $4, $4)",
    )
    .bind(id)
    .bind(id.replace("user_", "ada"))
    .bind(sqlx::types::Json(
        json!({"tier": "pro", "team": {"name": "core"}}),
    ))
    .bind(timestamp)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO email_addresses (id, user_id, email, verified, verified_at, verified_strategy, reserved, created_at, updated_at) \
         VALUES ($1, $2, $3, true, $4, 'email_code', false, $4, $4)",
    )
    .bind(&email_id)
    .bind(id)
    .bind(email)
    .bind(timestamp)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query("UPDATE users SET primary_email_address_id = $1 WHERE id = $2")
        .bind(&email_id)
        .bind(id)
        .execute(pool)
        .await
        .unwrap();
    user_row(pool, id).await
}

pub async fn user_row(pool: &PgPool, id: &str) -> UserRow {
    sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(id)
        .fetch_one(pool)
        .await
        .unwrap()
}

pub async fn insert_session(pool: &PgPool, id: &str, user_id: &str) -> String {
    let timestamp = now();
    sqlx::query(
        "INSERT INTO clients (id, token_hash, created_at, updated_at) \
         VALUES ('client_test', 'client-test-hash', $1, $1) ON CONFLICT DO NOTHING",
    )
    .bind(timestamp)
    .execute(pool)
    .await
    .unwrap();
    sqlx::query(
        "INSERT INTO sessions (id, client_id, user_id, status, last_active_at, expire_at, abandon_at, \
         first_factor_verified_at, created_at, updated_at) \
         VALUES ($1, 'client_test', $2, 'active', $3, $4, $5, $3, $3, $3)",
    )
    .bind(id)
    .bind(user_id)
    .bind(timestamp)
    .bind(SESSION_NEVER_EXPIRES_AT)
    .bind(timestamp + 86_400_000)
    .execute(pool)
    .await
    .unwrap();
    id.to_string()
}

pub fn verified(strategy: &str) -> Option<VerificationJson> {
    Some(VerificationJson {
        status: VerificationStatus::Verified,
        strategy: strategy.into(),
        attempts: None,
        expire_at: None,
        external_verification_redirect_url: None,
        error: None,
        nonce: None,
    })
}

pub fn user_json(user: &UserRow) -> UserJson {
    let email = EmailAddressJson {
        object: "email_address".into(),
        id: user.primary_email_address_id.clone().unwrap_or_default(),
        email_address: "ada@example.com".into(),
        verification: verified("email_code"),
        linked_to: Vec::new(),
        reserved: false,
        created_at: user.created_at,
        updated_at: user.updated_at,
    };
    UserJson {
        object: "user".into(),
        id: user.id.clone(),
        external_id: None,
        username: user.username.clone(),
        first_name: user.first_name.clone(),
        last_name: user.last_name.clone(),
        image_url: "data:image/svg+xml;utf8,x".into(),
        has_image: false,
        primary_email_address_id: user.primary_email_address_id.clone(),
        primary_phone_number_id: None,
        password_enabled: false,
        totp_enabled: false,
        backup_code_enabled: false,
        two_factor_enabled: false,
        passkeys: Vec::<PasskeyJson>::new(),
        email_addresses: vec![email],
        phone_numbers: Vec::<PhoneNumberJson>::new(),
        external_accounts: Vec::new(),
        public_metadata: user.public_metadata.0.clone(),
        unsafe_metadata: user.unsafe_metadata.0.clone(),
        private_metadata: None,
        is_anonymous: false,
        banned: false,
        locked: false,
        lockout_expires_in_seconds: None,
        verification_attempts_remaining: Some(100),
        delete_self_enabled: true,
        create_organization_enabled: true,
        create_organizations_limit: None,
        roles: Vec::new(),
        role_permissions: Vec::new(),
        last_sign_in_at: None,
        last_active_at: None,
        legal_accepted_at: None,
        created_at: user.created_at,
        updated_at: user.updated_at,
    }
}

pub async fn insert_verified_phone(
    pool: &PgPool,
    id: &str,
    user_id: &str,
    phone: &str,
    second_factor: bool,
) {
    let timestamp = now();
    sqlx::query(
        "INSERT INTO phone_numbers (id, user_id, phone, verified, verified_at, reserved_for_second_factor, \
         default_second_factor, created_at, updated_at) \
         VALUES ($1, $2, $3, true, $4, $5, false, $4, $4)",
    )
    .bind(id)
    .bind(user_id)
    .bind(phone)
    .bind(timestamp)
    .bind(second_factor)
    .execute(pool)
    .await
    .unwrap();
}
