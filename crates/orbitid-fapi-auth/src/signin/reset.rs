//! Password reset completion. Ported from `modules/sign-in/first-factor.ts`
//! (`reset_password`).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::OrbitJson;
use orbitid_core::models::SignInRow;
use orbitid_core::state::AppState;
use orbitid_identity::client_auth::client_azp;
use orbitid_identity::enterprise_access::assert_additional_identifications_allowed;
use orbitid_identity::grants::revoke_grants_for_user_on;
use orbitid_identity::sessions::end_sessions_for_user_on;
use orbitid_identity::trusted_devices::revoke_all_trusted_devices_on;
use orbitid_identity::users::primary_email;
use orbitid_identity::verifications::get_verification_by_id;
use orbitid_platform::mail::{send_email, EmailTemplate, SendEmailInput};

use crate::signin::complete::AfterFirstStatus;
use crate::signin::core::{
    as_sign_in_state, assert_sign_in_allowed, transition_sign_in, transition_sign_in_on,
    SignInTransition,
};
use crate::signin::helpers::{
    after_first, load_sign_in, open_client, reload, respond_sign_in, user_for_row,
};
use crate::signin::recovery::recovery_factor_from_verification;
use crate::signin::shared::ResetPasswordBody;
use crate::state::FactorState;
use crate::util::Reply;

pub async fn reset_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<ResetPasswordBody>,
) -> Result<Reply> {
    let (password, sign_out, _redirect) = body.validate()?;
    let (client, cookie) = open_client(&state, &headers, "POST", "/v1/client/sign_ins").await?;
    let mut cookies: Vec<String> = cookie.into_iter().collect();
    let azp = client_azp(&headers);
    let row = load_sign_in(&state, &client.id, &id).await?;
    let mut current = as_sign_in_state(&row);
    if row.status != "needs_new_password"
        || row.abandon_at <= orbitid_core::http::now()
        || !current
            .reset_password
            .as_ref()
            .map(|reset| reset.verified)
            .unwrap_or(false)
    {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "Password reset has not been verified",
        ));
    }
    let user = user_for_row(&state, &row).await?;
    assert_sign_in_allowed(&user)?;
    let verification = match current
        .first
        .as_ref()
        .and_then(|first| first.verification_id.clone())
    {
        Some(id) => get_verification_by_id(&state, &id).await?,
        None => None,
    };
    let verification = match &verification {
        Some(verification)
            if verification.purpose
                == orbitid_identity::verifications::purposes::RESET_PASSWORD
                && verification.verified_at.is_some()
                && verification.consumed_at.is_none() =>
        {
            verification.clone()
        }
        _ => {
            return Err(OrbitError::bad_request(
                error_codes::CLIENT_STATE_INVALID,
                "Password reset has not been verified",
            ));
        }
    };
    let recovery = recovery_factor_from_verification(&state, &user, &verification).await?;
    let Some(recovery) = recovery else {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "Password reset has not been verified",
        ));
    };
    if verification.owner_id != row.id
        || current.first.as_ref().map(|first| first.strategy.clone())
            != Some(recovery.strategy.clone())
    {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "Password reset has not been verified",
        ));
    }
    assert_additional_identifications_allowed(&state, &user.id).await?;
    orbitid_credentials::assert_password_valid(&state, &password).await?;
    let password_hash = orbitid_credentials::hash_password(&password).await?;
    let sign_out = sign_out.unwrap_or_else(|| {
        state
            .settings
            .get()
            .password
            .sign_out_of_other_sessions_on_reset
    });
    let now = orbitid_core::http::now();
    // Claim the sign-in first, then burn the one-time verification, both in one
    // transaction. A duplicate request racing this one loses the version CAS and
    // rolls back without consuming the code, so the winner's code is never
    // stolen by a loser.
    let mut tx = state.pool.begin().await?;
    // Global lock order: client -> user -> sign_ins -> sessions.
    sqlx::query("SELECT id FROM clients WHERE id = $1 FOR UPDATE")
        .bind(&row.client_id)
        .fetch_optional(&mut *tx)
        .await?;
    sqlx::query("SELECT id FROM users WHERE id = $1 FOR UPDATE")
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;
    let claimed = sqlx::query_as::<_, SignInRow>(
        "UPDATE sign_ins SET status = 'resetting_password', version = version + 1, \
         updated_at = $1 WHERE id = $2 AND version = $3 AND status = 'needs_new_password' \
         RETURNING *",
    )
    .bind(now)
    .bind(&row.id)
    .bind(row.version)
    .fetch_optional(&mut *tx)
    .await?;
    let Some(claimed) = claimed else {
        tx.rollback().await?;
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "Password reset has not been verified",
        ));
    };
    let consumed = sqlx::query_scalar::<_, String>(
        "UPDATE verifications SET consumed_at = $1 \
         WHERE id = $2 AND consumed_at IS NULL AND verified_at IS NOT NULL RETURNING id",
    )
    .bind(now)
    .bind(&verification.id)
    .fetch_optional(&mut *tx)
    .await?;
    if consumed.is_none() {
        tx.rollback().await?;
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "Password reset has not been verified",
        ));
    }
    sqlx::query(
        "UPDATE users SET password_hash = $1, password_updated_at = $2, failed_attempts = 0, \
         locked = false, lockout_expires_at = NULL, updated_at = $2 WHERE id = $3",
    )
    .bind(&password_hash)
    .bind(now)
    .bind(&user.id)
    .execute(&mut *tx)
    .await?;
    // Recovery is the step an attacker who stole a session is least able to
    // survive: every other session, every OIDC grant (including device-flow
    // grants with no browser session) and every trusted browser is revoked in
    // the same transaction as the password. A failed revocation therefore rolls
    // the password update, the claimed sign-in and the consumed code back
    // together, instead of leaving the attacker's session alive after a
    // successful reset.
    if sign_out {
        end_sessions_for_user_on(&mut tx, &state, &user.id, "revoked", None).await?;
        revoke_grants_for_user_on(&mut tx, &user.id).await?;
    }
    revoke_all_trusted_devices_on(&mut tx, &user.id).await?;
    // The post-reset attempt state commits with the password change. A crash
    // after this transaction can no longer leave the row in
    // `resetting_password` with the new password already stored.
    current.reset_password = None;
    current.first = Some(FactorState {
        strategy: recovery.strategy.clone(),
        status: Some("verified".into()),
        verification_id: Some(verification.id.clone()),
        email_id: recovery.email_id.clone(),
        phone_id: recovery.phone_id.clone(),
        ..Default::default()
    });
    let saved = transition_sign_in_on(
        &mut tx,
        &claimed,
        SignInTransition {
            status: Some("needs_first_factor"),
            state: Some(&current),
            ..Default::default()
        },
    )
    .await?;
    tx.commit().await?;
    // The notification e-mail is sent only after every database step below has
    // committed, so a retryable conflict in the post-reset transition cannot
    // send it twice on a replay.
    let result = after_first(&state, &headers, &saved, &user, &mut cookies).await?;
    if result.status == Some(AfterFirstStatus::NeedsSignIn) {
        let mut next = current.clone();
        next.requested_reset = Some(false);
        next.second = None;
        next.first = Some(FactorState {
            strategy: "password".into(),
            status: Some("unverified".into()),
            error: Some(crate::state::FactorError {
                code: error_codes::NEEDS_SECOND_FACTOR.into(),
                message:
                    "MFA is required. Sign in with your new password to complete a second factor."
                        .into(),
            }),
            ..Default::default()
        });
        transition_sign_in(
            &state,
            &saved,
            SignInTransition {
                status: Some("needs_first_factor"),
                state: Some(&next),
                ..Default::default()
            },
        )
        .await?;
        let fresh = reload(&state, &row.id).await?;
        send_password_changed_email(&state, &user).await;
        return respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await;
    }
    let fresh = reload(&state, &row.id).await?;
    send_password_changed_email(&state, &user).await;
    respond_sign_in(&state, &client, azp.as_deref(), &fresh, cookies).await
}

/// Post-commit, best-effort password-change notification.
async fn send_password_changed_email(state: &AppState, user: &orbitid_core::models::UserRow) {
    if let Ok(Some(email)) = primary_email(state, user).await {
        let mut input = SendEmailInput::new(email.email, EmailTemplate::PasswordChanged);
        if let Some(name) = &user.first_name {
            input
                .vars
                .insert("user_name".into(), serde_json::json!(name));
        }
        let _ = send_email(state, input).await;
    }
}
