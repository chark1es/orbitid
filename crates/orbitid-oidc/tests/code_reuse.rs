//! Authorization-code reuse detection (RFC 6749 §4.1.2, OIDC Core 3.1.3.2):
//! presenting a consumed code revokes every token the first exchange issued,
//! and a concurrent double exchange has exactly one winner.

mod common;

use axum::http::StatusCode;

use common::{
    challenge_for, code_flow, harness, insert_user, pkce_verifier, CodeFlow, REDIRECT_URI,
};
use orbitid_core::models::OauthGrantRow;
use orbitid_oidc::services::oidc::tokens::{
    exchange_authorization_code, issue_authorization_code, CodeExchangeInput, IssueCodeInput,
};

fn token_form<'a>(
    code: &'a str,
    verifier: &'a str,
    client_id: &'a str,
    secret: &'a str,
) -> [(&'a str, &'a str); 6] {
    [
        ("grant_type", "authorization_code"),
        ("code", code),
        ("redirect_uri", REDIRECT_URI),
        ("code_verifier", verifier),
        ("client_id", client_id),
        ("client_secret", secret),
    ]
}

#[tokio::test]
async fn replaying_a_code_revokes_the_tokens_issued_from_it() {
    let h = harness().await;
    let browser = insert_user(&h, "code-reuse@example.com").await;
    let application = h.create_app(serde_json::json!({ "name": "Reuse" })).await;
    let client_id = application["client_id"].as_str().expect("client id");
    let secret = application["client_secret"]
        .as_str()
        .expect("client secret");

    // The test helper runs `/oauth/authorize` with its own PKCE verifier; issue
    // the code directly so this test can replay it with the same verifier.
    let verifier = pkce_verifier();
    let challenge = challenge_for(&verifier);
    let query = common::authorize(
        &h,
        &browser,
        &[
            ("client_id", client_id),
            ("redirect_uri", REDIRECT_URI),
            ("response_type", "code"),
            ("scope", "openid offline_access"),
            ("state", "state-123"),
            ("nonce", "nonce-123"),
            ("code_challenge", &challenge),
            ("code_challenge_method", "S256"),
        ],
    )
    .await;
    let code = query.get("code").cloned().expect("authorize issued a code");

    let first = h
        .form(
            "/oauth/token",
            &token_form(&code, &verifier, client_id, secret),
        )
        .await;
    assert_eq!(first.status, StatusCode::OK, "{}", first.text());
    let access = first.value()["access_token"]
        .as_str()
        .expect("access token")
        .to_string();
    let refresh = first.value()["refresh_token"]
        .as_str()
        .expect("refresh token")
        .to_string();

    // The tokens work.
    let userinfo = h
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access}"))],
        )
        .await;
    assert_eq!(userinfo.status, StatusCode::OK, "{}", userinfo.text());

    // The same code, presented again.
    let replay = h
        .form(
            "/oauth/token",
            &token_form(&code, &verifier, client_id, secret),
        )
        .await;
    assert_eq!(replay.status, StatusCode::BAD_REQUEST, "{}", replay.text());
    assert_eq!(replay.value()["error"], "invalid_grant");

    // RFC 6749 §4.1.2: the tokens from the first exchange stop working.
    let userinfo = h
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access}"))],
        )
        .await;
    assert_eq!(
        userinfo.status,
        StatusCode::UNAUTHORIZED,
        "a revoked access token must not read userinfo: {}",
        userinfo.text()
    );

    let refresh_response = h
        .form(
            "/oauth/token",
            &[
                ("grant_type", "refresh_token"),
                ("refresh_token", &refresh),
                ("client_id", client_id),
                ("client_secret", secret),
            ],
        )
        .await;
    assert_eq!(
        refresh_response.status,
        StatusCode::BAD_REQUEST,
        "{}",
        refresh_response.text()
    );
    assert_eq!(refresh_response.value()["error"], "invalid_grant");

    let rows =
        sqlx::query_as::<_, OauthGrantRow>("SELECT * FROM oauth_grants WHERE application_id = $1")
            .bind(application["id"].as_str().expect("application id"))
            .fetch_all(&h.state().pool)
            .await
            .expect("grants");
    assert!(
        rows.iter()
            .filter(|row| row.kind == "access" || row.kind == "refresh")
            .all(|row| row.revoked),
        "every token issued from the reused code must be revoked"
    );
}

#[tokio::test]
async fn a_code_issued_then_exchanged_still_works_without_a_replay() {
    let h = harness().await;
    let browser = insert_user(&h, "code-once@example.com").await;
    let application = h
        .create_app(serde_json::json!({ "name": "Single use" }))
        .await;
    let flow: CodeFlow = code_flow(&h, &browser, &application, "openid offline_access").await;
    let access = flow.tokens["access_token"].as_str().expect("access token");
    let userinfo = h
        .client
        .get(
            "/oauth/userinfo",
            &[("authorization", &format!("Bearer {access}"))],
        )
        .await;
    assert_eq!(userinfo.status, StatusCode::OK, "{}", userinfo.text());
}

#[tokio::test]
async fn concurrent_double_exchange_has_exactly_one_success() {
    let h = harness().await;
    let browser = insert_user(&h, "code-race@example.com").await;
    let application = h.create_app(serde_json::json!({ "name": "Race" })).await;
    let scopes = vec!["openid".to_string(), "offline_access".to_string()];
    let code = {
        let id = application["id"].as_str().expect("application id");
        let row = orbitid_oidc::services::oidc::applications::get_application(h.state(), id)
            .await
            .expect("load application")
            .expect("application exists");
        issue_authorization_code(
            h.state(),
            IssueCodeInput {
                application: &row,
                user_id: &browser.user.id,
                scopes: &scopes,
                redirect_uri: REDIRECT_URI,
                code_challenge: None,
                code_challenge_method: None,
                nonce: None,
                session_id: Some(&browser.session_id),
            },
        )
        .await
        .expect("issue code")
    };
    let app_row = orbitid_oidc::services::oidc::applications::get_application(
        h.state(),
        application["id"].as_str().expect("application id"),
    )
    .await
    .expect("load application")
    .expect("application exists");

    let exchange = |code: String| {
        let state = h.state().clone();
        let app = app_row.clone();
        async move {
            exchange_authorization_code(
                &state,
                CodeExchangeInput {
                    application: &app,
                    code: &code,
                    redirect_uri: Some(REDIRECT_URI),
                    code_verifier: None,
                    issuer: None,
                },
            )
            .await
        }
    };
    let (first, second) = tokio::join!(exchange(code.clone()), exchange(code.clone()));

    let successes = [&first, &second]
        .iter()
        .filter(|result| result.is_ok())
        .count();
    assert_eq!(successes, 1, "exactly one exchange must win the code");
    let loser = if first.is_err() { &first } else { &second };
    assert_eq!(
        loser.as_ref().err().map(|error| error.error.as_str()),
        Some("invalid_grant")
    );
}
