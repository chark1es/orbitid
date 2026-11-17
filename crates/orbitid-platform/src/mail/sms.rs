//! SMS delivery (Twilio REST or an operator webhook), ported from
//! the retired TypeScript server. Like email there is no console or
//! file fallback: without a provider the message is not delivered.

use base64::Engine;
use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::safe_fetch::{safe_fetch, SafeFetchOptions};
use orbitid_core::settings::types::SmsProvider;
use orbitid_core::state::AppState;
use reqwest::header::{HeaderMap, HeaderValue, AUTHORIZATION, CONTENT_TYPE};

use crate::audit::{audit, AuditInput};
use crate::js::encode_uri_component;

use super::core::{now_ms, EmailDeliveryResult, SentSms};
use super::outbox::{mailer, record_sms, sms_override};

const SMS_TIMEOUT_MS: u64 = 10_000;
const SMS_MAX_BYTES: usize = 64 * 1024;

enum SmsFailure {
    /// A typed server error: its code and message reach the caller.
    Orbit(OrbitError),
    /// A transport failure: the TypeScript version threw a plain `Error`, so the
    /// caller only sees the generic code and message.
    Transport,
}

impl From<OrbitError> for SmsFailure {
    fn from(error: OrbitError) -> Self {
        Self::Orbit(error)
    }
}

fn not_configured(what: &str) -> OrbitError {
    OrbitError::new(
        axum::http::StatusCode::INTERNAL_SERVER_ERROR,
        error_codes::REQUEST_BODY_INVALID,
        what,
    )
}

async fn send_via_twilio(state: &AppState, to: &str, body: &str) -> Result<(), SmsFailure> {
    let sms = state.settings.get().sms.clone();
    if sms.twilio_account_sid.is_empty()
        || sms.twilio_auth_token.is_empty()
        || sms.twilio_from.is_empty()
    {
        return Err(SmsFailure::Orbit(not_configured(
            "Twilio SMS is not configured",
        )));
    }
    let url = format!(
        "https://api.twilio.com/2010-04-01/Accounts/{}/Messages.json",
        encode_uri_component(&sms.twilio_account_sid)
    );
    let credentials = base64::engine::general_purpose::STANDARD.encode(format!(
        "{}:{}",
        sms.twilio_account_sid, sms.twilio_auth_token
    ));
    let form = url::form_urlencoded::Serializer::new(String::new())
        .append_pair("To", to)
        .append_pair("From", &sms.twilio_from)
        .append_pair("Body", body)
        .finish();
    let mut headers = HeaderMap::new();
    if let Ok(value) = HeaderValue::from_str(&format!("Basic {credentials}")) {
        headers.insert(AUTHORIZATION, value);
    }
    headers.insert(
        CONTENT_TYPE,
        HeaderValue::from_static("application/x-www-form-urlencoded"),
    );
    let response = safe_fetch(
        Some(state),
        &url,
        SafeFetchOptions {
            method: Some("POST".to_string()),
            headers,
            body: Some(form.into_bytes()),
            timeout_ms: Some(SMS_TIMEOUT_MS),
            max_redirects: None,
            max_bytes: Some(SMS_MAX_BYTES),
        },
    )
    .await
    .map_err(|_| SmsFailure::Transport)?;
    if !response.ok() {
        return Err(SmsFailure::Transport);
    }
    Ok(())
}

async fn send_via_webhook(state: &AppState, to: &str, body: &str) -> Result<(), SmsFailure> {
    let settings = state.settings.get();
    let url = settings.sms.webhook_url.clone();
    if url.is_empty() {
        return Err(SmsFailure::Orbit(not_configured(
            "SMS webhook is not configured",
        )));
    }
    let payload = serde_json::json!({
        "to": to,
        "body": body,
        "from": settings.application.name,
    });
    let mut headers = HeaderMap::new();
    headers.insert(CONTENT_TYPE, HeaderValue::from_static("application/json"));
    let response = safe_fetch(
        Some(state),
        &url,
        SafeFetchOptions {
            method: Some("POST".to_string()),
            headers,
            body: Some(payload.to_string().into_bytes()),
            timeout_ms: Some(SMS_TIMEOUT_MS),
            max_redirects: None,
            max_bytes: Some(SMS_MAX_BYTES),
        },
    )
    .await
    .map_err(|_| SmsFailure::Transport)?;
    if !response.ok() {
        return Err(SmsFailure::Transport);
    }
    Ok(())
}

/// SMS delivery. The caller gets a typed outcome; the audit log gets a
/// recipient-free reason, and the message contains no code.
pub async fn send_sms(state: &AppState, to: &str, body: &str) -> EmailDeliveryResult {
    let mailer = mailer(state);
    let capture = mailer.capture_enabled();
    if capture {
        record_sms(
            &mailer,
            SentSms {
                to: to.to_string(),
                body: body.to_string(),
                sent_at: now_ms(),
            },
        );
    }
    let settings = state.settings.get();
    let outcome: Result<(), SmsFailure> = match sms_override(&mailer) {
        Some(sender) => sender.send(to, body).await.map_err(SmsFailure::Orbit),
        None => match settings.sms.provider {
            SmsProvider::Twilio => send_via_twilio(state, to, body).await,
            SmsProvider::Webhook => send_via_webhook(state, to, body).await,
            SmsProvider::Console => {
                if capture {
                    Ok(())
                } else {
                    Err(SmsFailure::Orbit(OrbitError::new(
                        axum::http::StatusCode::SERVICE_UNAVAILABLE,
                        "sms_not_configured",
                        "SMS is not configured, so nothing was sent. Choose Twilio or a webhook in the dashboard.",
                    )))
                }
            }
        },
    };

    let mut result = EmailDeliveryResult::delivered();
    if let Err(failure) = outcome {
        let (code, message) = match failure {
            SmsFailure::Orbit(error) => (error.code, error.message),
            SmsFailure::Transport => (
                "sms_delivery_failed".to_string(),
                "SMS delivery failed.".to_string(),
            ),
        };
        result = EmailDeliveryResult::failed(code.clone(), message);
        audit(
            state,
            AuditInput::new("sms.delivery_failed")
                .actor("system")
                .target_type("sms")
                .metadata(serde_json::json!({ "code": code })),
        )
        .await;
    }
    crate::webhooks::emit_event(
        state,
        "sms.created",
        serde_json::json!({
            "object": "sms",
            "to": to,
            "created_at": now_ms(),
        }),
    )
    .await;
    result
}
