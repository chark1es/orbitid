//! Post-bootstrap setup for the identity layer, called once after
//! `orbitid_core::state::create_context`.
//!
//! Order matters and mirrors `bootstrap.ts` + `index.ts`: install the
//! per-state services, seed RBAC, prove the signing keys are readable with this
//! process's encryption key, register the operator-session hook, and (in a
//! server, not in tests) start the guest-cleanup worker.

use orbitid_core::error::Result;
use orbitid_core::state::AppState;
use orbitid_credentials::keys::assert_signing_keys_readable;
use orbitid_platform::captcha::captcha_service;
use orbitid_platform::mail::mailer;

use crate::anonymous::{start_anonymous_cleanup_worker, AnonymousCleanupWorker};
use crate::operator_session::install_operator_session_checker;
use crate::orgs::seed_rbac;
use crate::retention::{start_retention_worker, RetentionWorker};

/// Handles for background workers started by [`install`]. Dropping a handle
/// aborts its task; the server keeps them for the process lifetime.
#[derive(Debug, Default)]
pub struct InstallHandles {
    pub anonymous_cleanup: Option<AnonymousCleanupWorker>,
    pub retention: Option<RetentionWorker>,
    pub enrollment: Option<crate::orgs::EnrollmentWorker>,
}

impl InstallHandles {
    /// Stops every worker immediately (tests and graceful shutdown).
    pub fn shutdown(&self) {
        if let Some(worker) = &self.anonymous_cleanup {
            worker.abort();
        }
        if let Some(worker) = &self.retention {
            worker.abort();
        }
        if let Some(worker) = &self.enrollment {
            worker.abort();
        }
    }
}

/// Full install: services, seed, key check, operator hook, workers.
pub async fn install(state: &AppState) -> Result<InstallHandles> {
    install_with(state, true).await
}

/// Install without starting background workers (test states, short-lived
/// tools). Everything else is identical.
pub async fn install_without_workers(state: &AppState) -> Result<InstallHandles> {
    install_with(state, false).await
}

async fn install_with(state: &AppState, start_workers: bool) -> Result<InstallHandles> {
    // Install the mail/SMS outbox and captcha service once on this state.
    let _ = mailer(state);
    let _ = captcha_service(state);
    seed_rbac(state).await?;
    assert_signing_keys_readable(state).await?;
    install_operator_session_checker(state);
    let anonymous_cleanup = if start_workers {
        Some(start_anonymous_cleanup_worker(
            state.clone(),
            crate::anonymous::ANONYMOUS_CLEANUP_INTERVAL_MS,
        ))
    } else {
        None
    };
    let retention = if start_workers {
        Some(start_retention_worker(
            state.clone(),
            state.env.retention_interval_ms,
        ))
    } else {
        None
    };
    let enrollment = if start_workers {
        Some(crate::orgs::start_enrollment_worker(
            state.clone(),
            state.env.enrollment_interval_ms,
        ))
    } else {
        None
    };
    Ok(InstallHandles {
        anonymous_cleanup,
        retention,
        enrollment,
    })
}
