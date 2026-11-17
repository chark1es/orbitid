//! Email/SMS delivery. Public surface re-exported from cohesive modules,
//! mirroring the retired TypeScript server.

mod core;
mod email;
mod outbox;
mod render;
mod sms;

pub use core::{
    email_delivery_configured, email_startup_warnings, resolve_email_transport,
    resolve_email_transport_with, safe_recipient_fallback, EmailDeliveryError, EmailDeliveryResult,
    EmailTemplate, EmailVars, MailProvider, MailTransportOverride, ResolvedEmailTransport,
    SendEmailInput, SentEmail, SentSms, SmsSender,
};
pub use email::{send_email, send_test_email};
pub use outbox::{
    clear_mail_outbox, get_mail_outbox, get_sms_outbox, is_test_environment, latest_code_for,
    latest_email, latest_link_for, mailer, set_mail_transport, set_resend_endpoint_for_tests,
    set_sms_sender, Mailer,
};
pub use render::{render_email, RenderedEmail};
pub use sms::send_sms;

pub use orbitid_core::http::email_format::{
    header_safe, normalize_recipient, parse_email_from, parse_smtp_url, redact_smtp_url, EmailFrom,
    SmtpConnection, DEFAULT_FROM,
};
