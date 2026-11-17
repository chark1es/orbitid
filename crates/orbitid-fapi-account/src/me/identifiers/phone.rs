//! Phone-number routes (`modules/me/identifiers.ts` phone half).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::PhoneNumberRow;
use orbitid_core::state::AppState;
use orbitid_credentials::mfa::fapi::{user_has_mfa_on, verified_second_factor_phones_on};
use orbitid_identity::enterprise_access::assert_additional_identifications_allowed;
use orbitid_identity::restrictions::{assert_identifiers_allowed, IdentifiersToCheck};
use orbitid_identity::serializers::serialize_phone;
use orbitid_identity::sessions_fapi::complete_mfa_enrollment_on;
use orbitid_identity::trusted_devices::revoke_all_trusted_devices_on;
use orbitid_identity::users::{
    delete_phone_number_on, list_phones, normalize_phone, require_user_on,
    upgrade_anonymous_user_on,
};
use orbitid_identity::verifications::{
    check_code_on, commit_code_refusal, issue_verification, CodeCheck, IssueVerificationInput,
};
use orbitid_platform::mail::send_sms;
use serde_json::json;

use crate::reply::json_reply;
use crate::util::require_reverification;

use super::super::shared::{
    assert_max_chars, PhoneCreateBody, PhoneUpdateBody, PrepareBody, VerifyCodeBody,
};
use super::super::{authenticate, HttpMeta};
use super::{load_phone, load_phone_on, owner_phone};

pub async fn list_phone_numbers(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let rows = list_phones(&state, &me.user.id).await?;
    let response: Vec<_> = rows.iter().map(serialize_phone).collect();
    Ok(json_reply(json!({ "response": response }), cookies))
}

pub async fn create_phone_number(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    OrbitJson(body): OrbitJson<PhoneCreateBody>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    assert_additional_identifications_allowed(&state, &me.user.id).await?;
    assert_max_chars(&body.phone_number, 32, "phone_number")?;
    if !state.settings.get().attributes.phone_number.enabled {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_UNKNOWN,
            "Phone numbers are disabled for this instance",
        )
        .with_meta(json!({ "param_name": "phone_number" })));
    }
    let phone = normalize_phone(&body.phone_number)?;
    let taken =
        sqlx::query_as::<_, PhoneNumberRow>("SELECT * FROM phone_numbers WHERE phone = $1 LIMIT 1")
            .bind(&phone)
            .fetch_optional(&state.pool)
            .await?;
    if taken.is_some() {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_IDENTIFIER_EXISTS,
            "That phone number is already in use",
        )
        .with_meta(json!({ "param_name": "phone_number" })));
    }
    if me.user.is_anonymous {
        assert_identifiers_allowed(
            &state,
            &IdentifiersToCheck {
                emails: Vec::new(),
                phones: vec![phone.clone()],
                invitation_ticket: None,
            },
            false,
        )
        .await?;
    }
    let now_ms = now();
    let id = new_id(id_prefix::PHONE);
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "INSERT INTO phone_numbers (id, user_id, phone, verified, reserved_for_second_factor, \
         default_second_factor, created_at, updated_at) VALUES ($1,$2,$3,false,false,false,$4,$4)",
    )
    .bind(&id)
    .bind(&me.user.id)
    .bind(&phone)
    .bind(now_ms)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE users SET primary_phone_number_id = COALESCE(primary_phone_number_id, $1), \
         updated_at = $2 WHERE id = $3",
    )
    .bind(&id)
    .bind(now_ms)
    .bind(&me.user.id)
    .execute(&mut *tx)
    .await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    // Read inside the transaction: a delete committing right after ours must not
    // turn this success into a 500.
    let row = load_phone_on(&mut tx, &id).await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": serialize_phone(&row) }),
        cookies,
    ))
}

pub async fn get_phone_number(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let row = owner_phone(&state, &id, &me.user.id).await?;
    Ok(json_reply(
        json!({ "response": serialize_phone(&row) }),
        cookies,
    ))
}

pub async fn update_phone_number(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PhoneUpdateBody>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    if (body.reserved_for_second_factor.unwrap_or(false)
        || body.default_second_factor.unwrap_or(false))
        && !state
            .settings
            .get()
            .attributes
            .phone_number
            .used_for_second_factor
    {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_UNKNOWN,
            "Phone numbers cannot be used as a second factor on this instance",
        )
        .with_meta(json!({ "param_name": "reserved_for_second_factor" })));
    }
    // The row lock serializes concurrent edits; the default-factor swap, the
    // enrollment settlement, the remembered-browser revocation and the event
    // all commit together.
    let mut tx = state.pool.begin().await?;
    // Rank 2 → 3 before the first phone-row lock (the sibling swap locks every
    // phone of the user).
    orbitid_identity::locks::lock_client_then_user_on(&mut tx, &me.session.client_id, &me.user.id)
        .await?;
    let row = sqlx::query_as::<_, PhoneNumberRow>(
        "SELECT * FROM phone_numbers WHERE id = $1 AND user_id = $2 FOR UPDATE",
    )
    .bind(&id)
    .bind(&me.user.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Phone number not found")
    })?;
    let mut reserved_for_second_factor = row.reserved_for_second_factor;
    let mut default_second_factor = row.default_second_factor;
    if let Some(value) = body.reserved_for_second_factor {
        reserved_for_second_factor = value;
    }
    if let Some(value) = body.default_second_factor {
        if value && !row.verified {
            return Err(OrbitError::unprocessable(
                error_codes::VERIFICATION_FAILED,
                "The default second factor must be verified",
            ));
        }
        default_second_factor = value;
        if value {
            reserved_for_second_factor = true;
        }
        sqlx::query(
            "UPDATE phone_numbers SET default_second_factor = false \
             WHERE user_id = $1 AND id <> $2",
        )
        .bind(&me.user.id)
        .bind(&id)
        .execute(&mut *tx)
        .await?;
    }
    if reserved_for_second_factor && !row.verified {
        return Err(OrbitError::unprocessable(
            error_codes::VERIFICATION_FAILED,
            "Only verified phone numbers can be a second factor",
        ));
    }
    sqlx::query(
        "UPDATE phone_numbers SET reserved_for_second_factor = $1, default_second_factor = $2, \
         updated_at = $3 WHERE id = $4",
    )
    .bind(reserved_for_second_factor)
    .bind(default_second_factor)
    .bind(now())
    .bind(&id)
    .execute(&mut *tx)
    .await?;
    let remaining = require_user_on(&mut tx, &me.user.id).await?;
    if (body.reserved_for_second_factor == Some(false)
        || (body.default_second_factor == Some(false) && row.reserved_for_second_factor))
        && !remaining.totp_verified
        && verified_second_factor_phones_on(&mut tx, &me.user.id, None)
            .await?
            .is_empty()
    {
        revoke_all_trusted_devices_on(&mut tx, &me.user.id).await?;
    }
    if user_has_mfa_on(&mut tx, &state, &remaining).await? {
        complete_mfa_enrollment_on(&mut tx, &state, &me.user.id, &me.session.id).await?;
    }
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    let row = load_phone(&state, &id).await?;
    Ok(json_reply(
        json!({ "response": serialize_phone(&row) }),
        cookies,
    ))
}

pub async fn delete_phone_number(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let row = owner_phone(&state, &id, &me.user.id).await?;
    // The delete (last-identification guard + primary-pointer repair), the
    // remembered-browser revocation when this was the last second factor, and
    // the event commit together.
    let mut tx = state.pool.begin().await?;
    delete_phone_number_on(&mut tx, &state, &me.user.id, &id).await?;
    if row.reserved_for_second_factor && !me.user.totp_verified {
        let remaining = require_user_on(&mut tx, &me.user.id).await?;
        if !remaining.totp_verified
            && verified_second_factor_phones_on(&mut tx, &me.user.id, None)
                .await?
                .is_empty()
        {
            revoke_all_trusted_devices_on(&mut tx, &me.user.id).await?;
        }
    }
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": { "object": "phone_number", "id": id, "deleted": true } }),
        cookies,
    ))
}

pub async fn prepare_phone_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
    OrbitJson(_body): OrbitJson<PrepareBody>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    assert_additional_identifications_allowed(&state, &me.user.id).await?;
    let row = owner_phone(&state, &id, &me.user.id).await?;
    if row.verified {
        return Err(OrbitError::unprocessable(
            error_codes::VERIFICATION_ALREADY_VERIFIED,
            "That phone number is already verified",
        ));
    }
    orbitid_core::http::hit(
        &state,
        &format!("add_phone:prepare:{}", me.user.id),
        10,
        60_000,
    )
    .await?;
    let settings = state.settings.get();
    let issued = issue_verification(
        &state,
        IssueVerificationInput::new(
            "add_phone",
            "phone_code",
            row.phone.clone(),
            row.id.clone(),
            settings.email.code_lifetime_seconds,
        ),
    )
    .await?;
    let code = issued.code.unwrap_or_default();
    send_sms(
        &state,
        &row.phone,
        &format!(
            "Your {} verification code is {}",
            settings.application.name, code
        ),
    )
    .await;
    Ok(json_reply(
        json!({ "response": serialize_phone(&row) }),
        cookies,
    ))
}

pub async fn attempt_phone_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<VerifyCodeBody>,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    assert_additional_identifications_allowed(&state, &me.user.id).await?;
    owner_phone(&state, &id, &me.user.id).await?;
    assert_max_chars(&body.code, 64, "code")?;
    orbitid_core::http::hit(
        &state,
        &format!("add_phone:attempt:{}", me.user.id),
        20,
        60_000,
    )
    .await?;
    let mut tx = state.pool.begin().await?;
    // Rank 3 before the verification row (rank 6) and the phone-row write.
    orbitid_identity::locks::lock_user_on(&mut tx, &me.user.id).await?;
    // A delete that committed while this request waited for the user lock leaves
    // nothing to verify: not found, not a 500 from a later read.
    let row = super::owner_phone_on(&mut tx, &id, &me.user.id).await?;
    let verification = orbitid_identity::verifications_fapi::get_verification_on(
        &mut tx,
        "add_phone",
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
    let duplicate = sqlx::query_as::<_, PhoneNumberRow>(
        "SELECT * FROM phone_numbers WHERE phone = $1 AND verified = true FOR SHARE",
    )
    .bind(&row.phone)
    .fetch_optional(&mut *tx)
    .await?;
    if let Some(duplicate) = duplicate {
        if duplicate.id != row.id {
            return Err(OrbitError::conflict(
                error_codes::DUPLICATE_RECORD,
                "That phone number is already verified by another account",
            ));
        }
    }
    let now_ms = now();
    sqlx::query(
        "UPDATE phone_numbers SET verified = true, verified_at = $1, updated_at = $1 \
         WHERE id = $2 AND verified = false",
    )
    .bind(now_ms)
    .bind(&row.id)
    .execute(&mut *tx)
    .await?;
    sqlx::query(
        "UPDATE users SET primary_phone_number_id = $1, updated_at = $2 \
         WHERE id = $3 AND primary_phone_number_id IS NULL",
    )
    .bind(&row.id)
    .bind(now_ms)
    .bind(&me.user.id)
    .execute(&mut *tx)
    .await?;
    upgrade_anonymous_user_on(&mut tx, &me.user.id).await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    let row = load_phone_on(&mut tx, &row.id).await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": serialize_phone(&row) }),
        cookies,
    ))
}
