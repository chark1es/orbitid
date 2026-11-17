//! Resource serializers, ported from the retired TypeScript server.
//!
//! Output is the frozen wire contract: snake_case fields, epoch-millisecond
//! timestamps, required-null fields as `null`, TypeScript-optional fields
//! skipped. Every function takes `&AppState` because several shapes include
//! related rows or derived claims.

mod org;
mod session;
mod user;

pub use crate::rbac::permissions_for_role;
pub use org::{
    public_user_data, serialize_membership, serialize_membership_on, serialize_memberships,
    serialize_organization, serialize_organization_on, serialize_organizations,
};
pub use session::{
    serialize_session, serialize_session_on, serialize_sessions, SessionSerializeOptions,
};
pub use user::{
    serialize_email, serialize_external_account, serialize_passkey, serialize_phone,
    serialize_trusted_device, serialize_user, serialize_user_on, serialize_users,
    UserSerializeOptions,
};

use orbitid_core::resources::{VerificationJson, VerificationStatus};

/// `{ status: "verified", strategy, attempts: null, expire_at: null }`.
/// The `at` argument is accepted for parity with `verifiedVerification`.
pub fn verified_verification(strategy: impl Into<String>, _at: Option<i64>) -> VerificationJson {
    verified(strategy)
}

/// `{ status: "unverified", strategy, attempts: 0, expire_at: null }`.
pub fn unverified_verification(strategy: impl Into<String>) -> VerificationJson {
    unverified(strategy)
}

/// `{ status: "verified", strategy, attempts: null, expire_at: null }`.
pub(crate) fn verified(strategy: impl Into<String>) -> VerificationJson {
    VerificationJson {
        status: VerificationStatus::Verified,
        strategy: strategy.into(),
        attempts: None,
        expire_at: None,
        external_verification_redirect_url: None,
        error: None,
        nonce: None,
    }
}

/// `{ status: "unverified", strategy, attempts: 0, expire_at: null }`.
pub(crate) fn unverified(strategy: impl Into<String>) -> VerificationJson {
    VerificationJson {
        status: VerificationStatus::Unverified,
        strategy: strategy.into(),
        attempts: Some(0),
        expire_at: None,
        external_verification_redirect_url: None,
        error: None,
        nonce: None,
    }
}
