//! Email-address and phone-number routes (`modules/me/identifiers.ts`).
//!
//! Handlers live in [`email`] and [`phone`]; this module keeps the ownership
//! lookups they share and re-exports the handlers so the router is unchanged.

pub mod email;
pub mod phone;

pub use email::*;
pub use phone::*;

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{EmailAddressRow, PhoneNumberRow};
use orbitid_core::state::AppState;

async fn load_email(state: &AppState, id: &str) -> Result<EmailAddressRow> {
    sqlx::query_as::<_, EmailAddressRow>("SELECT * FROM email_addresses WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| OrbitError::internal("email address disappeared"))
}

async fn load_phone(state: &AppState, id: &str) -> Result<PhoneNumberRow> {
    sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| OrbitError::internal("phone number disappeared"))
}

async fn load_phone_on(conn: &mut sqlx::PgConnection, id: &str) -> Result<PhoneNumberRow> {
    sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| OrbitError::internal("phone number disappeared"))
}

async fn owner_email(state: &AppState, id: &str, user_id: &str) -> Result<EmailAddressRow> {
    sqlx::query_as::<_, EmailAddressRow>(
        "SELECT * FROM email_addresses WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Email address not found")
    })
}

async fn owner_phone_on(
    conn: &mut sqlx::PgConnection,
    id: &str,
    user_id: &str,
) -> Result<PhoneNumberRow> {
    sqlx::query_as::<_, PhoneNumberRow>(
        "SELECT * FROM phone_numbers WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?
    .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Phone number not found"))
}

async fn owner_phone(state: &AppState, id: &str, user_id: &str) -> Result<PhoneNumberRow> {
    sqlx::query_as::<_, PhoneNumberRow>(
        "SELECT * FROM phone_numbers WHERE id = $1 AND user_id = $2",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Phone number not found"))
}
