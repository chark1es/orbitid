//! Ported service-level mail tests: transport resolution, Resend/SMTP delivery,
//! template escaping, the outbox and the "no secret leaves the server" guarantee.

mod support;

use std::sync::{Arc, Mutex};

use orbitid_core::settings::types::InstanceSettings;
use orbitid_core::testing::test_state;
use orbitid_platform::mail::{
    clear_mail_outbox, email_startup_warnings, get_mail_outbox, latest_code_for, latest_link_for,
    mailer, resolve_email_transport, resolve_email_transport_with, send_email, send_sms,
    send_test_email, set_resend_endpoint_for_tests, set_sms_sender, EmailTemplate,
    MailTransportOverride, SendEmailInput, SentEmail, SmsSender,
};
use serde_json::json;
use support::{code_in, start_fake_resend, start_fake_smtp};

const RESEND_KEY: &str = "re_live_test_key_do_not_leak";

fn resend_settings() -> serde_json::Value {
    json!({
        "email": {
            "provider": "resend",
            "resendApiKey": RESEND_KEY,
            "from": "Acme <no-reply@acme.test>"
        }
    })
}

fn smtp_settings(url: &str) -> serde_json::Value {
    json!({
        "email": {
            "provider": "smtp",
            "smtpUrl": url,
            "from": "Acme <no-reply@acme.test>"
        }
    })
}

#[tokio::test]
async fn resend_delivers_a_verification_code_and_the_event_never_contains_it() {
    let ctx = test_state().await;
    let resend = start_fake_resend(200, r#"{"id":"re_fake_message"}"#).await;
    set_resend_endpoint_for_tests(&ctx.state, Some(resend.url.clone()));
    ctx.state
        .settings
        .update(resend_settings())
        .await
        .expect("settings");

    let result = send_email(
        &ctx.state,
        SendEmailInput::new("resend-code@example.com", EmailTemplate::VerificationCode)
            .with_var("code", "424242"),
    )
    .await;
    assert!(result.delivered, "{result:?}");

    let requests = resend.requests();
    assert_eq!(requests.len(), 1);
    let request = &requests[0];
    assert_eq!(request.authorization, Some(format!("Bearer {RESEND_KEY}")));
    assert!(request
        .content_type
        .as_deref()
        .unwrap_or("")
        .contains("application/json"));
    assert_eq!(request.body["from"], "\"Acme\" <no-reply@acme.test>");
    assert_eq!(request.body["to"], "resend-code@example.com");
    assert_eq!(
        request.body["subject"],
        "424242 is your OrbitID App verification code"
    );
    assert!(request.body["html"]
        .as_str()
        .unwrap_or("")
        .contains("424242"));
    assert!(request.body["text"]
        .as_str()
        .unwrap_or("")
        .contains("424242"));

    assert_eq!(
        latest_code_for(&ctx.state, "resend-code@example.com", None).as_deref(),
        Some("424242")
    );
    // The webhook event names the template and the recipient, never the subject.
    let payload: serde_json::Value =
        sqlx::query_scalar("SELECT payload FROM webhook_events LIMIT 1")
            .fetch_one(&ctx.state.pool)
            .await
            .expect("event");
    let text = payload.to_string();
    assert!(text.contains("verification_code"));
    assert!(!text.contains("424242"));
}

#[tokio::test]
async fn resend_failures_are_redacted_and_truncated() {
    let ctx = test_state().await;
    let long = format!("{{\"message\":\"boom {RESEND_KEY} {}\"}}", "x".repeat(400));
    let resend = start_fake_resend(500, &long).await;
    set_resend_endpoint_for_tests(&ctx.state, Some(resend.url.clone()));
    ctx.state
        .settings
        .update(resend_settings())
        .await
        .expect("settings");

    let error = send_test_email(&ctx.state, "ops@example.com")
        .await
        .expect_err("must fail");
    assert_eq!(error.status, axum::http::StatusCode::BAD_GATEWAY);
    assert_eq!(error.code, "email_delivery_failed");
    assert!(!error.message.contains(RESEND_KEY));
    assert!(error.message.contains("[redacted]"));
    assert!(error.message.len() < 360, "{}", error.message);

    // send_email reports the same failure without throwing.
    let result = send_email(
        &ctx.state,
        SendEmailInput::new("ops@example.com", EmailTemplate::VerificationCode)
            .with_var("code", "515151"),
    )
    .await;
    assert!(!result.delivered);
    assert_eq!(
        result.error.as_ref().map(|error| error.code.as_str()),
        Some("email_delivery_failed")
    );
}

#[tokio::test]
async fn smtp_delivers_with_intact_headers() {
    let ctx = test_state().await;
    let smtp = start_fake_smtp().await;
    ctx.state
        .settings
        .update(smtp_settings(&smtp.url))
        .await
        .expect("settings");

    let result = send_email(
        &ctx.state,
        SendEmailInput::new("smtp-code@example.com", EmailTemplate::VerificationCode)
            .with_var("code", "654321"),
    )
    .await;
    assert!(result.delivered, "{result:?}");

    let messages = smtp.messages();
    assert_eq!(messages.len(), 1);
    let message = &messages[0];
    assert_eq!(message.mail_from, "no-reply@acme.test");
    assert_eq!(message.recipients, vec!["smtp-code@example.com"]);
    let headers = support::raw_headers(&message.raw);
    assert_eq!(
        headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("from"))
            .count(),
        1
    );
    assert_eq!(
        headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("to"))
            .count(),
        1
    );
    assert_eq!(
        headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("subject"))
            .count(),
        1
    );
    assert!(support::header_value(&headers, "from")
        .unwrap_or("")
        .contains("no-reply@acme.test"));
    let subject = support::header_value(&headers, "subject").unwrap_or("");
    assert!(subject.ends_with("is your OrbitID App verification code"));
    assert_eq!(
        code_in(&support::readable_message(&message.raw)).as_deref(),
        Some("654321")
    );
}

#[tokio::test]
async fn display_names_and_app_names_never_create_headers() {
    let ctx = test_state().await;
    let smtp = start_fake_smtp().await;
    ctx.state
        .settings
        .update(smtp_settings(&smtp.url))
        .await
        .expect("settings");
    ctx.state
        .settings
        .update(json!({ "application": { "name": "Acme\r\nBcc: leak@example.com" } }))
        .await
        .expect("settings");

    send_email(
        &ctx.state,
        SendEmailInput::new("target@example.com", EmailTemplate::NewSignIn)
            .with_var("user_name", "Ada\r\nBcc: attacker@example.com")
            .with_var("ip_address", "203.0.113.7\r\nX-Injected: yes")
            .with_var("user_agent", "Firefox"),
    )
    .await;

    let message = smtp.last().expect("message");
    let headers = support::raw_headers(&message.raw);
    assert!(support::header_value(&headers, "bcc").is_none());
    assert!(support::header_value(&headers, "x-injected").is_none());
    assert!(!message.raw.contains("attacker@example.com\r\n"));
    assert!(!support::header_value(&headers, "subject")
        .unwrap_or("")
        .contains(['\r', '\n']));
    assert!(support::readable_message(&message.raw).contains("Ada Bcc: attacker@example.com"));
}

#[tokio::test]
async fn recipients_that_fail_the_strict_check_are_refused() {
    let ctx = test_state().await;
    let smtp = start_fake_smtp().await;
    ctx.state
        .settings
        .update(smtp_settings(&smtp.url))
        .await
        .expect("settings");

    for bad in [
        "a@b.c\r\nBcc: evil@example.com",
        "not-an-address",
        "a@localhost",
        "",
    ] {
        let result = send_email(
            &ctx.state,
            SendEmailInput::new(bad, EmailTemplate::TestEmail),
        )
        .await;
        assert!(!result.delivered, "{bad}");
        assert_eq!(
            result.error.as_ref().map(|error| error.code.as_str()),
            Some("form_param_format_invalid")
        );
        let error = send_test_email(&ctx.state, bad).await.expect_err("422");
        assert_eq!(error.status, axum::http::StatusCode::UNPROCESSABLE_ENTITY);
    }
    assert!(smtp.messages().is_empty());
    assert!(get_mail_outbox(&ctx.state).is_empty());
}

#[tokio::test]
async fn console_provider_records_but_never_delivers() {
    let ctx = test_state().await;
    let result = send_email(
        &ctx.state,
        SendEmailInput::new("ada@example.com", EmailTemplate::VerificationCode)
            .with_var("code", "424242"),
    )
    .await;
    assert!(!result.delivered);
    assert_eq!(
        result.error.as_ref().map(|error| error.code.as_str()),
        Some("email_not_configured")
    );
    assert_eq!(get_mail_outbox(&ctx.state).len(), 1);

    let error = send_test_email(&ctx.state, "ada@example.com")
        .await
        .expect_err("console is not a transport");
    assert_eq!(error.code, "email_not_configured");
    assert_eq!(error.status, axum::http::StatusCode::SERVICE_UNAVAILABLE);

    // The failure is audited without a recipient or a code.
    let metadata: serde_json::Value = sqlx::query_scalar(
        "SELECT metadata FROM audit_logs WHERE action = 'email.delivery_failed'",
    )
    .fetch_one(&ctx.state.pool)
    .await
    .expect("audit");
    assert_eq!(metadata["template"], "verification_code");
    assert!(!metadata.to_string().contains("424242"));
    assert!(!metadata.to_string().contains("ada@example.com"));
}

#[tokio::test]
async fn templates_escape_variables_and_only_link_http_urls() {
    let ctx = test_state().await;
    send_email(
        &ctx.state,
        SendEmailInput::new(
            "template@example.com",
            EmailTemplate::OrganizationInvitation,
        )
        .with_var("invitation_url", "javascript:alert(1)")
        .with_var("organization_name", "<img src=x onerror=alert(1)>")
        .with_var("inviter_name", "A&B"),
    )
    .await;
    let email = get_mail_outbox(&ctx.state).pop().expect("recorded");
    assert!(!email.html.contains("javascript:alert(1)"));
    assert!(!email.html.contains("<img src=x"));
    assert!(email.html.contains("&lt;img src=x onerror=alert(1)&gt;"));
    assert!(email.html.contains("A&amp;B"));
    assert_eq!(
        email.subject,
        "Join <img src=x onerror=alert(1)> on OrbitID App"
    );

    send_email(
        &ctx.state,
        SendEmailInput::new("template@example.com", EmailTemplate::MagicLink)
            .with_var("link", "https://auth.example.com/v1/verify?token=abc"),
    )
    .await;
    let link_email = get_mail_outbox(&ctx.state).pop().expect("recorded");
    assert!(link_email
        .html
        .contains("href=\"https://auth.example.com/v1/verify?token=abc\""));
    assert_eq!(
        latest_link_for(&ctx.state, "template@example.com").as_deref(),
        Some("https://auth.example.com/v1/verify?token=abc")
    );
}

#[tokio::test]
async fn transport_resolution_prefers_settings_then_environment() {
    let mut settings = InstanceSettings::default();
    let resolved = resolve_email_transport_with(&settings, "", "", "").expect("resolves");
    assert_eq!(resolved.provider, orbitid_platform::MailProvider::Console);
    assert_eq!(resolved.from, "\"OrbitID\" <no-reply@localhost>");

    settings.email.resend_api_key = "re_setting".to_string();
    let resolved = resolve_email_transport_with(&settings, "re_env", "", "Env <env@example.com>")
        .expect("resolves");
    assert_eq!(resolved.provider, orbitid_platform::MailProvider::Resend);
    assert_eq!(resolved.resend_api_key.as_deref(), Some("re_setting"));
    assert_eq!(resolved.from, "\"Env\" <env@example.com>");

    settings.email.resend_api_key = String::new();
    settings.email.smtp_url = String::new();
    let resolved =
        resolve_email_transport_with(&settings, "re_env", "smtp://env.example.com:587", "")
            .expect("resolves");
    assert_eq!(resolved.provider, orbitid_platform::MailProvider::Resend);
    let resolved = resolve_email_transport_with(&settings, "", "smtp://env.example.com:587", "")
        .expect("resolves");
    assert_eq!(resolved.provider, orbitid_platform::MailProvider::Smtp);

    settings.email.provider = orbitid_core::settings::types::EmailProvider::Console;
    settings.email.resend_api_key = "re_both".to_string();
    assert_eq!(
        resolve_email_transport_with(&settings, "", "", "")
            .expect("resolves")
            .provider,
        orbitid_platform::MailProvider::Console
    );
    settings.email.provider = orbitid_core::settings::types::EmailProvider::Smtp;
    let error = resolve_email_transport_with(&settings, "", "", "").expect_err("missing url");
    assert!(error.message.to_lowercase().contains("smtp"));
    settings.email.provider = orbitid_core::settings::types::EmailProvider::Resend;
    settings.email.resend_api_key = String::new();
    let error = resolve_email_transport_with(&settings, "", "", "").expect_err("missing key");
    assert!(error.message.contains("API key"));
}

#[tokio::test]
async fn startup_warnings_report_the_configured_state() {
    let ctx = test_state().await;
    let warning = email_startup_warnings(&ctx.state).join("\n");
    assert!(warning.contains("EMAIL IS NOT CONFIGURED"));
    assert!(warning.contains("ORBITID_RESEND_API_KEY"));
    assert!(warning.contains("ORBITID_SMTP_URL"));
    assert!(warning.contains("docs/EMAIL.md"));

    ctx.state
        .settings
        .update(json!({
            "email": {
                "provider": "smtp",
                "smtpUrl": "smtps://user:secret-pass@mail.example.com:465"
            }
        }))
        .await
        .expect("settings");
    let smtp_line = email_startup_warnings(&ctx.state).join("\n");
    assert!(smtp_line.contains("mail.example.com"));
    assert!(!smtp_line.contains("secret-pass"));
    assert_eq!(
        resolve_email_transport(&ctx.state)
            .expect("resolves")
            .provider,
        orbitid_platform::MailProvider::Smtp
    );
}

struct RecordingTransport {
    emails: Arc<Mutex<Vec<SentEmail>>>,
}

#[async_trait::async_trait]
impl MailTransportOverride for RecordingTransport {
    async fn deliver(&self, email: &SentEmail) -> orbitid_core::Result<()> {
        if let Ok(mut emails) = self.emails.lock() {
            emails.push(email.clone());
        }
        Ok(())
    }
}

#[tokio::test]
async fn transport_override_bypasses_provider_resolution() {
    let ctx = test_state().await;
    let emails = Arc::new(Mutex::new(Vec::new()));
    orbitid_platform::set_mail_transport(
        &ctx.state,
        Some(Arc::new(RecordingTransport {
            emails: emails.clone(),
        })),
    );
    let result = send_email(
        &ctx.state,
        SendEmailInput::new("override@example.com", EmailTemplate::TestEmail),
    )
    .await;
    assert!(result.delivered);
    assert_eq!(emails.lock().map(|value| value.len()).unwrap_or(0), 1);
    orbitid_platform::set_mail_transport(&ctx.state, None);
}

struct FailingSms;

#[async_trait::async_trait]
impl SmsSender for FailingSms {
    async fn send(&self, _to: &str, _body: &str) -> orbitid_core::Result<()> {
        Err(orbitid_core::OrbitError::new(
            axum::http::StatusCode::BAD_GATEWAY,
            "sms_delivery_failed",
            "SMS delivery failed.",
        ))
    }
}

#[tokio::test]
async fn sms_records_in_tests_and_reports_provider_failures() {
    let ctx = test_state().await;
    let result = send_sms(&ctx.state, "+15555550100", "Your code is 123456").await;
    assert!(
        result.delivered,
        "test environment has no transport requirement"
    );
    assert_eq!(orbitid_platform::get_sms_outbox(&ctx.state).len(), 1);
    let payload: serde_json::Value =
        sqlx::query_scalar("SELECT payload FROM webhook_events WHERE type = 'sms.created' LIMIT 1")
            .fetch_one(&ctx.state.pool)
            .await
            .expect("event");
    assert!(!payload.to_string().contains("123456"));

    set_sms_sender(&ctx.state, Some(Arc::new(FailingSms)));
    let failed = send_sms(&ctx.state, "+15555550100", "Your code is 123456").await;
    assert!(!failed.delivered);
    assert_eq!(
        failed.error.as_ref().map(|error| error.code.as_str()),
        Some("sms_delivery_failed")
    );
    set_sms_sender(&ctx.state, None);
}

#[tokio::test]
async fn sms_transport_failures_are_generic_and_audited() {
    let ctx = test_state().await;
    ctx.state
        .settings
        .update(
            json!({ "sms": { "provider": "webhook", "webhookUrl": "https://127.0.0.1:1/hook" } }),
        )
        .await
        .expect("settings");
    let failed = send_sms(&ctx.state, "+15555550100", "Your code is 123456").await;
    assert!(!failed.delivered);
    assert_eq!(
        failed.error.as_ref().map(|error| error.code.as_str()),
        Some("sms_delivery_failed")
    );
    assert_eq!(
        failed.error.as_ref().map(|error| error.message.as_str()),
        Some("SMS delivery failed.")
    );
    let metadata: serde_json::Value =
        sqlx::query_scalar("SELECT metadata FROM audit_logs WHERE action = 'sms.delivery_failed'")
            .fetch_one(&ctx.state.pool)
            .await
            .expect("audit");
    assert_eq!(metadata["code"], "sms_delivery_failed");
    assert!(!metadata.to_string().contains("123456"));
}

#[tokio::test]
async fn outboxes_are_per_state() {
    let first = test_state().await;
    let second = test_state().await;
    send_email(
        &first.state,
        SendEmailInput::new("one@example.com", EmailTemplate::VerificationCode)
            .with_var("code", "111111"),
    )
    .await;
    assert_eq!(get_mail_outbox(&first.state).len(), 1);
    assert!(get_mail_outbox(&second.state).is_empty());
    clear_mail_outbox(&first.state);
    assert!(get_mail_outbox(&first.state).is_empty());
    assert!(mailer(&first.state).capture_enabled());
}
