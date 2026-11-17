//! Timestamp, subject-confirmation and audience checks for SAML assertions.
//!
//! Everything here reads the *signature-verified* assertion produced by
//! `xmlsec`; nothing is inferred from the surrounding, possibly unsigned,
//! document.

use chrono::{DateTime, Duration, Utc};
use samael::schema::{Assertion, SubjectConfirmationData};

use crate::error::verification_failed;
use crate::saml::xml::same_url;

/// `acceptedClockSkewMs: 5000` in the TypeScript client.
pub const CLOCK_SKEW_MS: i64 = 5_000;
/// `maxAssertionAgeMs: 24h` in the TypeScript client.
pub const ASSERTION_MAX_AGE_MS: i64 = 24 * 60 * 60 * 1000;
/// The only flow this SP accepts at the ACS.
pub const BEARER_METHOD: &str = "urn:oasis:names:tc:SAML:2.0:cm:bearer";

pub(crate) fn fail(reason: impl std::fmt::Display) -> orbitid_core::OrbitError {
    verification_failed(format!("SAML assertion validation failed: {reason}"))
}

pub(crate) fn now() -> DateTime<Utc> {
    Utc::now()
}
pub(crate) fn timestamps_ok(
    not_before: Option<DateTime<Utc>>,
    not_on_or_after: DateTime<Utc>,
    max_time_limit: DateTime<Utc>,
    at: DateTime<Utc>,
) -> bool {
    let skew = Duration::milliseconds(CLOCK_SKEW_MS);
    if let Some(not_before) = not_before {
        if at + skew < not_before {
            return false;
        }
    }
    let effective_limit = not_on_or_after.min(max_time_limit);
    at - skew < effective_limit
}

pub(crate) fn max_time_limit(issue_instant: DateTime<Utc>) -> DateTime<Utc> {
    issue_instant + Duration::milliseconds(ASSERTION_MAX_AGE_MS)
}

/// Selects exactly one subject confirmation and requires *that same*
/// confirmation to satisfy every bearer requirement:
///
/// - the bearer method,
/// - `Recipient` equal to this connection's ACS URL,
/// - `NotOnOrAfter` (and `NotBefore` when present) inside the allowed window.
///
/// This mirrors node-saml's `validateSubjectConfirmation` and replaces an
/// earlier split where timing and Recipient could be satisfied by two different
/// (or unsigned) confirmations.
pub(crate) fn subject_confirmation(
    assertion: &Assertion,
    acs_url: &str,
) -> Result<SubjectConfirmationData, orbitid_core::OrbitError> {
    let at = now();
    let limit = max_time_limit(assertion.issue_instant);
    let confirmations = assertion
        .subject
        .as_ref()
        .and_then(|subject| subject.subject_confirmations.as_ref())
        .cloned()
        .unwrap_or_default();
    confirmations
        .iter()
        .find_map(|confirmation| {
            if confirmation.method.as_deref() != Some(BEARER_METHOD) {
                return None;
            }
            let data = confirmation.subject_confirmation_data.as_ref()?;
            let not_on_or_after = data.not_on_or_after?;
            if !timestamps_ok(data.not_before, not_on_or_after, limit, at) {
                return None;
            }
            let recipient = data.recipient.as_deref()?;
            if !same_url(recipient, acs_url) {
                return None;
            }
            Some(data.clone())
        })
        .ok_or_else(|| {
            fail(
                "no valid bearer subject confirmation addressed to this assertion consumer service \
                 was found in the SAML assertion",
            )
        })
}

pub(crate) fn audience_ok(assertion: &Assertion, sp_entity_id: &str) -> bool {
    let Some(conditions) = &assertion.conditions else {
        return false;
    };
    let Some(restrictions) = &conditions.audience_restrictions else {
        return false;
    };
    !restrictions.is_empty()
        && restrictions.iter().all(|restriction| {
            !restriction.audience.is_empty()
                && restriction
                    .audience
                    .iter()
                    .any(|audience| audience == sp_entity_id)
        })
}
