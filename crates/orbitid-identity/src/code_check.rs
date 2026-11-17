//! The per-code attempt check shared by every verification surface.
//!
//! A refused code is an *application* outcome ([`CodeCheck::Refused`]); a
//! database failure is the `Err` of the surrounding `Result`. That distinction
//! is what lets a caller commit the attempt counter of a refusal while rolling
//! back (and never remembering) anything that failed in the database.

use crate::verifications::{get_verification_by_id_on, is_expired};
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::VerificationRow;
use orbitid_core::state::AppState;

/// An application refusal of a code check (wrong, expired, too many attempts).
///
/// `counted` carries the id of the verification whose attempt counter this
/// check **executed an increment for**; it is `None` when the refusal happened
/// before any increment (expired, already exhausted, replay of a committed
/// attempt). A database failure is never a refusal: it is the `Err` of the
/// surrounding [`Result`], and the caller must roll back and propagate it.
#[derive(Debug)]
pub struct CodeRefusal {
    pub error: OrbitError,
    pub counted: Option<String>,
}

/// Outcome of [`check_code_on`].
#[derive(Debug)]
pub enum CodeCheck {
    Verified(VerificationRow),
    Refused(CodeRefusal),
}

impl CodeCheck {
    /// Collapses a refusal into its error. Only for callers that never share a
    /// transaction with the check (it does not commit or mark anything).
    pub fn into_result(self) -> Result<VerificationRow> {
        match self {
            CodeCheck::Verified(row) => Ok(row),
            CodeCheck::Refused(refusal) => Err(refusal.error),
        }
    }
}

fn refused(error: OrbitError, counted: Option<&str>) -> Result<CodeCheck> {
    Ok(CodeCheck::Refused(CodeRefusal {
        error,
        counted: counted.map(str::to_string),
    }))
}

/// The one place a refused code check is made durable: commits `tx` (so the
/// attempt counter survives the refusal) and only then remembers it for a
/// whole-request replay. A database error during the commit propagates without
/// marking. Every statement that ran in `tx` before this call succeeded (a
/// database failure is propagated, dropping `tx`, before reaching here), so
/// the commit really commits and the memo can never describe a rolled-back
/// increment. Returns the refusal error for the caller to return.
pub async fn commit_code_refusal(
    tx: sqlx::Transaction<'_, sqlx::Postgres>,
    refusal: CodeRefusal,
) -> Result<OrbitError> {
    tx.commit().await?;
    if let Some(id) = &refusal.counted {
        orbitid_core::http::replay::mark_code_attempt_committed(id);
    }
    Ok(refusal.error)
}

/// Verifies a code on a pooled connection (the statement auto-commits, so a
/// refusal is remembered for a whole-request replay).
pub async fn check_code(
    state: &AppState,
    row: Option<&VerificationRow>,
    code: Option<&str>,
) -> Result<VerificationRow> {
    let mut conn = state.pool.acquire().await?;
    match check_code_on(&mut conn, state, row, code).await? {
        CodeCheck::Verified(row) => Ok(row),
        CodeCheck::Refused(refusal) => {
            if let Some(id) = &refusal.counted {
                orbitid_core::http::replay::mark_code_attempt_committed(id);
            }
            Err(refusal.error)
        }
    }
}

/// [`check_code`] on a caller-owned connection. Marking the row verified is a
/// compare-and-set, so concurrent correct submissions produce one transition.
pub async fn check_code_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    row: Option<&VerificationRow>,
    code: Option<&str>,
) -> Result<CodeCheck> {
    let Some(row) = row else {
        return refused(
            OrbitError::unprocessable(
                error_codes::FORM_CODE_INCORRECT,
                "There is no pending verification to check",
            ),
            None,
        );
    };
    let now_ms = now();
    if row.verified_at.is_some() && row.consumed_at.is_some() {
        // Already consumed: a retry observes success, it does not transition.
        return Ok(CodeCheck::Verified(row.clone()));
    }
    if is_expired(row) {
        return refused(expired_error(), None);
    }
    if row.attempts >= row.max_attempts {
        return refused(too_many_error(), None);
    }
    // A replayed request must not count the same wrong guess twice. The earlier
    // attempt committed the increment (the memo is only written after a real
    // commit) and then hit a retryable conflict later; refuse with the same
    // error without incrementing again. A previous TOO_MANY or expired refusal
    // is caught by the checks above and stays the same anyway.
    if orbitid_core::http::replay::is_replay()
        && orbitid_core::http::replay::code_attempt_committed(&row.id)
    {
        return refused(incorrect_error(), None);
    }
    let claimed = sqlx::query_as::<_, VerificationRow>(
        "UPDATE verifications SET attempts = attempts + 1 \
         WHERE id = $1 AND attempts < max_attempts AND expires_at > $2 RETURNING *",
    )
    .bind(&row.id)
    .bind(now_ms)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(claimed) = claimed else {
        // The conditional UPDATE matched nothing: no increment was executed.
        let current = get_verification_by_id_on(conn, &row.id).await?;
        if current.as_ref().map(is_expired).unwrap_or(true) {
            return refused(expired_error(), None);
        }
        return refused(too_many_error(), None);
    };
    // From here on an increment has been executed in the caller's transaction.
    let counted = Some(row.id.as_str());
    let trimmed = code.unwrap_or("").trim();
    let ok = !trimmed.is_empty()
        && orbitid_core::crypto::verify_low_entropy(
            &state.env.encryption_key,
            trimmed,
            claimed.code_hash.as_deref(),
        );
    if !ok {
        if claimed.attempts >= claimed.max_attempts {
            return refused(too_many_error(), counted);
        }
        return refused(incorrect_error(), counted);
    }
    let verified = sqlx::query_as::<_, VerificationRow>(
        "UPDATE verifications SET verified_at = $1 \
         WHERE id = $2 AND verified_at IS NULL AND consumed_at IS NULL RETURNING *",
    )
    .bind(now_ms)
    .bind(&claimed.id)
    .fetch_optional(&mut *conn)
    .await?;
    if let Some(verified) = verified {
        return Ok(CodeCheck::Verified(verified));
    }
    // Another request already transitioned this row; a replay observes that
    // success instead of writing `verified_at` a second time.
    let current = get_verification_by_id_on(conn, &claimed.id).await?;
    match current {
        Some(current) if current.verified_at.is_some() => Ok(CodeCheck::Verified(current)),
        _ => refused(expired_error(), counted),
    }
}

fn expired_error() -> OrbitError {
    OrbitError::unprocessable(
        error_codes::VERIFICATION_EXPIRED,
        "That verification code has expired. Request a new one.",
    )
}

fn too_many_error() -> OrbitError {
    OrbitError::unprocessable(
        error_codes::TOO_MANY_ATTEMPTS,
        "Too many incorrect attempts. Request a new code.",
    )
}

fn incorrect_error() -> OrbitError {
    OrbitError::unprocessable(
        error_codes::FORM_CODE_INCORRECT,
        "That verification code is incorrect",
    )
    .with_meta(serde_json::json!({ "param_name": "code" }))
}
