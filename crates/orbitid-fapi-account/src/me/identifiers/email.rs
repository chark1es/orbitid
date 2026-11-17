//! Email-address routes (`modules/me/identifiers.ts` email half).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::EmailAddressRow;
use orbitid_core::state::AppState;
use orbitid_identity::enterprise_access::assert_additional_identifications_allowed;
use orbitid_identity::restrictions::{assert_identifiers_allowed, IdentifiersToCheck};
use orbitid_identity::serializers::serialize_email;
use orbitid_identity::users::{
    delete_email_address_on, find_email, is_valid_email, list_emails, normalize_email,
    upgrade_anonymous_user_on,
};
use orbitid_identity::verifications::{
    check_code_on, commit_code_refusal, issue_verification, CodeCheck, IssueVerificationInput,
};
use orbitid_platform::mail::{send_email, EmailTemplate, SendEmailInput};
use serde_json::json;

use crate::reply::json_reply;
use crate::util::require_reverification;

use super::super::shared::{assert_max_chars, EmailCreateBody, PrepareBody, VerifyCodeBody};
use super::super::{authenticate, HttpMeta};
use super::{load_email, owner_email};

pub async fn list_email_addresses(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let rows = list_emails(&state, &me.user.id).await?;
    let response: Vec<_> = rows.iter().map(serialize_email).collect();
    Ok(json_reply(json!({ "response": response }), cookies))
}

pub async fn create_email_address(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    OrbitJson(body): OrbitJson<EmailCreateBody>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    assert_additional_identifications_allowed(&state, &me.user.id).await?;
    assert_max_chars(&body.email_address, 320, "email_address")?;
    if !state.settings.get().attributes.email_address.enabled {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_UNKNOWN,
            "Email addresses are disabled for this instance",
        )
        .with_meta(json!({ "param_name": "email_address" })));
    }
    let email = normalize_email(&body.email_address);
    if !is_valid_email(&email) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "email_address is not valid",
        )
        .with_meta(json!({ "param_name": "email_address" })));
    }
    if let Some(claimed) = find_email(&state, &email).await? {
        if claimed.verified || claimed.user_id.as_deref() == Some(me.user.id.as_str()) {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_IDENTIFIER_EXISTS,
                "That email address is already in use",
            )
            .with_meta(json!({ "param_name": "email_address" })));
        }
    }
    if me.user.is_anonymous {
        assert_identifiers_allowed(
            &state,
            &IdentifiersToCheck {
                emails: vec![email.clone()],
                phones: Vec::new(),
                invitation_ticket: None,
            },
            false,
        )
        .await?;
    }
    let now_ms = now();
    let id = new_id(id_prefix::EMAIL);
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO email_addresses (id, user_id, email, verified, reserved, created_at, \
         updated_at) VALUES ($1,$2,$3,false,false,$4,$4)",
    )
    .bind(&id)
    .bind(&me.user.id)
    .bind(&email)
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE users SET primary_email_address_id = COALESCE(primary_email_address_id, $1), \
         updated_at = $2 WHERE id = $3",
    )
    .bind(&id)
    .bind(now_ms)
    .bind(&me.user.id)
    .execute(&mut *tx)
    .await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    let row = load_email(&state, &id).await?;
    Ok(json_reply(
        json!({ "response": serialize_email(&row) }),
        cookies,
    ))
}

pub async fn get_email_address(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let row = owner_email(&state, &id, &me.user.id).await?;
    Ok(json_reply(
        json!({ "response": serialize_email(&row) }),
        cookies,
    ))
}

pub async fn delete_email_address(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    owner_email(&state, &id, &me.user.id).await?;
    // The identification delete (last-identification guard + primary-pointer
    // repair) and `user.updated` commit together.
    let mut tx = state.pool.begin().await?;
    delete_email_address_on(&mut tx, &state, &me.user.id, &id).await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": { "object": "email_address", "id": id, "deleted": true } }),
        cookies,
    ))
}

pub async fn prepare_email_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
    OrbitJson(_body): OrbitJson<PrepareBody>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    assert_additional_identifications_allowed(&state, &me.user.id).await?;
    let row = owner_email(&state, &id, &me.user.id).await?;
    if row.verified {
        return Err(OrbitError::unprocessable(
            error_codes::VERIFICATION_ALREADY_VERIFIED,
            "That email address is already verified",
        ));
    }
    orbitid_core::http::hit(
        &state,
        &format!("add_email:prepare:{}", me.user.id),
        10,
        60_000,
    )
    .await?;
    let settings = state.settings.get();
    let issued = issue_verification(
        &state,
        IssueVerificationInput::new(
            "add_email",
            "email_code",
            row.email.clone(),
            row.id.clone(),
            settings.email.code_lifetime_seconds,
        ),
    )
    .await?;
    let code = issued.code.unwrap_or_default();
    send_email(
        &state,
        SendEmailInput::new(row.email.clone(), EmailTemplate::VerificationCode)
            .with_var("code", code)
            .with_var(
                "expires_in_minutes",
                ((settings.email.code_lifetime_seconds as f64) / 60.0).round() as i64,
            ),
    )
    .await;
    Ok(json_reply(
        json!({ "response": serialize_email(&row) }),
        cookies,
    ))
}

pub async fn attempt_email_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<VerifyCodeBody>,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    assert_additional_identifications_allowed(&state, &me.user.id).await?;
    let row = owner_email(&state, &id, &me.user.id).await?;
    assert_max_chars(&body.code, 64, "code")?;
    orbitid_core::http::hit(
        &state,
        &format!("add_email:attempt:{}", me.user.id),
        20,
        60_000,
    )
    .await?;
    let mut tx = state.pool.begin().await?;
    // Rank 3 before the verification row (rank 6): this user and every other
    // user holding an unverified claim on the address, ascending id. The purge
    // below then writes only rows of users locked here.
    let locked_users = orbitid_identity::users::lock_unverified_claim_owners_on(
        &mut tx,
        &row.email,
        &me.user.id,
        std::slice::from_ref(&me.user.id),
    )
    .await?;
    let verification = orbitid_identity::verifications_fapi::get_verification_on(
        &mut tx,
        "add_email",
        &row.id,
        None,
    )
    .await?;
    if let CodeCheck::Refused(refusal) =
        check_code_on(&mut tx, &state, verification.as_ref(), Some(&body.code)).await?
    {
        // A wrong code counts an attempt that must survive this refusal.
        return Err(commit_code_refusal(tx, refusal).await?);
    }
    let duplicate = sqlx::query_as::<_, EmailAddressRow>(
        "SELECT * FROM email_addresses WHERE email = $1 AND verified = true FOR SHARE",
    )
    .bind(&row.email)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(duplicate) = duplicate {
        if duplicate.id != row.id {
            return Err(OrbitError::conflict(
                error_codes::DUPLICATE_RECORD,
                "That email address is already verified by another account",
            ));
        }
    }
    let now_ms = now();
    // Verify the address, purge competing unverified claims, set the primary
    // pointer when there was none, promote a guest and write `user.updated` in
    // one transaction.
    sqlx::query(
        "UPDATE email_addresses SET verified = true, verified_at = $1, \
         verified_strategy = 'email_code', updated_at = $1 \
         WHERE id = $2 AND verified = false",
    )
    .bind(now_ms)
    .bind(&row.id)
    .execute(&mut *tx)
    .await?;
    orbitid_identity::users::purge_unverified_claims_on(
        &mut tx,
        &row.email,
        &me.user.id,
        &locked_users,
    )
    .await?;
    sqlx::query(
        "UPDATE users SET primary_email_address_id = $1, updated_at = $2 \
         WHERE id = $3 AND primary_email_address_id IS NULL",
    )
    .bind(&row.id)
    .bind(now_ms)
    .bind(&me.user.id)
    .execute(&mut *tx)
    .await?;
    upgrade_anonymous_user_on(&mut tx, &me.user.id).await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    // Post-commit, best-effort: verified-email organisation enrolment has its
    // own transaction and a failure there never turns a verified address into
    // a 500.
    let _ = orbitid_identity::orgs::on_user_email_verified(&state, &me.user.id, &row.email).await;
    let row = load_email(&state, &row.id).await?;
    Ok(json_reply(
        json!({ "response": serialize_email(&row) }),
        cookies,
    ))
}
