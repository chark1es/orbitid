//! `GET /v1/verify`: the magic-link landing page. Ported from
//! `modules/verify-link.ts`.
//!
//! The link is consumed and the attempt it advances (sign-in first factor or
//! sign-up email verification, including a completion that creates the user and
//! session) is one transaction on one connection: a crash can never burn the
//! link without advancing the attempt, and a committed advance always means the
//! link is spent.

use axum::extract::{RawQuery, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::UserRow;
use orbitid_core::models::{SignInRow, SignUpRow};
use orbitid_core::state::AppState;
use orbitid_credentials::mfa::fapi::supported_second_factors_on;
use orbitid_credentials::SecondFactorOptions;
use orbitid_identity::client_auth::{client_cookie, find_client};
use orbitid_identity::locks;
use orbitid_identity::users::{get_user_by_id_on, CreateUserInput};
use orbitid_identity::verifications::{
    consume_link_on, get_verification_by_id_on, get_verification_by_token,
};

use crate::signin::complete::CompleteOptions;
use crate::signin::core::{
    after_first_factor_on, as_sign_in_state, assert_sign_in_allowed, save_sign_in_state_on,
};
use crate::signup::core::{
    as_sign_up_fields, as_sign_up_verifications, complete_sign_up_on, compute_requirements,
    email_is_verified, phone_is_verified, save_sign_up_on, CompleteSignUpOptions, SignUpPatch,
};
use crate::util::{client_ip, query_map, validate_redirect_url, with_query, Reply};

fn status_to(url: &str, status: &str) -> Reply {
    Reply::redirect(with_query(url, &[("__orbit_status", Some(status))]))
}

pub async fn verify(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(query): RawQuery,
) -> Result<Reply> {
    let query = query_map(query.as_deref());
    let Some(token) = query.get("token") else {
        return Err(
            OrbitError::bad_request(error_codes::FORM_PARAM_MISSING, "token is missing")
                .with_meta(serde_json::json!({ "param_name": "token" })),
        );
    };
    let settings = state.settings.get();
    let home = validate_redirect_url(
        &state,
        query.get("redirect_url").map(String::as_str),
        "redirect_url",
    )?
    .unwrap_or_else(|| settings.application.home_url.clone());
    let Some(row) = get_verification_by_token(&state, token).await? else {
        return Ok(status_to(&home, "failed"));
    };
    let target = row.redirect_url.clone().unwrap_or_else(|| home.clone());
    if row.expires_at <= orbitid_core::http::now() && row.verified_at.is_none() {
        return Ok(status_to(&target, "expired"));
    }
    if row.verified_at.is_some() || row.consumed_at.is_some() {
        return Ok(status_to(&target, "verified"));
    }
    if row.purpose == "sign_in_first_factor" || row.purpose == "sign_up_email" {
        let owner_client = if row.purpose == "sign_in_first_factor" {
            sqlx::query_as::<_, SignInRow>("SELECT * FROM sign_ins WHERE id = $1")
                .bind(&row.owner_id)
                .fetch_optional(&state.pool)
                .await?
                .map(|row| row.client_id)
        } else {
            sqlx::query_scalar::<_, String>("SELECT client_id FROM sign_ups WHERE id = $1")
                .bind(&row.owner_id)
                .fetch_optional(&state.pool)
                .await?
        };
        let client = find_client(&state, &headers).await?;
        let matches = match (&owner_client, &client) {
            (Some(owner), Some(client)) => owner == &client.id,
            _ => false,
        };
        if !matches {
            return Ok(status_to(&target, "different_browser"));
        }
    }
    let mut cookies: Vec<String> = Vec::new();
    // The verification row is consumed (rank 6) before the attempt's client is
    // locked, so resolve and take the client lock (rank 2) first.
    let owner_client_id: Option<String> =
        sqlx::query_scalar("SELECT client_id FROM sign_ins WHERE id = $1")
            .bind(&row.owner_id)
            .fetch_optional(&state.pool)
            .await?
            .or(
                sqlx::query_scalar("SELECT client_id FROM sign_ups WHERE id = $1")
                    .bind(&row.owner_id)
                    .fetch_optional(&state.pool)
                    .await?,
            );
    // `sign_ins.user_id` is written when the first factor identifies the user
    // and set to NULL when that user is deleted, so the id read before the row
    // is locked can be stale. Lock client -> user -> sign_in/sign_up in rank
    // order, then re-read the id under the sign-in lock; if it differs from the
    // one locked, roll back and restart once with the fresh value. A second
    // mismatch means the row keeps moving: fail the link (safe, retryable).
    let mut attempt = 0;
    let (mut tx, owners) = loop {
        attempt += 1;
        let mut tx = state.pool.begin().await?;
        match take_locks(&mut tx, &row, owner_client_id.as_deref()).await {
            Ok(Locked::Ready(owners)) => break (tx, owners),
            Ok(Locked::Restart) => {
                rollback_logged(tx).await;
                if attempt >= 2 {
                    return Ok(status_to(&target, "failed"));
                }
            }
            Err(error) => {
                // Release the locks now: the pooled connection is reused.
                rollback_logged(tx).await;
                return Err(error);
            }
        }
    };
    // The decision above used a snapshot from before the locks. A click that
    // raced this one waited behind the client lock and has consumed the link
    // by now: answer exactly like a repeated click, without advancing again.
    let current = match get_verification_by_id_on(&mut tx, &row.id).await {
        Ok(current) => current,
        Err(error) => {
            rollback_logged(tx).await;
            return Err(error);
        }
    };
    let Some(current) = current else {
        // The verification row vanished under the lock (expired and swept):
        // nothing was verified.
        rollback_logged(tx).await;
        return Ok(status_to(&target, "failed"));
    };
    if current.verified_at.is_some() || current.consumed_at.is_some() {
        rollback_logged(tx).await;
        return Ok(status_to(&target, "verified"));
    }
    if consume_link_on(&mut tx, &row).await.is_err() {
        rollback_logged(tx).await;
        return Ok(status_to(&target, "failed"));
    }
    let advanced = advance(&mut tx, &state, &headers, &row, &owners, &mut cookies).await;
    let post_commit = match advanced {
        Ok(post_commit) => {
            tx.commit().await?;
            post_commit
        }
        Err(error) => {
            tracing::warn!(flow_id = %row.owner_id, error = %error.message, "verify link could not advance its flow");
            rollback_logged(tx).await;
            return Ok(status_to(&target, "failed"));
        }
    };
    // Post-commit, best-effort: verified-email organisation enrolment for a
    // sign-up completed by clicking this link.
    if let Some((user, input)) = post_commit {
        let _ = orbitid_identity::users::after_user_created(&state, &user, &input).await;
    }
    Ok(status_to(&target, "verified").cookies(cookies))
}

/// A rollback failure must not turn the status redirect into a 500: the
/// connection is discarded by the pool and the outcome is already decided.
async fn rollback_logged(tx: sqlx::Transaction<'_, sqlx::Postgres>) {
    if let Err(error) = tx.rollback().await {
        tracing::warn!("[verify_link] rollback failed: {error}");
    }
}

enum Locked {
    /// The claim-owner users locked for a sign-up link (empty otherwise).
    Ready(Option<Vec<String>>),
    Restart,
}

/// Takes client -> user -> attempt locks in rank order and re-reads the sign-in's
/// user under them; `Restart` when it moved. The caller rolls back on every
/// non-`Ready` outcome.
async fn take_locks(
    tx: &mut sqlx::PgConnection,
    row: &orbitid_core::models::VerificationRow,
    owner_client_id: Option<&str>,
) -> Result<Locked> {
    if let Some(client_id) = owner_client_id {
        locks::lock_client_on(tx, client_id).await?;
    }
    // Rank 3/4/5 before the verification write (rank 6): the owner's user and
    // attempt row are locked first, exactly as `advance` and the attempt routes
    // take them.
    if row.purpose == "sign_in_first_factor" {
        let locked_user: Option<String> =
            sqlx::query_scalar("SELECT user_id FROM sign_ins WHERE id = $1")
                .bind(&row.owner_id)
                .fetch_optional(&mut *tx)
                .await?
                .flatten();
        if let Some(user_id) = &locked_user {
            locks::lock_user_on(tx, user_id).await?;
        }
        locks::lock_sign_in_on(tx, &row.owner_id).await?;
        let current: Option<String> =
            sqlx::query_scalar("SELECT user_id FROM sign_ins WHERE id = $1")
                .bind(&row.owner_id)
                .fetch_optional(&mut *tx)
                .await?
                .flatten();
        if current != locked_user {
            return Ok(Locked::Restart);
        }
        return Ok(Locked::Ready(None));
    }
    if row.purpose == "sign_up_email" {
        // The link verifies `row.identifier`; completion then purges other
        // users' unverified claims on it. Lock those owners (rank 3) before the
        // sign-up row (rank 4); `advance` refuses if the email moved.
        let owners =
            orbitid_identity::users::lock_unverified_claim_owners_on(tx, &row.identifier, "", &[])
                .await?;
        locks::lock_sign_up_on(tx, &row.owner_id).await?;
        return Ok(Locked::Ready(Some(owners)));
    }
    Ok(Locked::Ready(None))
}

async fn advance(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    headers: &HeaderMap,
    row: &orbitid_core::models::VerificationRow,
    owners: &Option<Vec<String>>,
    cookies: &mut Vec<String>,
) -> Result<Option<(UserRow, CreateUserInput)>> {
    if row.purpose == "sign_in_first_factor" {
        // Global lock order: client before the attempt row.
        if let Some(client_id) =
            sqlx::query_scalar::<_, String>("SELECT client_id FROM sign_ins WHERE id = $1")
                .bind(&row.owner_id)
                .fetch_optional(&mut *conn)
                .await?
        {
            locks::lock_client_on(conn, &client_id).await?;
        }
        locks::lock_sign_in_on(conn, &row.owner_id).await?;
        let sign_in = sqlx::query_as::<_, SignInRow>("SELECT * FROM sign_ins WHERE id = $1")
            .bind(&row.owner_id)
            .fetch_optional(&mut *conn)
            .await?;
        let Some(sign_in) = sign_in else {
            return Ok(None);
        };
        if sign_in.status == "complete" || sign_in.status == "abandoned" {
            return Ok(None);
        }
        let Some(user_id) = sign_in.user_id.clone() else {
            return Ok(None);
        };
        let Some(user) = get_user_by_id_on(conn, &user_id).await? else {
            return Ok(None);
        };
        assert_sign_in_allowed(&user)?;
        // Pure reads, computed before any write in this transaction.
        let factors =
            supported_second_factors_on(conn, state, &user, SecondFactorOptions::default()).await?;
        let enrolled = !factors.is_empty();
        let mut next = as_sign_in_state(&sign_in);
        next.first = Some(crate::state::FactorState {
            strategy: row.strategy.clone(),
            status: Some("verified".into()),
            verification_id: Some(row.id.clone()),
            ..Default::default()
        });
        let fresh = save_sign_in_state_on(conn, &sign_in, &next).await?;
        let result = after_first_factor_on(
            conn,
            state,
            &fresh,
            &user,
            &CompleteOptions {
                ip: Some(client_ip(state, headers)),
                user_agent: headers
                    .get("user-agent")
                    .and_then(|value| value.to_str().ok())
                    .map(str::to_string),
                second_factor: false,
                rotate_client_token: true,
                method: None,
            },
            None,
            &factors,
            enrolled,
        )
        .await?;
        if let Some(token) = result.client_token {
            cookies.push(client_cookie(headers, state, &token));
        }
        return Ok(None);
    }
    if row.purpose == "sign_up_email" {
        // Global lock order: client before the attempt row.
        if let Some(client_id) =
            sqlx::query_scalar::<_, String>("SELECT client_id FROM sign_ups WHERE id = $1")
                .bind(&row.owner_id)
                .fetch_optional(&mut *conn)
                .await?
        {
            locks::lock_client_on(conn, &client_id).await?;
        }
        locks::lock_sign_up_on(conn, &row.owner_id).await?;
        let sign_up = sqlx::query_as::<_, SignUpRow>("SELECT * FROM sign_ups WHERE id = $1")
            .bind(&row.owner_id)
            .fetch_optional(&mut *conn)
            .await?;
        let Some(sign_up) = sign_up else {
            return Ok(None);
        };
        if sign_up.status == "complete" || sign_up.status == "abandoned" {
            return Ok(None);
        }
        let verifications = as_sign_up_verifications(&sign_up);
        let current = verifications.email_address.clone();
        let matches = as_sign_up_fields(&sign_up).email_address.as_deref()
            == Some(row.identifier.as_str())
            && current
                .as_ref()
                .and_then(|snapshot| snapshot.verification_id.clone())
                == Some(row.id.clone());
        if !matches {
            return Err(OrbitError::unprocessable(
                error_codes::VERIFICATION_FAILED,
                "This link does not belong to this sign-up",
            ));
        }
        let mut snapshot = current.unwrap_or_default();
        snapshot.status = "verified".into();
        snapshot.strategy = row.strategy.clone();
        snapshot.verification_id = Some(row.id.clone());
        let saved = save_sign_up_on(
            conn,
            &sign_up,
            SignUpPatch {
                verifications: Some(crate::state::SignUpVerifications {
                    email_address: Some(snapshot),
                    ..verifications
                }),
                ..Default::default()
            },
        )
        .await?;
        let fields = as_sign_up_fields(&saved);
        let verifications = as_sign_up_verifications(&saved);
        let requirements = compute_requirements(state, &fields, &verifications);
        let email_ok = email_is_verified(&fields, &verifications);
        let phone_ok = phone_is_verified(&fields, &verifications);
        if requirements.missing_fields.is_empty()
            && requirements.unverified_fields.is_empty()
            && (email_ok || phone_ok || fields.external_account.is_some())
        {
            let (completed, user_input) = complete_sign_up_on(
                conn,
                state,
                &saved,
                &CompleteSignUpOptions {
                    ip: Some(client_ip(state, headers)),
                    user_agent: headers
                        .get("user-agent")
                        .and_then(|value| value.to_str().ok())
                        .map(str::to_string),
                    rotate_client_token: true,
                },
                owners.as_deref(),
            )
            .await?;
            if let Some(token) = completed.client_token {
                cookies.push(client_cookie(headers, state, &token));
            }
            return Ok(Some((completed.user, user_input)));
        } else {
            save_sign_up_on(
                conn,
                &saved,
                SignUpPatch {
                    status: Some("missing_requirements".into()),
                    ..Default::default()
                },
            )
            .await?;
        }
    }
    Ok(None)
}
