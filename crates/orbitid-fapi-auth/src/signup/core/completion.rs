//! Sign-up completion: create the user, session and invitation acceptance in
//! one transaction, with its webhook events in the same outbox.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{SignUpRow, UserRow};
use orbitid_core::state::AppState;
use orbitid_identity::external_identity::ExternalProfile;
use orbitid_identity::restrictions::{emit_invitation_accepted_on, mark_invitation_accepted_on};
use orbitid_identity::sessions::{
    create_session_conn, emit_created_session_events_on, CreateSessionInput,
};
use orbitid_identity::users::{
    after_user_created, create_user_claims_locked_on, emit_user_created_on,
    lock_unverified_claim_owners_on, normalize_email, CreateUserInput,
};

use crate::state::{
    SignUpFields, SignUpVerifications, StashedExternalAccount, VerificationSnapshot,
};

use super::attempts::{is_terminal_sign_up_status, save_sign_up, stale_sign_up_on, SignUpPatch};
use super::serialize::{
    as_sign_up_fields, as_sign_up_verifications, compute_requirements, email_is_verified,
    metadata_object, phone_is_verified, verification_strategy_for,
};

#[derive(Debug, Clone, Default)]
pub struct CompleteSignUpOptions {
    pub ip: Option<String>,
    pub user_agent: Option<String>,
    pub rotate_client_token: bool,
}

pub struct CompletedSignUp {
    pub user: UserRow,
    pub session_id: String,
    pub client_token: Option<String>,
}

/// Creates the user (and session) and marks the sign-up complete.
///
/// The whole completion — user, identifiers, external account, invitation,
/// session, client-token rotation, both attempt statuses and every webhook
/// event (`user.created`, `invitation.accepted`, `session.created`, the
/// single-session `session.ended` rows) — runs on one connection in one
/// transaction. Nothing acquires a second pool connection while the
/// transaction is open, so completion works even on a pool of one. Only
/// verified-email organisation enrolment runs after commit, best-effort: a
/// failure there never turns an already-committed completion into a 500.
pub async fn complete_sign_up(
    state: &AppState,
    row: &SignUpRow,
    opts: &CompleteSignUpOptions,
) -> Result<CompletedSignUp> {
    let mut tx = state.pool.begin().await?;
    let (completed, user_input) = complete_sign_up_on(&mut tx, state, row, opts, None).await?;
    tx.commit().await?;
    // Organisation enrolment after a verified email has its own transactions;
    // a failure there never turns an already-committed completion into a 500.
    if let Err(error) = after_user_created(state, &completed.user, &user_input).await {
        tracing::error!("[signup] post-commit user side effects failed: {error}");
    }
    Ok(completed)
}

/// [`complete_sign_up`] on a caller-owned transaction. The caller commits, then
/// runs [`after_user_created`] with the returned input (post-commit, best
/// effort). Nothing here acquires a second pool connection.
pub async fn complete_sign_up_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    row: &SignUpRow,
    opts: &CompleteSignUpOptions,
    prelocked_owners: Option<&[String]>,
) -> Result<(CompletedSignUp, CreateUserInput)> {
    // Global lock order: client -> user -> sign_ups -> sign_ins -> sessions.
    // The client lock comes first so two concurrent completions of sibling
    // attempts serialize instead of taking their own sign-up row and then each
    // other's (a Postgres deadlock).
    sqlx::query("SELECT id FROM clients WHERE id = $1 FOR UPDATE")
        .bind(&row.client_id)
        .fetch_optional(&mut *conn)
        .await?;
    // A verified email purges other users' unverified claims on it. Those owners
    // are users (rank 3), so they are locked here, ascending, from a plain read
    // of the snapshot the caller validated, BEFORE the sign-up row (rank 4). The
    // version check below proves the locked row still carries the same email.
    let snapshot_fields = as_sign_up_fields(row);
    let claim_owners = match snapshot_fields.email_address.as_deref() {
        Some(email) if email_is_verified(&snapshot_fields, &as_sign_up_verifications(row)) => {
            // A caller that already holds the sign-up row (rank 4) locked the
            // owners (rank 3) itself, before that row, and passes them in.
            match prelocked_owners {
                Some(owners) => Some(owners.to_vec()),
                None => Some(lock_unverified_claim_owners_on(&mut *conn, email, "", &[]).await?),
            }
        }
        _ => None,
    };
    // Lock the row for the whole completion. A second concurrent completion
    // waits here, then observes `complete` and fails before it can create
    // another user/session.
    let locked = sqlx::query_as::<_, SignUpRow>("SELECT * FROM sign_ups WHERE id = $1 FOR UPDATE")
        .bind(&row.id)
        .fetch_optional(&mut *conn)
        .await?;
    let Some(current) = locked else {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Sign-up not found",
        ));
    };
    // The caller validated a *specific snapshot*. Another request may have
    // changed the email (clearing its verification), the password or the legal
    // consent between that validation and this lock. Completing from the newer
    // row would create a session for requirements nobody checked; completing
    // from the older data would resurrect overwritten fields. Refuse instead and
    // let the client reload.
    if current.version != row.version {
        return Err(stale_sign_up_on(conn, &row.id).await);
    }
    if is_terminal_sign_up_status(&current.status) {
        return Err(OrbitError::bad_request(
            error_codes::CLIENT_STATE_INVALID,
            "This sign-up is already complete",
        ));
    }
    let fields = as_sign_up_fields(&current);
    let verifications = as_sign_up_verifications(&current);
    let email_verified = email_is_verified(&fields, &verifications);
    let phone_verified = phone_is_verified(&fields, &verifications);
    let email_strategy = verifications
        .email_address
        .as_ref()
        .map(|snapshot| snapshot.strategy.clone())
        .or_else(|| {
            verifications
                .external_account
                .as_ref()
                .map(|snapshot| snapshot.strategy.clone())
        })
        .unwrap_or_else(|| "email_code".to_string());
    let user_input = CreateUserInput {
        email: fields.email_address.clone(),
        phone: fields.phone_number.clone(),
        username: fields.username.clone(),
        first_name: fields.first_name.clone(),
        last_name: fields.last_name.clone(),
        password_hash: fields.password_hash.clone(),
        external_id: fields.external_id.clone(),
        email_verified,
        phone_verified,
        email_verified_strategy: Some(email_strategy),
        unsafe_metadata: Some(metadata_object(&current.unsafe_metadata.0)),
        legal_accepted_at: fields.legal_accepted_at,
        is_anonymous: fields.anonymous.unwrap_or(false),
        ..Default::default()
    };
    let user =
        create_user_claims_locked_on(state, &mut *conn, &user_input, claim_owners.as_deref())
            .await?;

    if let Some(ext) = &fields.external_account {
        let existing: Option<String> = sqlx::query_scalar(
            "SELECT id FROM external_accounts WHERE provider = $1 AND provider_user_id = $2",
        )
        .bind(&ext.provider)
        .bind(&ext.provider_user_id)
        .fetch_optional(&mut *conn)
        .await?;
        if existing.is_none() {
            let now = now();
            sqlx::query(
                "INSERT INTO external_accounts (id, user_id, provider, provider_user_id, email_address, \
                 first_name, last_name, username, image_url, approved_scopes, access_token_enc, \
                 refresh_token_enc, token_expires_at, public_metadata, created_at, updated_at) \
                 VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}'::jsonb,$14,$14)",
            )
            .bind(new_id(id_prefix::EXTERNAL))
            .bind(&user.id)
            .bind(&ext.provider)
            .bind(&ext.provider_user_id)
            .bind(&ext.email_address)
            .bind(&ext.first_name)
            .bind(&ext.last_name)
            .bind(&ext.username)
            .bind(&ext.image_url)
            .bind(&ext.approved_scopes)
            .bind(&ext.access_token_enc)
            .bind(&ext.refresh_token_enc)
            .bind(ext.token_expires_at)
            .bind(now)
            .execute(&mut *conn)
            .await?;
        }
    }
    // The event row commits with the user it describes. Serialization uses the
    // transaction's connection only; no pool connection is acquired here.
    emit_user_created_on(&mut *conn, state, &user, &user_input).await?;
    if let Some(invitation_id) = &current.invitation_id {
        if let Some(invitation) = mark_invitation_accepted_on(&mut *conn, invitation_id).await? {
            emit_invitation_accepted_on(&mut *conn, &invitation, &user.id).await?;
        }
    }
    let method = if fields.external_account.is_some() {
        Some("oauth".to_string())
    } else {
        orbitid_core::http::auth_method::auth_method_of(
            verifications
                .email_address
                .as_ref()
                .map(|snapshot| snapshot.strategy.as_str())
                .or_else(|| {
                    verifications
                        .phone_number
                        .as_ref()
                        .map(|snapshot| snapshot.strategy.as_str())
                }),
        )
        .map(|method| {
            serde_json::to_value(method)
                .ok()
                .and_then(|value| value.as_str().map(str::to_string))
                .unwrap_or_else(|| "password".to_string())
        })
        .or_else(|| Some("password".to_string()))
    };
    // Sibling attempts are abandoned before the session is created: `sign_ups`
    // (rank 4) and `sign_ins` (rank 5) rank below `sessions` (rank 7), so
    // updating them after the session insert would invert the global order.
    sqlx::query(
        "UPDATE sign_ins SET status = 'abandoned', version = version + 1, updated_at = $1 \
         WHERE client_id = $2 AND status NOT IN ('complete','abandoned')",
    )
    .bind(now())
    .bind(&current.client_id)
    .execute(&mut *conn)
    .await?;
    sqlx::query(
        "UPDATE sign_ups SET status = 'abandoned', version = version + 1, updated_at = $1 \
         WHERE client_id = $2 AND id <> $3 AND status NOT IN ('complete','abandoned')",
    )
    .bind(now())
    .bind(&current.client_id)
    .bind(&current.id)
    .execute(&mut *conn)
    .await?;
    let created = create_session_conn(
        state,
        &mut *conn,
        CreateSessionInput {
            client_id: current.client_id.clone(),
            user_id: user.id.clone(),
            ip: opts.ip.clone(),
            user_agent: opts.user_agent.clone(),
            max_lifetime_seconds: None,
            first_factor: true,
            second_factor: false,
            method,
            rotate_client_token: opts.rotate_client_token,
        },
    )
    .await?;
    let updated = sqlx::query(
        "UPDATE sign_ups SET status = 'complete', created_user_id = $1, created_session_id = $2, \
         version = version + 1, updated_at = $3 \
         WHERE id = $4 AND version = $5 AND status NOT IN ('complete','abandoned')",
    )
    .bind(&user.id)
    .bind(&created.id)
    .bind(now())
    .bind(&row.id)
    .bind(row.version)
    .execute(&mut *conn)
    .await?;
    if updated.rows_affected() == 0 {
        return Err(stale_sign_up_on(conn, &row.id).await);
    }
    // `session.created` and the single-session `session.ended` rows commit with
    // the session and the completed sign-up.
    emit_created_session_events_on(&mut *conn, state, &created).await?;
    Ok((
        CompletedSignUp {
            user,
            session_id: created.id,
            client_token: created.client_token,
        },
        user_input,
    ))
}

/// Whether the sign-up satisfies every requirement the instance makes.
///
/// This is exactly the TypeScript `maybeCompleteSignUp` decision: nothing may be
/// missing and nothing present may be unverified. In particular an identifier
/// the instance does not ask to verify (`attributes.emailAddress.verifyAtSignUp
/// = false`) needs no verification snapshot — the address is simply used
/// unverified. Do not add a separate "some identifier was verified" condition
/// here: a sign-up whose requirements are fully satisfied must complete, or the
/// operator's setting would never take effect.
fn requirements_met(
    state: &AppState,
    fields: &SignUpFields,
    verifications: &SignUpVerifications,
) -> bool {
    let requirements = compute_requirements(state, fields, verifications);
    requirements.missing_fields.is_empty() && requirements.unverified_fields.is_empty()
}

/// Completes automatically when nothing is missing/unverified.
pub async fn maybe_complete_sign_up(
    state: &AppState,
    row: &SignUpRow,
    opts: &CompleteSignUpOptions,
) -> Result<Option<CompletedSignUp>> {
    let fields = as_sign_up_fields(row);
    let verifications = as_sign_up_verifications(row);
    if requirements_met(state, &fields, &verifications) {
        return complete_sign_up(state, row, opts).await.map(Some);
    }
    save_sign_up(
        state,
        row,
        SignUpPatch {
            status: Some("missing_requirements".into()),
            ..Default::default()
        },
    )
    .await?;
    Ok(None)
}

/// Merges an OAuth profile into the sign-up fields/verifications.
pub async fn apply_external_profile(
    state: &AppState,
    row: &SignUpRow,
    profile: &ExternalProfile,
) -> Result<SignUpRow> {
    let fields = as_sign_up_fields(row);
    let verifications = as_sign_up_verifications(row);
    let email = profile.email.as_deref().map(normalize_email);
    let encrypt = |value: &Option<String>| -> Option<String> {
        value
            .as_ref()
            .and_then(|value| orbitid_core::crypto::encrypt(&state.env.encryption_key, value).ok())
    };
    let mut next_fields = fields.clone();
    if next_fields.email_address.is_none() {
        next_fields.email_address = email.clone();
    }
    if next_fields.first_name.is_none() {
        next_fields.first_name = profile.first_name.clone();
    }
    if next_fields.last_name.is_none() {
        next_fields.last_name = profile.last_name.clone();
    }
    next_fields.external_account = Some(StashedExternalAccount {
        provider: profile.provider.clone(),
        provider_user_id: profile.provider_user_id.clone(),
        email_address: email.clone().unwrap_or_default(),
        first_name: profile.first_name.clone().unwrap_or_default(),
        last_name: profile.last_name.clone().unwrap_or_default(),
        username: profile.username.clone(),
        image_url: profile.image_url.clone(),
        approved_scopes: profile.scopes.clone().unwrap_or_default(),
        access_token_enc: encrypt(&profile.access_token),
        refresh_token_enc: encrypt(&profile.refresh_token),
        token_expires_at: profile.expires_at,
    });
    let mut next_verifications = verifications.clone();
    next_verifications.external_account = Some(VerificationSnapshot {
        status: "verified".into(),
        strategy: verification_strategy_for(&profile.provider),
        ..Default::default()
    });
    if let Some(email) = &email {
        if verifications
            .email_address
            .as_ref()
            .map(|snapshot| snapshot.status != "verified")
            .unwrap_or(true)
        {
            next_verifications.email_address = Some(if profile.email_verified == Some(true) {
                VerificationSnapshot {
                    status: "verified".into(),
                    strategy: verification_strategy_for(&profile.provider),
                    identifier: Some(email.clone()),
                    ..Default::default()
                }
            } else {
                VerificationSnapshot {
                    status: "unverified".into(),
                    strategy: "email_code".into(),
                    attempts: Some(0),
                    identifier: Some(email.clone()),
                    ..Default::default()
                }
            });
        }
    }
    save_sign_up(
        state,
        row,
        SignUpPatch {
            fields: Some(next_fields),
            verifications: Some(next_verifications),
            ..Default::default()
        },
    )
    .await
}

/// Applies one CAS-guarded patch and, in the same transaction, either completes
/// the sign-up or records `missing_requirements`. The returned user input (when
/// completed) is for the caller's post-commit [`after_user_created`].
pub async fn save_and_maybe_complete_on(
    conn: &mut sqlx::PgConnection,
    state: &AppState,
    row: &SignUpRow,
    patch: SignUpPatch,
    opts: &CompleteSignUpOptions,
) -> Result<(SignUpRow, Option<(CompletedSignUp, CreateUserInput)>)> {
    // The save below writes `sign_ups` (rank 4) before completion would lock the
    // claim owners (rank 3), so lock them first, for the email the saved row will
    // carry (the CAS refuses if the row moved), and hand them to completion.
    orbitid_identity::locks::lock_client_on(conn, &row.client_id).await?;
    let email = match &patch.fields {
        Some(next) => next.email_address.clone(),
        None => as_sign_up_fields(row).email_address,
    };
    let owners = match email.as_deref() {
        Some(email) => Some(lock_unverified_claim_owners_on(&mut *conn, email, "", &[]).await?),
        None => None,
    };
    let saved = super::attempts::save_sign_up_on(conn, row, patch).await?;
    let fields = as_sign_up_fields(&saved);
    let verifications = as_sign_up_verifications(&saved);
    if !requirements_met(state, &fields, &verifications) {
        let saved = super::attempts::save_sign_up_on(
            conn,
            &saved,
            SignUpPatch {
                status: Some("missing_requirements".into()),
                ..Default::default()
            },
        )
        .await?;
        return Ok((saved, None));
    }
    let (completed, input) =
        complete_sign_up_on(conn, state, &saved, opts, owners.as_deref()).await?;
    Ok((saved, Some((completed, input))))
}
