//! Transactional sign-in transitions and completion.
//!
//! These are the `_on` counterparts of the sign-in state machine: a handler
//! that consumes a verification code, flips the attempt state and completes the
//! session does all of it on one connection, so a crash can never leave the
//! code spent without the attempted transition (or a completed attempt without
//! its session).

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{SignInRow, UserRow};
use orbitid_core::resources::SignInFactor;
use orbitid_core::state::AppState;
use orbitid_identity::sessions::{
    create_session_conn, emit_created_session_events_on, CreateSessionInput,
};
use orbitid_identity::trusted_devices_fapi::redeem_trusted_device_on;

use crate::signin::complete::{
    AfterFirstFactorResult, AfterFirstStatus, CompleteOptions, CompletedSignIn,
};
use crate::signin::core::SignInTransition;
use crate::state::{FactorState, SignInState};

/// A stale writer's error, classified from the same connection (no second pool
/// acquisition inside the caller's transaction).
async fn stale_sign_in_on(conn: &mut sqlx::PgConnection, id: &str) -> OrbitError {
    match sqlx::query_as::<_, SignInRow>("SELECT * FROM sign_ins WHERE id = $1")
        .bind(id)
        .fetch_optional(&mut *conn)
        .await
    {
        Ok(Some(row)) if row.status == "complete" => OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-in is already complete",
        ),
        Ok(Some(_)) => OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-in was updated by another request. Reload and try again.",
        ),
        Ok(None) => OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Sign-in not found"),
        Err(error) => error.into(),
    }
}

/// One guarded (version CAS) write to a sign-in row on the caller's connection.
pub async fn transition_sign_in_on(
    conn: &mut sqlx::PgConnection,
    row: &SignInRow,
    next: SignInTransition<'_>,
) -> Result<SignInRow> {
    // Enforced lock order: every write to `sign_ins` takes the client row first
    // (rank 2 before rank 5). Re-locking a row the transaction already holds is
    // free.
    orbitid_identity::locks::lock_client_on(conn, &row.client_id).await?;
    let json = next
        .state
        .map(|value| serde_json::to_value(value).unwrap_or_default());
    let updated = sqlx::query_as::<_, SignInRow>(
        "UPDATE sign_ins SET status = COALESCE($1, status), \
         state = COALESCE($2::jsonb, state), user_id = COALESCE($3, user_id), \
         identifier = COALESCE($4, identifier), version = version + 1, updated_at = $5 \
         WHERE id = $6 AND version = $7 AND status NOT IN ('complete','abandoned') \
         RETURNING *",
    )
    .bind(next.status)
    .bind(json.map(sqlx::types::Json))
    .bind(next.user_id)
    .bind(next.identifier)
    .bind(orbitid_core::http::now())
    .bind(&row.id)
    .bind(row.version)
    .fetch_optional(&mut *conn)
    .await?;
    match updated {
        Some(row) => Ok(row),
        None => Err(stale_sign_in_on(conn, &row.id).await),
    }
}

/// [`crate::signin::core::save_sign_in_state`] on the caller's connection.
pub async fn save_sign_in_state_on(
    conn: &mut sqlx::PgConnection,
    row: &SignInRow,
    next: &SignInState,
) -> Result<SignInRow> {
    transition_sign_in_on(
        conn,
        row,
        SignInTransition {
            state: Some(next),
            ..Default::default()
        },
    )
    .await
}

/// [`crate::signin::complete::complete_sign_in`] on the caller's connection.
pub async fn complete_sign_in_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    row: &SignInRow,
    opts: &CompleteOptions,
) -> Result<CompletedSignIn> {
    // Global lock order: client -> user -> sign_ups -> sign_ins -> sessions.
    // The user lock comes before the sign-in row: session creation (rank 7)
    // locks the user (rank 3) and must not find the sign-in lock held first.
    sqlx::query("SELECT id FROM clients WHERE id = $1 FOR UPDATE")
        .bind(&row.client_id)
        .fetch_optional(&mut *conn)
        .await?;
    if let Some(user_id) = row.user_id.as_deref() {
        orbitid_identity::locks::lock_user_on(conn, user_id).await?;
    }
    let claimed = sqlx::query_as::<_, SignInRow>(
        "UPDATE sign_ins SET status = 'complete', version = version + 1, updated_at = $1 \
         WHERE id = $2 AND version = $3 AND status NOT IN ('complete', 'abandoned') \
         RETURNING *",
    )
    .bind(orbitid_core::http::now())
    .bind(&row.id)
    .bind(row.version)
    .fetch_optional(&mut *conn)
    .await?;
    let Some(claimed) = claimed else {
        return Err(stale_sign_in_on(conn, &row.id).await);
    };
    let Some(user_id) = claimed.user_id.clone() else {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "Cannot complete a sign-in without a user",
        ));
    };
    let sign_in_state = crate::signin::core::as_sign_in_state(&claimed);
    let method = opts.method.clone().or_else(|| {
        orbitid_core::http::auth_method::auth_method_of(
            sign_in_state
                .first
                .as_ref()
                .map(|first| first.strategy.as_str()),
        )
        .map(|method| {
            serde_json::to_value(method)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_else(|| "password".to_string())
        })
    });
    let created = create_session_conn(
        state,
        conn,
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
    .execute(&mut *conn)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(stale_sign_in_on(conn, &row.id).await);
    }
    emit_created_session_events_on(conn, state, &created).await?;
    Ok(CompletedSignIn {
        session_id: created.id,
        client_token: created.client_token,
    })
}

async fn pending_second_factor_on(
    conn: &mut sqlx::PgConnection,
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
    transition_sign_in_on(
        conn,
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

/// [`crate::signin::complete::after_first_factor`] on the caller's connection.
/// `factors` and `enrolled` must be computed before the transaction opens (they
/// are pure reads); this keeps the state transition and any completion atomic
/// with the first-factor write that preceded them.
#[allow(clippy::too_many_arguments)]
pub async fn after_first_factor_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    row: &SignInRow,
    user: &UserRow,
    opts: &CompleteOptions,
    trusted_device_token: Option<&str>,
    factors: &[SignInFactor],
    enrolled: bool,
) -> Result<AfterFirstFactorResult> {
    let current = crate::signin::core::as_sign_in_state(row);
    let settings = state.settings.get();
    if !factors.is_empty() {
        if settings.session.trusted_devices_enabled {
            if let Some(token) = trusted_device_token.filter(|token| !token.is_empty()) {
                let honored = !settings.mfa.required || enrolled;
                let redeemed = if honored {
                    redeem_trusted_device_on(conn, state, token, &user.id).await?
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
                    let fresh = save_sign_in_state_on(conn, row, &next).await?;
                    let completed = complete_sign_in_on(
                        conn,
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
                pending_second_factor_on(conn, row, user, &current, factors).await?;
                if !honored {
                    return Ok(AfterFirstFactorResult::of(
                        AfterFirstStatus::NeedsSecondFactor,
                    ));
                }
                return Ok(AfterFirstFactorResult {
                    clear_trusted_device: true,
                    ..AfterFirstFactorResult::of(AfterFirstStatus::NeedsSecondFactor)
                });
            }
        }
        pending_second_factor_on(conn, row, user, &current, factors).await?;
        return Ok(AfterFirstFactorResult::of(
            AfterFirstStatus::NeedsSecondFactor,
        ));
    }
    let completed = complete_sign_in_on(conn, state, row, opts).await?;
    Ok(AfterFirstFactorResult {
        status: Some(AfterFirstStatus::Complete),
        session_id: Some(completed.session_id),
        client_token: completed.client_token,
        ..Default::default()
    })
}
