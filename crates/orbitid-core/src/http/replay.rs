//! Per-request state for the request-level transaction retry in
//! `orbitid-server`.
//!
//! A whole-request replay must not repeat a side effect that was already
//! performed by a failed attempt. Three kinds of state are tracked here:
//!
//! * the replay flag itself, set for every attempt after the first;
//! * a memo of single-use provider results (currently the CAPTCHA token) that
//!   succeeded on an earlier attempt, so a replayed request does not submit the
//!   same single-use token to the provider a second time;
//! * a memo of failed-attempt counters that an earlier attempt actually
//!   committed, so a replay skips only a count that is already durable.
//!
//! Everything lives in a task-local scope created for the lifetime of one
//! request (including all of its replay attempts) by
//! [`request_scope`]. It is never shared between requests and never persisted.
//!
//! The only other separately-committed effect on the auth paths is the
//! distributed rate-limit counter ([`crate::http::rate_limit`]), which also
//! checks [`is_replay`] and does not consume a second unit. Everything else with
//! an external effect (mail/SMS, OAuth exchanges, webhooks) is post-commit or is
//! served by a route the retry layer never replays (see `crates/README.md`).

use std::collections::HashSet;
use std::future::Future;
use std::sync::{Arc, Mutex};

tokio::task_local! {
    static REQUEST_REPLAY: bool;
    static REPLAY_MEMO: Arc<ReplayMemo>;
}

#[derive(Default)]
struct ReplayMemo {
    /// CAPTCHA tokens a verifier already accepted during this request.
    captcha_tokens: Mutex<HashSet<String>>,
    /// User ids whose account failed-attempt counter an earlier attempt
    /// committed.
    failed_attempts: Mutex<HashSet<String>>,
    /// Verification ids whose per-code attempt counter an earlier attempt
    /// committed.
    code_attempts: Mutex<HashSet<String>>,
}

fn with_memo<R>(operation: impl FnOnce(&ReplayMemo) -> R) -> Option<R> {
    REPLAY_MEMO.try_with(|memo| operation(memo)).ok()
}

/// Whether the current task is replaying a request after a retryable database
/// conflict.
pub fn is_replay() -> bool {
    REQUEST_REPLAY.try_with(|replay| *replay).unwrap_or(false)
}

/// Runs `future` with the replay flag set to `replay`.
pub async fn scope<F: Future>(replay: bool, future: F) -> F::Output {
    REQUEST_REPLAY.scope(replay, future).await
}

/// Runs one whole request (all of its attempts) with a fresh, request-private
/// memo. Every attempt of that request runs inside this scope; the memo is
/// dropped when the request finishes.
pub async fn request_scope<F: Future>(future: F) -> F::Output {
    REPLAY_MEMO
        .scope(Arc::new(ReplayMemo::default()), future)
        .await
}

/// Remembers that `token` was accepted by the CAPTCHA provider during this
/// request. No-op outside a [`request_scope`].
pub fn remember_captcha_success(token: &str) {
    if token.is_empty() {
        return;
    }
    with_memo(|memo| {
        if let Ok(mut tokens) = memo.captcha_tokens.lock() {
            tokens.insert(token.to_string());
        }
    });
}

/// Whether `token` already succeeded earlier in this request.
pub fn captcha_already_verified(token: &str) -> bool {
    if token.is_empty() {
        return false;
    }
    with_memo(|memo| {
        memo.captcha_tokens
            .lock()
            .map(|tokens| tokens.contains(token))
            .unwrap_or(false)
    })
    .unwrap_or(false)
}

/// Remembers that the failed-attempt counter for `user_id` was committed
/// during this request.
pub fn mark_failed_attempt_committed(user_id: &str) {
    with_memo(|memo| {
        if let Ok(mut users) = memo.failed_attempts.lock() {
            users.insert(user_id.to_string());
        }
    });
}

/// Whether an earlier attempt of this request already committed the
/// failed-attempt counter for `user_id`.
pub fn failed_attempt_committed(user_id: &str) -> bool {
    with_memo(|memo| {
        memo.failed_attempts
            .lock()
            .map(|users| users.contains(user_id))
            .unwrap_or(false)
    })
    .unwrap_or(false)
}

/// Remembers that the per-code attempt counter for `verification_id` was
/// committed during this request.
pub fn mark_code_attempt_committed(verification_id: &str) {
    with_memo(|memo| {
        if let Ok(mut ids) = memo.code_attempts.lock() {
            ids.insert(verification_id.to_string());
        }
    });
}

/// Whether an earlier attempt of this request already committed a per-code
/// attempt count for `verification_id`.
pub fn code_attempt_committed(verification_id: &str) -> bool {
    with_memo(|memo| {
        memo.code_attempts
            .lock()
            .map(|ids| ids.contains(verification_id))
            .unwrap_or(false)
    })
    .unwrap_or(false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_captcha_success_is_memoized_within_one_request_only() {
        request_scope(async {
            assert!(!captcha_already_verified("token"));
            remember_captcha_success("token");
            assert!(captcha_already_verified("token"));
            assert!(!captcha_already_verified("other"));
        })
        .await;
        // A new request starts with an empty memo.
        request_scope(async {
            assert!(!captcha_already_verified("token"));
        })
        .await;
        // Outside a request scope nothing is remembered.
        remember_captcha_success("token");
        assert!(!captcha_already_verified("token"));
    }

    #[tokio::test]
    async fn failed_attempt_marks_follow_the_request_scope() {
        request_scope(async {
            assert!(!failed_attempt_committed("usr_1"));
            mark_failed_attempt_committed("usr_1");
            assert!(failed_attempt_committed("usr_1"));
        })
        .await;
        request_scope(async {
            assert!(!failed_attempt_committed("usr_1"));
        })
        .await;
    }
}
