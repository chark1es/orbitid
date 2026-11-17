//! External-identity sign-in completion on one connection.
//!
//! Linking the account and completing (or deferring) the sign-in is one
//! transaction: a rolled-back callback leaves the account unlinked, and every
//! committed link comes with its session or its `needs_second_factor` state.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{SignInRow, UserRow};
use orbitid_core::state::AppState;
use orbitid_identity::enterprise_access::sync_enterprise_user_attributes;
use orbitid_identity::external_identity::{link_external_account_on, ExternalProfile};

use crate::external::{
    sign_in_strategy_for, status_url, ExternalIdentityFlow, ExternalIdentityResult,
};
use crate::signin::complete::CompleteOptions;
use crate::signin::core::{
    after_first_factor_on, as_sign_in_state, assert_sign_in_allowed, transition_sign_in_on,
    SignInTransition,
};

/// Inserts a new sign-in on the caller's connection and reloads it there.
pub(crate) async fn new_sign_in_on(
    conn: &mut sqlx::PgConnection,
    flow: &ExternalIdentityFlow,
    identifier: Option<&str>,
    user_id: Option<&str>,
    first_strategy: Option<&str>,
) -> Result<SignInRow> {
    let now = now();
    let id = new_id(id_prefix::SIGN_IN);
    let state_json = match first_strategy {
        Some(strategy) => serde_json::json!({
            "first": { "strategy": strategy, "status": "verified" },
        }),
        None => serde_json::json!({}),
    };
    sqlx::query(
        "INSERT INTO sign_ins (id, client_id, status, identifier, user_id, state, abandon_at, created_at, updated_at) \
         VALUES ($1,$2,'needs_first_factor',$3,$4,$5,$6,$7,$7)",
    )
    .bind(&id)
    .bind(&flow.client_id)
    .bind(identifier)
    .bind(user_id)
    .bind(sqlx::types::Json(state_json))
    .bind(now + 86_400_000)
    .bind(now)
    .execute(&mut *conn)
    .await?;
    sqlx::query_as::<_, SignInRow>("SELECT * FROM sign_ins WHERE id = $1")
        .bind(&id)
        .fetch_one(&mut *conn)
        .await
        .map_err(OrbitError::from)
}

pub(crate) async fn abandon_other_attempts_on(
    conn: &mut sqlx::PgConnection,
    client_id: &str,
    kind: &str,
    except_id: &str,
) -> Result<()> {
    let now = now();
    if kind == "sign_in" {
        sqlx::query(
            "UPDATE sign_ins SET status = 'abandoned', version = version + 1, updated_at = $1 \
             WHERE client_id = $2 AND id <> $3 AND status NOT IN ('complete','abandoned')",
        )
        .bind(now)
        .bind(client_id)
        .bind(except_id)
        .execute(&mut *conn)
        .await?;
    } else {
        sqlx::query(
            "UPDATE sign_ups SET status = 'abandoned', version = version + 1, updated_at = $1 \
             WHERE client_id = $2 AND id <> $3 AND status NOT IN ('complete','abandoned')",
        )
        .bind(now)
        .bind(client_id)
        .bind(except_id)
        .execute(&mut *conn)
        .await?;
    }
    Ok(())
}

/// Links the external account and completes the sign-in on one connection, so
/// the link and the session (or the `needs_second_factor` transition) commit
/// together. Linking is idempotent, so a retry after a rollback is safe.
pub(crate) async fn link_and_sign_in_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    flow: &ExternalIdentityFlow,
    user: &UserRow,
    profile: &ExternalProfile,
) -> Result<ExternalIdentityResult> {
    assert_sign_in_allowed(user)?;
    // Global lock order: client -> user -> sign_ups -> sign_ins -> sessions.
    sqlx::query("SELECT id FROM clients WHERE id = $1 FOR UPDATE")
        .bind(&flow.client_id)
        .fetch_optional(&mut *conn)
        .await?;
    link_external_account_on(conn, state, &user.id, profile).await?;
    let strategy = sign_in_strategy_for(&profile.provider);
    let owner_id = match &flow.owner_id {
        Some(owner_id) => owner_id.clone(),
        None => {
            new_sign_in_on(
                conn,
                flow,
                profile.email.as_deref(),
                Some(&user.id),
                Some(&strategy),
            )
            .await?
            .id
        }
    };
    let row = sqlx::query_as::<_, SignInRow>("SELECT * FROM sign_ins WHERE id = $1 FOR UPDATE")
        .bind(&owner_id)
        .fetch_optional(&mut *conn)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Sign-in not found")
        })?;
    let mut next = as_sign_in_state(&row);
    next.first = Some(crate::state::FactorState {
        strategy: strategy.clone(),
        status: Some("verified".into()),
        ..Default::default()
    });
    let updated = transition_sign_in_on(
        conn,
        &row,
        SignInTransition {
            state: Some(&next),
            user_id: Some(&user.id),
            identifier: row
                .identifier
                .clone()
                .or_else(|| profile.email.clone())
                .as_deref(),
            ..Default::default()
        },
    )
    .await?;
    // Pure read on the open transaction (no second pool connection): oauth and
    // enterprise first factors exclude no second factor.
    let factors = orbitid_credentials::mfa::fapi::supported_second_factors_on(
        conn,
        state,
        user,
        orbitid_credentials::SecondFactorOptions::default(),
    )
    .await?;
    let enrolled = !factors.is_empty();
    let result = after_first_factor_on(
        conn,
        state,
        &updated,
        user,
        &CompleteOptions {
            ip: None,
            user_agent: None,
            second_factor: false,
            rotate_client_token: false,
            method: None,
        },
        flow.trusted_device_token.as_deref(),
        &factors,
        enrolled,
    )
    .await?;
    abandon_other_attempts_on(conn, &flow.client_id, "sign_in", &updated.id).await?;
    let complete = result.status == Some(crate::signin::complete::AfterFirstStatus::Complete);
    Ok(ExternalIdentityResult {
        redirect_to: status_url(
            &flow.target(),
            if complete {
                "complete"
            } else {
                "needs_second_factor"
            },
        ),
        trusted_device_token: result.trusted_device_token,
        trusted_device_expires_at: result.trusted_device_expires_at,
        clear_trusted_device: result.clear_trusted_device,
    })
}

pub(crate) async fn sign_in_existing_user(
    state: &AppState,
    flow: &ExternalIdentityFlow,
    user: &UserRow,
    profile: &ExternalProfile,
) -> Result<ExternalIdentityResult> {
    sync_enterprise_user_attributes(state, &user.id, profile).await?;
    let mut tx = state.pool.begin().await?;
    let result = link_and_sign_in_on(&mut tx, state, flow, user, profile).await?;
    tx.commit().await?;
    Ok(result)
}

pub(crate) async fn complete_sign_up_for_existing_user(
    state: &AppState,
    flow: &ExternalIdentityFlow,
    sign_up_id: &str,
    user: &UserRow,
    profile: &ExternalProfile,
) -> Result<ExternalIdentityResult> {
    sync_enterprise_user_attributes(state, &user.id, profile).await?;
    let sign_in_flow = ExternalIdentityFlow {
        kind: "sign_in".into(),
        owner_id: None,
        ..flow.clone()
    };
    let mut tx = state.pool.begin().await?;
    // Rank 2 then 3 before the `sign_ups` update (rank 4) and the sign-in flow
    // that follows (which links the account and creates the session).
    orbitid_identity::locks::lock_client_then_user_on(&mut tx, &flow.client_id, &user.id).await?;
    sqlx::query(
        "UPDATE sign_ups SET status = 'abandoned', version = version + 1, updated_at = $1 \
         WHERE id = $2 AND status NOT IN ('complete','abandoned')",
    )
    .bind(now())
    .bind(sign_up_id)
    .execute(&mut *tx)
    .await?;
    let result = link_and_sign_in_on(&mut tx, state, &sign_in_flow, user, profile).await?;
    tx.commit().await?;
    Ok(result)
}
