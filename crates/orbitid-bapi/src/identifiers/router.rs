use axum::routing::{delete, get};
use axum::Router;
use orbitid_core::state::AppState;

use super::emails::{
    create_email, create_phone, delete_email, delete_phone, list_emails, list_phones, patch_email,
    patch_phone, read_email, read_phone,
};
use super::lists::{
    create_allowlist, create_blocklist, delete_allowlist, delete_blocklist, list_allowlist,
    list_blocklist,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/email_addresses", get(list_emails).post(create_email))
        .route(
            "/v1/email_addresses/{id}",
            get(read_email).patch(patch_email).delete(delete_email),
        )
        .route("/v1/phone_numbers", get(list_phones).post(create_phone))
        .route(
            "/v1/phone_numbers/{id}",
            get(read_phone).patch(patch_phone).delete(delete_phone),
        )
        .route(
            "/v1/allowlist_identifiers",
            get(list_allowlist).post(create_allowlist),
        )
        .route("/v1/allowlist_identifiers/{id}", delete(delete_allowlist))
        .route(
            "/v1/blocklist_identifiers",
            get(list_blocklist).post(create_blocklist),
        )
        .route("/v1/blocklist_identifiers/{id}", delete(delete_blocklist))
}

// ───────────── email addresses ─────────────
