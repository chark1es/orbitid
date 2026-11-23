//! L1 platform services: mail/SMS delivery, webhooks, the audit log, CAPTCHA
//! verification, image validation, instance statistics and the release check.
//!
//! Every service is context-free unless it needs the database or settings: state
//! that must be shared with a test (mail outbox, captcha verifier, Resend
//! endpoint) lives in `AppState::extensions`, never in a process global, so
//! parallel tests and replicas cannot interfere with each other.

pub mod audit;
pub mod captcha;
pub mod images;
pub mod js;
pub mod mail;
pub mod release;
pub mod stats;
pub mod webhooks;

pub use audit::{audit, list_audit_logs, serialize_audit_log, AuditInput, AuditLogFilters};
pub use captcha::{
    set_captcha_verifier_for_tests, verify_captcha, CaptchaService, CaptchaVerifier,
};
pub use images::{
    assert_image_bytes, contains_markup, default_avatar, looks_like_markup, random_image_name,
    sniff_image, ImageKind, IMAGE_RESPONSE_HEADERS,
};
pub use mail::{
    clear_mail_outbox, email_delivery_configured, email_startup_warnings, get_mail_outbox,
    get_sms_outbox, is_test_environment, latest_code_for, latest_email, latest_link_for, mailer,
    render_email, resolve_email_transport, send_email, send_sms, send_test_email,
    set_mail_transport, set_resend_endpoint_for_tests, set_sms_sender, EmailDeliveryResult,
    EmailTemplate, MailProvider, MailTransportOverride, Mailer, SendEmailInput, SentEmail, SentSms,
    SmsSender,
};
pub use release::{
    current_version, release_check, version_status, ReleaseCheck, ReleaseWorker, VersionStatus,
};
pub use stats::{instance_stats, InstanceStatsJson};
pub use webhooks::{
    deliver_due, emit_event, generate_webhook_secret, serialize_webhook_delivery,
    serialize_webhook_endpoint, sign_webhook, verify_webhook_signature, VerifyOptions,
    WebhookVerificationInput, WebhookWorker,
};
