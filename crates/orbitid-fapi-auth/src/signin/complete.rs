//! Session completion for sign-in flows: `completeSignIn` and
//! `afterFirstFactor` from `modules/auth/signin-core.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{SignInRow, UserRow};
use orbitid_core::resources::SignInFactor;
use orbitid_core::state::AppState;
use orbitid_credentials::{supported_second_factors, SecondFactorOptions};
use orbitid_identity::sessions::{
    create_session_in_tx, emit_created_session_events_on, CreateSessionInput,
};
use orbitid_identity::trusted_devices::redeem_trusted_device;

use crate::signin::core::{
    as_sign_in_state, reload_sign_in, save_sign_in_state, stale_sign_in, transition_sign_in,
    SignInTransition,
};
use crate::state::{FactorState, SignInState};

/// Options shared by every completion path.
#[derive(Debug, Clone, Default)]
pub struct CompleteOptions {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub second_factor: bool,
    /// Rotate the browser's opaque client token as the session is created.
    pub rotate_client_token: bool,
    /// Passed to the session row (dashboard `auth_method`).
    pub method: Option<String>,
}

pub struct CompletedSignIn {
    pub session_id: String,
    pub client_token: Option<String>,
}

fn method_string(value: orbitid_core::resources::AuthMethod) -> String {
    serde_json::to_value(value)
        .ok()
        .and_then(|value| value.as_str().map(str::to_string))
        .unwrap_or_else(|| "password".to_string())
}

/// Creates the session and marks the sign-in complete.
pub async fn complete_sign_in(
    state: &AppState,
    row: &SignInRow,
    opts: &CompleteOptions,
) -> Result<CompletedSignIn> {
    let mut tx = state.pool.begin().await?;
    // Global lock order: client -> user -> sign_ups -> sign_ins -> sessions.
    // The user lock is taken here, before the sign-in row, because the session
    // creation below locks the user again (and ranks below `sign_ins`).
    sqlx::query("SELECT id FROM clients WHERE id = $1 FOR UPDATE")
        .bind(&row.client_id)
        .fetch_optional(&mut *tx)
        .await?;
    if let Some(user_id) = row.user_id.as_deref() {
        orbitid_identity::locks::lock_user_on(&mut tx, user_id).await?;
    }
    // Claim the attempt atomically before minting anything. The version check
    // (not just the status) means a request that read the row before another
    // writer advanced it cannot complete from stale state. Terminal rows never
    // change again, so exactly one completion can ever succeed.
    let claimed = sqlx::query_as::<_, SignInRow>(
        "UPDATE sign_ins SET status = 'complete', version = version + 1, updated_at = $1 \
         WHERE id = $2 AND version = $3 AND status NOT IN ('complete', 'abandoned') \
         RETURNING *",
    )
    .bind(orbitid_core::http::now())
    .bind(&row.id)
    .bind(row.version)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(claimed) = claimed else {
        // Release the connection before reloading, so this works on a pool of
        // one; the error text distinguishes an already-complete attempt from a
        // stale one exactly like every other sign-in writer.
        tx.rollback().await?;
        return Err(stale_sign_in(state, &row.id).await);
    };
    let Some(user_id) = claimed.user_id.clone() else {
        tx.rollback().await?;
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "Cannot complete a sign-in without a user",
        ));
    };
    // Everything below is taken from the locked/claimed row: the factors that
    // were actually verified are the ones stored on the row this transaction
    // owns, never a caller snapshot that another writer could have advanced.
    let sign_in_state = as_sign_in_state(&claimed);
    let method = opts.method.clone().or_else(|| {
        orbitid_core::http::auth_method::auth_method_of(
            sign_in_state
                .first
                .as_ref()
                .map(|first| first.strategy.as_str()),
        )
        .map(method_string)
    });
    let created = create_session_in_tx(
        state,
        &mut tx,
        CreateSessionInput {
            client_id: claimed.client_id.clone(),
            user_id,
            ip: opts.ip.clone(),
            user_agent: opts.user_agent.clone(),
            max_lifetime_seconds: None,
            first_factor: true,
            second_factor: opts.second_factor,
            method,
            rotate_client_token: opts.rotate_client_token,
        },
    )
    .await?;
    let mut next = sign_in_state;
    if opts.second_factor {
        let mut second = next
            .second
            .clone()
            .unwrap_or_else(|| FactorState::new("totp"));
        second.status = Some("verified".into());
        next.second = Some(second);
    }
    let json = serde_json::to_value(&next).unwrap_or_default();
    let updated = sqlx::query(
        "UPDATE sign_ins SET created_session_id = $1, state = $2, version = version + 1, \
         updated_at = $3 WHERE id = $4 AND version = $5",
    )
    .bind(&created.id)
    .bind(sqlx::types::Json(&json))
    .bind(orbitid_core::http::now())
    .bind(&row.id)
    .bind(claimed.version)
    .execute(&mut *tx)
    .await?;
    if updated.rows_affected() == 0 {
        tx.rollback().await?;
        return Err(stale_sign_in(state, &row.id).await);
    }
    // The session event rows commit with the completed sign-in; a delivery
    // failure later is the worker's concern, never a rolled-back change.
    emit_created_session_events_on(&mut tx, state, &created).await?;
    tx.commit().await?;
    Ok(CompletedSignIn {
        session_id: created.id,
        client_token: created.client_token,
    })
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AfterFirstStatus {
    NeedsSecondFactor,
    Complete,
    NeedsSignIn,
}

#[derive(Clone, Default)]
pub struct AfterFirstFactorResult {
    pub status: Option<AfterFirstStatus>,
    pub session_id: Option<String>,
    pub client_token: Option<String>,
    pub trusted_device_token: Option<String>,
    pub trusted_device_expires_at: Option<i64>,
    pub clear_trusted_device: bool,
}

impl std::fmt::Debug for AfterFirstFactorResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AfterFirstFactorResult")
            .field("status", &self.status)
            .field("session_id", &self.session_id)
            .field("client_token", &"<redacted>")
            .field("trusted_device_token", &"<redacted>")
            .field("trusted_device_expires_at", &self.trusted_device_expires_at)
            .field("clear_trusted_device", &self.clear_trusted_device)
            .finish()
    }
}

impl AfterFirstFactorResult {
    pub(crate) fn of(status: AfterFirstStatus) -> Self {
        Self {
            status: Some(status),
            ..Default::default()
        }
    }
}

/// Second factors available for a given first factor (pure read).
pub(crate) async fn second_factor_options_for(
    state: &AppState,
    user: &UserRow,
    current: &SignInState,
) -> Result<Vec<SignInFactor>> {
    supported_second_factors(state, user, second_factor_options(current)).await
}

/// Every second factor the user could perform (used to decide whether an
/// MFA-required instance counts the user as enrolled).
pub(crate) async fn all_second_factors(
    state: &AppState,
    user: &UserRow,
) -> Result<Vec<SignInFactor>> {
    supported_second_factors(state, user, SecondFactorOptions::default()).await
}

fn second_factor_options(state: &SignInState) -> SecondFactorOptions {
    SecondFactorOptions {
        first_factor_strategy: state.first.as_ref().map(|first| first.strategy.clone()),
        first_factor_email_id: state
            .first
            .as_ref()
            .and_then(|first| first.email_id.clone()),
        first_factor_phone_id: state
            .first
            .as_ref()
            .and_then(|first| first.phone_id.clone()),
    }
}

async fn pending_second_factor(
    state: &AppState,
    row: &SignInRow,
    user: &UserRow,
    current: &SignInState,
    factors: &[SignInFactor],
) -> Result<()> {
    let preferred = factors
        .iter()
        .find(|factor| factor.default == Some(true))
        .or_else(|| factors.iter().find(|factor| factor.strategy == "totp"))
        .or_else(|| factors.first());
    let mut next = current.clone();
    next.second = preferred.map(|factor| FactorState {
        strategy: factor.strategy.clone(),
        phone_id: factor.phone_number_id.clone(),
        status: Some("unverified".into()),
        ..Default::default()
    });
    transition_sign_in(
        state,
        row,
        SignInTransition {
            status: Some("needs_second_factor"),
            state: Some(&next),
            user_id: Some(&user.id),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

/// Decides between `needs_second_factor` and a completed session after a first
/// factor succeeded. A valid trusted-device token skips the second factor.
pub async fn after_first_factor(
    state: &AppState,
    row: &SignInRow,
    user: &UserRow,
    opts: &CompleteOptions,
    trusted_device_token: Option<&str>,
) -> Result<AfterFirstFactorResult> {
    let current = as_sign_in_state(row);
    let factors = supported_second_factors(state, user, second_factor_options(&current)).await?;
    if !factors.is_empty() {
        let settings = state.settings.get();
        if settings.session.trusted_devices_enabled {
            if let Some(token) = trusted_device_token.filter(|token| !token.is_empty()) {
                let enrolled = user.totp_verified
                    || !supported_second_factors(state, user, SecondFactorOptions::default())
                        .await?
                        .is_empty();
                let honored = !settings.mfa.required || enrolled;
                let redeemed = if honored {
                    redeem_trusted_device(state, token, &user.id).await?
                } else {
                    None
                };
                if let Some((device, rotated)) = redeemed {
                    let mut next = current.clone();
                    next.second = Some(FactorState {
                        strategy: "trusted_device".into(),
                        status: Some("verified".into()),
                        trusted_device_id: Some(device.id.clone()),
                        ..Default::default()
                    });
                    save_sign_in_state(state, row, &next).await?;
                    let fresh = reload_sign_in(state, &row.id).await?;
                    let completed = complete_sign_in(
                        state,
                        &fresh,
                        &CompleteOptions {
                            second_factor: true,
                            ..opts.clone()
                        },
                    )
                    .await?;
                    return Ok(AfterFirstFactorResult {
                        status: Some(AfterFirstStatus::Complete),
                        session_id: Some(completed.session_id),
                        client_token: completed.client_token,
                        trusted_device_token: Some(rotated),
                        trusted_device_expires_at: Some(device.expires_at),
                        clear_trusted_device: false,
                    });
                }
                if !honored {
                    pending_second_factor(state, row, user, &current, &factors).await?;
                    return Ok(AfterFirstFactorResult::of(
                        AfterFirstStatus::NeedsSecondFactor,
                    ));
                }
                pending_second_factor(state, row, user, &current, &factors).await?;
                return Ok(AfterFirstFactorResult {
                    clear_trusted_device: true,
                    ..AfterFirstFactorResult::of(AfterFirstStatus::NeedsSecondFactor)
                });
            }
        }
        pending_second_factor(state, row, user, &current, &factors).await?;
        return Ok(AfterFirstFactorResult::of(
            AfterFirstStatus::NeedsSecondFactor,
        ));
    }
    // No factor remains after excluding the first factor's channel. A recovery
    // mailbox must not also stand in for the second factor.
    let settings = state.settings.get();
    let recovery_first = current
        .first
        .as_ref()
        .map(|first| first.strategy.starts_with("reset_password"))
        .unwrap_or(false);
    if settings.mfa.required
        && recovery_first
        && !supported_second_factors(state, user, SecondFactorOptions::default())
            .await?
            .is_empty()
    {
        return Ok(AfterFirstFactorResult::of(AfterFirstStatus::NeedsSignIn));
    }
    let completed = complete_sign_in(state, row, opts).await?;
    Ok(AfterFirstFactorResult {
        status: Some(AfterFirstStatus::Complete),
        session_id: Some(completed.session_id),
        client_token: completed.client_token,
        ..Default::default()
    })
}

/// Marks a sign-in as abandoned (`abandonPrevious`) for the given statuses.
pub async fn abandon_sign_ins_with_status(
    state: &AppState,
    client_id: &str,
    status: &str,
) -> Result<()> {
    sqlx::query(
        "UPDATE sign_ins SET status = 'abandoned', version = version + 1, updated_at = $1 \
         WHERE client_id = $2 AND status = $3",
    )
    .bind(orbitid_core::http::now())
    .bind(client_id)
    .bind(status)
    .execute(&state.pool)
    .await?;
    Ok(())
}

/// Marks the sign-in's first factor verified and stores the verification id.
pub async fn mark_first_verified(
    state: &AppState,
    row: &SignInRow,
    strategy: &str,
    verification_id: Option<&str>,
) -> Result<SignInRow> {
    let mut next = as_sign_in_state(row);
    let mut first = next
        .first
        .clone()
        .unwrap_or_else(|| FactorState::new(strategy));
    first.strategy = strategy.to_string();
    first.status = Some("verified".into());
    if let Some(id) = verification_id {
        first.verification_id = Some(id.to_string());
    }
    next.first = Some(first);
    let saved = transition_sign_in(
        state,
        row,
        SignInTransition {
            status: Some(&row.status),
            state: Some(&next),
            ..Default::default()
        },
    )
    .await?;
    Ok(saved)
}
