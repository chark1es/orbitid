//! `/v1/client/sign_ups`. Ported from `modules/sign-up.ts`.

pub mod core;
pub mod helpers;
pub mod routes;
pub mod verification;

use axum::routing::{get, post};
use axum::Router;
use orbitid_core::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/client/sign_ups", post(routes::create))
        .route(
            "/v1/client/sign_ups/{id}",
            get(routes::read).patch(routes::patch),
        )
        .route(
            "/v1/client/sign_ups/{id}/prepare_verification",
            post(verification::prepare),
        )
        .route(
            "/v1/client/sign_ups/{id}/attempt_verification",
            post(verification::attempt),
        )
}
