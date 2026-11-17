//! CAPTCHA verification, including the per-state test verifier seam.

use std::sync::Arc;

use orbitid_core::testing::test_state;
use orbitid_platform::{set_captcha_verifier_for_tests, verify_captcha, CaptchaVerifier};
use serde_json::json;

struct FixedVerifier(bool);

#[async_trait::async_trait]
impl CaptchaVerifier for FixedVerifier {
    async fn verify(&self, _token: &str, _remote_ip: Option<&str>) -> bool {
        self.0
    }
}

async fn configure_captcha(state: &orbitid_core::AppState) {
    state
        .settings
        .update(json!({
            "security": {
                "captchaProvider": "turnstile",
                "captchaSecret": "turnstile-secret",
                "captchaSiteKey": "site-key"
            }
        }))
        .await
        .expect("settings");
}

#[tokio::test]
async fn no_provider_is_a_noop() {
    let ctx = test_state().await;
    verify_captcha(&ctx.state, None, None).await.expect("noop");
    verify_captcha(&ctx.state, Some("anything"), Some("203.0.113.1"))
        .await
        .expect("noop");
}

#[tokio::test]
async fn the_test_verifier_decides_the_outcome() {
    let ctx = test_state().await;
    configure_captcha(&ctx.state).await;

    set_captcha_verifier_for_tests(&ctx.state, Some(Arc::new(FixedVerifier(false))));
    let error = verify_captcha(&ctx.state, Some("token"), Some("203.0.113.1"))
        .await
        .expect_err("rejected");
    assert_eq!(error.code, "bot_detected");
    assert_eq!(error.status, axum::http::StatusCode::BAD_REQUEST);
    assert_eq!(
        error
            .meta
            .as_ref()
            .and_then(|meta| meta["param_name"].as_str()),
        Some("captcha_token")
    );

    set_captcha_verifier_for_tests(&ctx.state, Some(Arc::new(FixedVerifier(true))));
    verify_captcha(&ctx.state, Some("token"), None)
        .await
        .expect("accepted");
}

#[tokio::test]
async fn a_missing_token_fails_closed_without_network() {
    let ctx = test_state().await;
    configure_captcha(&ctx.state).await;
    for token in [None, Some("")] {
        let error = verify_captcha(&ctx.state, token, None)
            .await
            .expect_err("rejected");
        assert_eq!(error.code, "bot_detected");
    }
}

#[tokio::test]
async fn verifiers_are_per_state() {
    let first = test_state().await;
    let second = test_state().await;
    configure_captcha(&first.state).await;
    configure_captcha(&second.state).await;
    set_captcha_verifier_for_tests(&first.state, Some(Arc::new(FixedVerifier(true))));
    set_captcha_verifier_for_tests(&second.state, Some(Arc::new(FixedVerifier(false))));
    verify_captcha(&first.state, Some("token"), None)
        .await
        .expect("first accepts");
    // The second state must use its own verifier, not the first state's.
    verify_captcha(&second.state, Some("token"), None)
        .await
        .expect_err("second rejects");
    set_captcha_verifier_for_tests(&first.state, None);
    set_captcha_verifier_for_tests(&second.state, None);
}
