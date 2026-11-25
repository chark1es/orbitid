//! Sign-in routes: identifier resolution, first and second factors, and
//! password reset. Ported from `modules/sign-in.ts` and `modules/sign-in/*`.

pub mod complete;
pub mod core;
pub mod creation;
pub mod decoy;
pub mod first_attempt;
pub mod first_prepare;
pub mod helpers;
pub mod recovery;
pub mod reset;
pub mod second_factor;
pub mod second_factor_attempt;
pub mod shared;

use axum::routing::{get, post};
use axum::Router;
use orbitid_core::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/client/sign_ins", post(creation::create))
        .route("/v1/client/sign_ins/{id}", get(creation::read))
        .route(
            "/v1/client/sign_ins/{id}/prepare_first_factor",
            post(first_prepare::prepare),
        )
        .route(
            "/v1/client/sign_ins/{id}/attempt_first_factor",
            post(first_attempt::attempt),
        )
        .route(
            "/v1/client/sign_ins/{id}/reset_password",
            post(reset::reset_password),
        )
        .route(
            "/v1/client/sign_ins/{id}/prepare_second_factor",
            post(second_factor::prepare),
        )
        .route(
            "/v1/client/sign_ins/{id}/attempt_second_factor",
            post(second_factor_attempt::attempt),
        )
}
