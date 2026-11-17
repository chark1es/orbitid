use axum::routing::{delete, get, post};
use axum::Router;
use orbitid_core::state::AppState;

use super::settings::{read, update};
use super::test_actions::{delete_social, email_test, social_test, test_email};
use super::tokens::{audit_logs, create_testing_token, rotate_key, stats};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/instance", get(read).patch(update))
        .route("/v1/instance/test_email", post(test_email))
        .route("/v1/instance/email_test", post(email_test))
        .route("/v1/instance/social/test", post(social_test))
        .route("/v1/instance/social/{provider}", delete(delete_social))
        .route("/v1/instance/signing_keys/rotate", post(rotate_key))
        .route("/v1/testing_tokens", post(create_testing_token))
        .route("/v1/audit_logs", get(audit_logs))
        .route("/v1/stats", get(stats))
}
