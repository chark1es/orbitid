//! Per-`AppState` capture state: the test outbox, transport overrides and the
//! Resend endpoint override. Attached through `state.extensions`, never a
//! process global, so parallel tests and replicas cannot interfere.

use std::sync::{Arc, RwLock};

use orbitid_core::state::AppState;
use serde_json::Value;

use super::core::{EmailTemplate, MailTransportOverride, SentEmail, SentSms, SmsSender};

/// Per-`AppState` capture state. Attached through `state.extensions` so parallel
/// tests (and replicas) never share an outbox.
#[derive(Clone)]
pub struct Mailer {
    capture: bool,
    mail: Arc<RwLock<Vec<SentEmail>>>,
    sms: Arc<RwLock<Vec<SentSms>>>,
    transport_override: Arc<RwLock<Option<Arc<dyn MailTransportOverride>>>>,
    sms_sender: Arc<RwLock<Option<Arc<dyn SmsSender>>>>,
    resend_endpoint: Arc<RwLock<Option<String>>>,
}

const OUTBOX_LIMIT: usize = 500;
const RESEND_ENDPOINT: &str = "https://api.resend.com/emails";

/// Mirrors `!!process.env.VITEST || process.env.NODE_ENV === "test"`.
pub fn is_test_environment(node_env: &str) -> bool {
    node_env == "test" || std::env::var("NODE_ENV").as_deref() == Ok("test")
}

impl Mailer {
    /// Creates a mailer. Capture is enabled only in a test environment, so a
    /// deployed server can never be talked into retaining a sign-in code.
    pub fn new(state: &AppState) -> Self {
        Self::with_capture(is_test_environment(&state.env.node_env))
    }

    /// Creates a mailer with capture explicitly enabled or disabled.
    pub fn with_capture(capture: bool) -> Self {
        Self {
            capture,
            mail: Arc::new(RwLock::new(Vec::new())),
            sms: Arc::new(RwLock::new(Vec::new())),
            transport_override: Arc::new(RwLock::new(None)),
            sms_sender: Arc::new(RwLock::new(None)),
            resend_endpoint: Arc::new(RwLock::new(None)),
        }
    }

    /// True when this mailer records messages for a test to read.
    pub fn capture_enabled(&self) -> bool {
        self.capture
    }

    fn record_email(&self, email: SentEmail) {
        if !self.capture {
            return;
        }
        if let Ok(mut outbox) = self.mail.write() {
            outbox.push(email);
            if outbox.len() > OUTBOX_LIMIT {
                let excess = outbox.len() - OUTBOX_LIMIT;
                outbox.drain(0..excess);
            }
        }
    }

    fn record_sms(&self, message: SentSms) {
        if !self.capture {
            return;
        }
        if let Ok(mut outbox) = self.sms.write() {
            outbox.push(message);
            if outbox.len() > OUTBOX_LIMIT {
                let excess = outbox.len() - OUTBOX_LIMIT;
                outbox.drain(0..excess);
            }
        }
    }

    /// Snapshot of the recorded emails (oldest first).
    pub fn get_mail_outbox(&self) -> Vec<SentEmail> {
        self.mail
            .read()
            .map(|outbox| outbox.clone())
            .unwrap_or_default()
    }

    /// Snapshot of the recorded SMS messages (oldest first).
    pub fn get_sms_outbox(&self) -> Vec<SentSms> {
        self.sms
            .read()
            .map(|outbox| outbox.clone())
            .unwrap_or_default()
    }

    /// Empties both outboxes.
    pub fn clear_mail_outbox(&self) {
        if let Ok(mut outbox) = self.mail.write() {
            outbox.clear();
        }
        if let Ok(mut outbox) = self.sms.write() {
            outbox.clear();
        }
    }

    /// Replaces the delivery transport (test seam; `None` restores the real one).
    pub fn set_mail_transport(&self, transport: Option<Arc<dyn MailTransportOverride>>) {
        if let Ok(mut slot) = self.transport_override.write() {
            *slot = transport;
        }
    }

    /// Replaces the SMS sender (test seam; `None` restores the real one).
    pub fn set_sms_sender(&self, sender: Option<Arc<dyn SmsSender>>) {
        if let Ok(mut slot) = self.sms_sender.write() {
            *slot = sender;
        }
    }

    /// Points Resend at a local server (test seam; `None` restores the real API).
    pub fn set_resend_endpoint_for_tests(&self, endpoint: Option<String>) {
        if let Ok(mut slot) = self.resend_endpoint.write() {
            *slot = endpoint;
        }
    }

    /// The Resend endpoint currently in use.
    pub fn resend_endpoint(&self) -> String {
        self.resend_endpoint
            .read()
            .ok()
            .and_then(|slot| slot.clone())
            .unwrap_or_else(|| RESEND_ENDPOINT.to_string())
    }

    fn transport_override(&self) -> Option<Arc<dyn MailTransportOverride>> {
        self.transport_override
            .read()
            .ok()
            .and_then(|slot| slot.clone())
    }

    fn sms_sender(&self) -> Option<Arc<dyn SmsSender>> {
        self.sms_sender.read().ok().and_then(|slot| slot.clone())
    }

    /// Latest recorded email for an address, optionally filtered by template.
    pub fn latest_email(&self, to: &str, template: Option<EmailTemplate>) -> Option<SentEmail> {
        let lowered = to.to_lowercase();
        self.get_mail_outbox().into_iter().rev().find(|email| {
            email.to.to_lowercase() == lowered
                && template.is_none_or(|template| email.template == template)
        })
    }

    /// Numeric code from the most recent code email sent to `to`.
    pub fn latest_code_for(&self, to: &str, template: Option<EmailTemplate>) -> Option<String> {
        let email = self.latest_email(
            to,
            Some(template.unwrap_or(EmailTemplate::VerificationCode)),
        )?;
        if let Some(Value::String(code)) = email.vars.get("code") {
            return Some(code.clone());
        }
        code_in(&email.text)
    }

    /// Magic link from the most recent `magic_link` email sent to `to`.
    pub fn latest_link_for(&self, to: &str) -> Option<String> {
        let email = self.latest_email(to, Some(EmailTemplate::MagicLink))?;
        match email.vars.get("link") {
            Some(Value::String(link)) => Some(link.clone()),
            _ => None,
        }
    }
}

/// The `\b(\d{4,8})\b` helper from `latestCodeFor`.
fn code_in(text: &str) -> Option<String> {
    use std::sync::OnceLock;
    static CODE: OnceLock<Option<regex::Regex>> = OnceLock::new();
    CODE.get_or_init(|| regex::Regex::new(r"\b(\d{4,8})\b").ok())
        .as_ref()?
        .captures(text)
        .and_then(|captures| captures.get(1).map(|value| value.as_str().to_string()))
}

/// The mailer attached to `state`, installing one on first use.
pub fn mailer(state: &AppState) -> Arc<Mailer> {
    state.extensions.get_or_insert(|| Mailer::new(state))
}

/// Recorded emails for `state`. Auto-installs the mailer on first use.
pub fn get_mail_outbox(state: &AppState) -> Vec<SentEmail> {
    mailer(state).get_mail_outbox()
}

/// Recorded SMS messages for `state`.
pub fn get_sms_outbox(state: &AppState) -> Vec<SentSms> {
    mailer(state).get_sms_outbox()
}

/// Empties the outboxes for `state`.
pub fn clear_mail_outbox(state: &AppState) {
    mailer(state).clear_mail_outbox();
}

pub fn latest_email(
    state: &AppState,
    to: &str,
    template: Option<EmailTemplate>,
) -> Option<SentEmail> {
    mailer(state).latest_email(to, template)
}

pub fn latest_code_for(
    state: &AppState,
    to: &str,
    template: Option<EmailTemplate>,
) -> Option<String> {
    mailer(state).latest_code_for(to, template)
}

pub fn latest_link_for(state: &AppState, to: &str) -> Option<String> {
    mailer(state).latest_link_for(to)
}

pub fn set_mail_transport(state: &AppState, transport: Option<Arc<dyn MailTransportOverride>>) {
    mailer(state).set_mail_transport(transport);
}

pub fn set_sms_sender(state: &AppState, sender: Option<Arc<dyn SmsSender>>) {
    mailer(state).set_sms_sender(sender);
}

pub fn set_resend_endpoint_for_tests(state: &AppState, endpoint: Option<String>) {
    mailer(state).set_resend_endpoint_for_tests(endpoint);
}

/// Records a sent email (no-op outside a capture-enabled test mailer).
pub(crate) fn record_email(mailer: &Mailer, email: SentEmail) {
    mailer.record_email(email);
}

pub(crate) fn record_sms(mailer: &Mailer, message: SentSms) {
    mailer.record_sms(message);
}

pub(crate) fn transport_override(mailer: &Mailer) -> Option<Arc<dyn MailTransportOverride>> {
    mailer.transport_override()
}

pub(crate) fn sms_override(mailer: &Mailer) -> Option<Arc<dyn SmsSender>> {
    mailer.sms_sender()
}
