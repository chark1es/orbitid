//! Server-side CAPTCHA verification (Cloudflare Turnstile / hCaptcha), ported
//! from the retired TypeScript server.

use std::sync::{Arc, RwLock};

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::replay;
use orbitid_core::safe_fetch::{safe_fetch, SafeFetchOptions};
use orbitid_core::settings::types::CaptchaProvider;
use orbitid_core::state::AppState;
use reqwest::header::{HeaderValue, CONTENT_TYPE};

/// Test seam: stub the verification result without network calls. Per-state, so
/// parallel tests never share it.
#[async_trait::async_trait]
pub trait CaptchaVerifier: Send + Sync {
    async fn verify(&self, token: &str, remote_ip: Option<&str>) -> bool;
}

/// Per-`AppState` holder for the verifier override.
#[derive(Clone, Default)]
pub struct CaptchaService {
    verifier: Arc<RwLock<Option<Arc<dyn CaptchaVerifier>>>>,
}

impl CaptchaService {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn set_verifier(&self, verifier: Option<Arc<dyn CaptchaVerifier>>) {
        if let Ok(mut slot) = self.verifier.write() {
            *slot = verifier;
        }
    }

    fn verifier(&self) -> Option<Arc<dyn CaptchaVerifier>> {
        self.verifier.read().ok().and_then(|slot| slot.clone())
    }
}

/// The captcha service attached to `state`, installing one on first use.
pub fn captcha_service(state: &AppState) -> Arc<CaptchaService> {
    state
        .extensions
        .get_or_insert::<CaptchaService>(CaptchaService::new)
}

/// Installs a verifier override for tests (`None` restores the real provider).
pub fn set_captcha_verifier_for_tests(
    state: &AppState,
    verifier: Option<Arc<dyn CaptchaVerifier>>,
) {
    captcha_service(state).set_verifier(verifier);
}

fn bot_detected() -> OrbitError {
    OrbitError::bad_request(
        error_codes::BOT_DETECTED,
        "Bot traffic detected. Please try again.",
    )
    .with_meta(serde_json::json!({ "param_name": "captcha_token" }))
}

/// Verifies the token supplied as body `captcha_token` or header
/// `X-Captcha-Token`. No-op when no provider (or secret) is configured.
pub async fn verify_captcha(
    state: &AppState,
    token: Option<&str>,
    remote_ip: Option<&str>,
) -> orbitid_core::Result<()> {
    let security = state.settings.get().security.clone();
    if security.captcha_provider == CaptchaProvider::None || security.captcha_secret.is_empty() {
        return Ok(());
    }
    let token = token.filter(|value| !value.is_empty());
    // A single-use token that already succeeded earlier in this request (before
    // a retryable transaction conflict replayed the handler) must not be
    // submitted to the provider again: it would answer "duplicate" and turn a
    // valid request into `bot_detected`. The memo is request-private and lives
    // only for the duration of the request.
    if let Some(token) = token {
        if replay::captcha_already_verified(token) {
            return Ok(());
        }
    }
    if let Some(verifier) = captcha_service(state).verifier() {
        if verifier.verify(token.unwrap_or(""), remote_ip).await {
            if let Some(token) = token {
                replay::remember_captcha_success(token);
            }
            return Ok(());
        }
        return Err(bot_detected());
    }
    let Some(token) = token else {
        return Err(bot_detected());
    };
    let endpoint = match security.captcha_provider {
        CaptchaProvider::Turnstile => "https://challenges.cloudflare.com/turnstile/v0/siteverify",
        CaptchaProvider::Hcaptcha => "https://api.hcaptcha.com/siteverify",
        CaptchaProvider::None => return Ok(()),
    };
    // Build the owned body in a block so the borrowed serializer is dropped
    // before the `.await`: a `Serializer` alive across an await makes the future
    // `!Send`, and then no axum handler can await it.
    let body = {
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("secret", &security.captcha_secret)
            .append_pair("response", token);
        if let Some(remote_ip) = remote_ip {
            form.append_pair("remoteip", remote_ip);
        }
        form.finish().into_bytes()
    };
    let mut headers = reqwest::header::HeaderMap::new();
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    let response = safe_fetch(
        Some(state),
        endpoint,
        SafeFetchOptions {
            method: Some("POST".to_string()),
            headers,
            body: Some(body),
            timeout_ms: Some(5_000),
            max_redirects: None,
            max_bytes: Some(64 * 1024),
        },
    )
    .await;
    // Provider unreachable: fail closed (bot protection is an explicit opt-in).
    let Ok(response) = response else {
        return Err(bot_detected());
    };
    let parsed: Result<serde_json::Value, _> = serde_json::from_str(&response.body);
    match parsed {
        Ok(value) if value.get("success").and_then(serde_json::Value::as_bool) == Some(true) => {
            replay::remember_captcha_success(token);
            Ok(())
        }
        _ => Err(bot_detected()),
    }
}

#[allow(dead_code)]
fn assert_future_send(state: &AppState) {
    fn assert_send<T: Send>(_: T) {}
    assert_send(verify_captcha(state, None, None));
}
