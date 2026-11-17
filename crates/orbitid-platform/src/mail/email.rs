//! Email transports (Resend HTTP API and SMTP via `lettre`) and the public send
//! API, ported from the retired TypeScript server.

use std::time::Duration;

use lettre::message::{Mailbox, MultiPart};
use lettre::transport::smtp::authentication::Credentials;
use lettre::transport::smtp::client::{Tls, TlsParameters, TlsVersion};
use lettre::{AsyncSmtpTransport, AsyncTransport, Message, Tokio1Executor};
use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::email_format::{normalize_recipient, parse_smtp_url};
use orbitid_core::settings::types::InstanceSettings;
use orbitid_core::state::AppState;
use serde::Serialize;

use crate::audit::{audit, AuditInput};
use crate::js::flatten_whitespace;

use super::core::{
    now_ms, resolve_email_transport, MailProvider, ResolvedEmailTransport, SendEmailInput,
    SentEmail,
};
use super::outbox::{mailer, record_email, transport_override};
use super::render::render_email;

const RESEND_TIMEOUT_SECS: u64 = 10;
const SMTP_TIMEOUT_SECS: u64 = 20;
const PROVIDER_DETAIL_LIMIT: usize = 300;

#[derive(Serialize)]
struct ResendPayload<'a> {
    from: &'a str,
    to: &'a str,
    subject: &'a str,
    html: &'a str,
    text: &'a str,
}

/// Provider response bodies are echoed back to the operator: redact the key,
/// flatten and cap the text.
fn safe_provider_detail(body: &str, secret: &str) -> String {
    let mut detail = flatten_whitespace(body);
    if !secret.is_empty() {
        detail = detail.replace(secret, "[redacted]");
    }
    detail.chars().take(PROVIDER_DETAIL_LIMIT).collect()
}

async fn send_via_resend(
    state: &AppState,
    endpoint: &str,
    transport: &ResolvedEmailTransport,
    message: &SentEmail,
) -> Result<(), OrbitError> {
    let api_key = transport.resend_api_key.as_deref().unwrap_or("");
    let payload = ResendPayload {
        from: &transport.from,
        to: &message.to,
        subject: &message.subject,
        html: &message.html,
        text: &message.text,
    };
    let body = serde_json::to_vec(&payload).unwrap_or_default();
    let response = state
        .http_client
        .post(endpoint)
        .timeout(Duration::from_secs(RESEND_TIMEOUT_SECS))
        .header("Authorization", format!("Bearer {api_key}"))
        .header("Content-Type", "application/json")
        .body(body)
        .send()
        .await;
    let response = match response {
        Ok(response) => response,
        Err(error) => {
            let message = if error.is_timeout() {
                "Resend did not respond within 10 seconds".to_string()
            } else {
                "Could not reach Resend".to_string()
            };
            return Err(OrbitError::new(
                axum_status(502),
                error_codes::EMAIL_DELIVERY_FAILED,
                message,
            ));
        }
    };
    if response.status().is_success() {
        return Ok(());
    }
    let status = response.status().as_u16();
    let body = response.text().await.unwrap_or_default();
    let detail = safe_provider_detail(&body, api_key);
    let message = if detail.is_empty() {
        format!("Resend rejected the email (HTTP {status})")
    } else {
        format!("Resend rejected the email (HTTP {status}): {detail}")
    };
    Err(OrbitError::new(
        axum_status(502),
        error_codes::EMAIL_DELIVERY_FAILED,
        message,
    ))
}

fn axum_status(code: u16) -> axum::http::StatusCode {
    axum::http::StatusCode::from_u16(code).unwrap_or(axum::http::StatusCode::INTERNAL_SERVER_ERROR)
}

fn smtp_failure(detail: &str, password: &str) -> OrbitError {
    let safe = safe_provider_detail(detail, password);
    let message = if safe.is_empty() {
        "SMTP delivery failed".to_string()
    } else {
        format!("SMTP delivery failed: {safe}")
    };
    OrbitError::new(
        axum_status(502),
        error_codes::EMAIL_DELIVERY_FAILED,
        message,
    )
}

async fn send_via_smtp(
    transport: &ResolvedEmailTransport,
    message: &SentEmail,
) -> Result<(), OrbitError> {
    let smtp_url = transport.smtp_url.as_deref().unwrap_or("");
    let connection = parse_smtp_url(smtp_url, "email.smtpUrl")?;
    let password = connection.pass.clone().unwrap_or_default();

    let tls = match (connection.secure, connection.user.is_some()) {
        // TLS certificates are always verified and TLS 1.2 is the floor.
        (true, _) => Tls::Wrapper(smtp_tls_parameters(&connection.host, &password)?),
        (false, true) => Tls::Required(smtp_tls_parameters(&connection.host, &password)?),
        (false, false) => Tls::Opportunistic(smtp_tls_parameters(&connection.host, &password)?),
    };
    let mut builder = AsyncSmtpTransport::<Tokio1Executor>::builder_dangerous(&connection.host)
        .port(connection.port)
        .timeout(Some(Duration::from_secs(SMTP_TIMEOUT_SECS)))
        .tls(tls);
    if let Some(user) = &connection.user {
        builder = builder.credentials(Credentials::new(user.clone(), password.clone()));
    }
    let smtp = builder.build();

    let from = transport
        .from
        .parse::<Mailbox>()
        .map_err(|_| smtp_failure("invalid From address", &password))?;
    let to = message
        .to
        .parse::<Mailbox>()
        .map_err(|_| smtp_failure("invalid recipient address", &password))?;
    let email = Message::builder()
        .from(from)
        .to(to)
        .subject(message.subject.clone())
        .multipart(MultiPart::alternative_plain_html(
            message.text.clone(),
            message.html.clone(),
        ))
        .map_err(|error| smtp_failure(&error.to_string(), &password))?;
    smtp.send(email)
        .await
        .map_err(|error| smtp_failure(&error.to_string(), &password))?;
    Ok(())
}

fn smtp_tls_parameters(host: &str, password: &str) -> Result<TlsParameters, OrbitError> {
    TlsParameters::builder(host.to_string())
        .set_min_tls_version(TlsVersion::Tlsv12)
        .build()
        .map_err(|error| smtp_failure(&error.to_string(), password))
}

/// Hands a rendered message to the configured transport.
async fn deliver(
    state: &AppState,
    transport: &ResolvedEmailTransport,
    message: &SentEmail,
    endpoint: &str,
) -> Result<(), OrbitError> {
    match transport.provider {
        MailProvider::Resend => send_via_resend(state, endpoint, transport, message).await,
        MailProvider::Smtp => send_via_smtp(transport, message).await,
        // No provider, no delivery — not even under test. Tests read the recorded
        // message from the outbox and the auth flow carries on.
        MailProvider::Console => Err(OrbitError::new(
            axum_status(503),
            "email_not_configured",
            "Email is not configured, so nothing was sent. Set email.resendApiKey or email.smtpUrl (or ORBITID_RESEND_API_KEY / ORBITID_SMTP_URL).",
        )),
    }
}

async fn attempt(
    state: &AppState,
    input: &SendEmailInput,
    settings: &InstanceSettings,
) -> (Option<SentEmail>, Result<(), OrbitError>) {
    let outcome: Result<SentEmail, OrbitError> = async {
        let to = normalize_recipient(&input.to)?;
        let rendered = render_email(
            input.template,
            &input.vars,
            &settings.application.name,
            &settings.branding.primary_color,
        );
        Ok(SentEmail {
            to,
            template: input.template,
            subject: rendered.subject,
            text: rendered.text,
            html: rendered.html,
            vars: input.vars.clone(),
            sent_at: now_ms(),
        })
    }
    .await;
    let email = match outcome {
        Ok(email) => email,
        Err(error) => return (None, Err(error)),
    };
    let mailer = mailer(state);
    record_email(&mailer, email.clone());
    let delivered = match transport_override(&mailer) {
        Some(transport) => transport.deliver(&email).await,
        None => match resolve_email_transport(state) {
            Ok(transport) => {
                let endpoint = mailer.resend_endpoint();
                deliver(state, &transport, &email, &endpoint).await
            }
            Err(error) => Err(error),
        },
    };
    (Some(email), delivered)
}

/// Sends an email through the configured transport. Delivery failures are
/// reported (never thrown) so an auth flow is never broken by a mail problem.
pub async fn send_email(
    state: &AppState,
    input: SendEmailInput,
) -> super::core::EmailDeliveryResult {
    let settings = state.settings.get();
    let (email, outcome) = attempt(state, &input, &settings).await;
    let mut result = super::core::EmailDeliveryResult::delivered();
    if let Err(error) = outcome {
        let code = error.code.clone();
        result = super::core::EmailDeliveryResult::failed(code.clone(), error.message.clone());
        audit(
            state,
            AuditInput::new("email.delivery_failed")
                .actor("system")
                .target_type("email")
                .metadata(serde_json::json!({
                    "template": input.template.as_str(),
                    "code": code,
                })),
        )
        .await;
    }
    let to = email
        .as_ref()
        .map(|email| email.to.clone())
        .unwrap_or_else(|| super::core::safe_recipient_fallback(&input.to));
    let created_at = email
        .as_ref()
        .map(|email| email.sent_at)
        .unwrap_or_else(now_ms);
    crate::webhooks::emit_event(
        state,
        "email.created",
        serde_json::json!({
            "object": "email",
            "to": to,
            "template": input.template.as_str(),
            "created_at": created_at,
        }),
    )
    .await;
    result
}

/// Sends a test message and reports the provider. Unlike [`send_email`] this
/// throws (with a safe message) so the admin endpoint can return a 502.
pub async fn send_test_email(state: &AppState, to: &str) -> Result<MailProvider, OrbitError> {
    let recipient = normalize_recipient(to)?;
    let transport = resolve_email_transport(state)?;
    let settings = state.settings.get();
    let rendered = render_email(
        super::core::EmailTemplate::TestEmail,
        &super::core::EmailVars::new(),
        &settings.application.name,
        &settings.branding.primary_color,
    );
    let email = SentEmail {
        to: recipient.clone(),
        template: super::core::EmailTemplate::TestEmail,
        subject: rendered.subject.clone(),
        text: rendered.text.clone(),
        html: rendered.html.clone(),
        vars: super::core::EmailVars::new(),
        sent_at: now_ms(),
    };
    let mailer = mailer(state);
    record_email(&mailer, email.clone());
    let endpoint = mailer.resend_endpoint();
    deliver(state, &transport, &email, &endpoint).await?;
    crate::webhooks::emit_event(
        state,
        "email.created",
        serde_json::json!({
            "object": "email",
            "to": recipient,
            "template": "test_email",
            "subject": rendered.subject,
            "created_at": now_ms(),
        }),
    )
    .await;
    Ok(transport.provider)
}
