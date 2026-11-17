//! L3 HTTP surface (`fapi-auth`): the browser-facing authentication API.
//!
//! Covers environment, client state, handshake, sign-in/sign-up, social OAuth,
//! verification links and enterprise SSO. Routes use absolute paths; the
//! server merges this router at the root and applies the global middleware.

pub mod client;
pub mod enterprise;
pub mod environment;
pub mod external;
mod external_signin;
pub mod handshake;
pub mod oauth;
pub mod signin;
pub mod signup;
pub mod state;
pub mod util;
pub mod verify_link;

use axum::routing::{get, post};
use axum::Router;
pub use client::guard_session_auth;
use orbitid_core::AppState;

/// Routes for this surface, mounted by `orbitid-server`.
pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/client/environment", get(environment::environment))
        .route("/v1/client", get(client::get).delete(client::delete))
        .route("/v1/client/sessions", get(client::sessions))
        .route("/v1/client/sessions/{id}/touch", post(client::touch))
        .route("/v1/client/sessions/{id}/end", post(client::end_current))
        .route(
            "/v1/client/sessions/{id}/remove",
            post(client::remove_current),
        )
        .route("/v1/client/sessions/{id}/tokens", post(client::tokens))
        .route(
            "/v1/client/sessions/{id}/tokens/{template}",
            post(client::tokens_template),
        )
        .route("/v1/client/sessions/{id}/verify", post(client::verify))
        .route(
            "/v1/client/sessions/{id}/verify/prepare_first_factor",
            post(client::prepare_first_factor),
        )
        .route(
            "/v1/client/sessions/{id}/verify/attempt_first_factor",
            post(client::attempt_first_factor),
        )
        .route(
            "/v1/client/sessions/{id}/verify/prepare_second_factor",
            post(client::prepare_second_factor),
        )
        .route(
            "/v1/client/sessions/{id}/verify/attempt_second_factor",
            post(client::attempt_second_factor),
        )
        .route(
            "/v1/client/sessions/{id}/verification",
            get(client::verification),
        )
        .route("/v1/client/handshake", get(handshake::handshake))
        .route(
            "/v1/oauth_callback/{provider}",
            get(oauth::callback).post(oauth::callback),
        )
        .route("/v1/verify", get(verify_link::verify))
        .route("/v1/client/enterprise/start", get(enterprise::start))
        .route(
            "/v1/client/enterprise/oidc_callback/{id}",
            get(enterprise::oidc_callback),
        )
        .route("/v1/saml/{id}/metadata", get(enterprise::saml_metadata))
        .route("/v1/saml/{id}/sso", get(enterprise::saml_sso))
        .route("/v1/saml/{id}/acs", post(enterprise::saml_acs))
        .merge(signin::router())
        .merge(signup::router())
}
