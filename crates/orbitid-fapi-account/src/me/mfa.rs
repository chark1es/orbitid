//! TOTP and backup-code routes (`modules/me/mfa.ts`).

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::state::AppState;
use orbitid_credentials::mfa::fapi::{finish_totp_setup_on, user_has_mfa_on};
use orbitid_credentials::mfa::{generate_backup_codes, start_totp_setup};
use orbitid_identity::sessions_fapi::complete_mfa_enrollment_on;
use serde_json::json;

use crate::reply::json_reply;
use crate::util::require_reverification;

use super::shared::TotpAttemptBody;
use super::{authenticate, HttpMeta, MeAuth};

fn totp_json(id: &str, verified: bool, backup_code_enabled: bool) -> serde_json::Value {
    json!({
        "object": "totp",
        "id": id,
        "verified": verified,
        "secret": null,
        "uri": null,
        "qr_code": null,
        "backup_code_enabled": backup_code_enabled,
    })
}

fn backup_code_json(codes: &[String]) -> Vec<serde_json::Value> {
    codes
        .iter()
        .map(|code| json!({ "object": "backup_code", "code": code, "used": false }))
        .collect()
}

pub async fn get_totp(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (MeAuth { user, .. }, cookies) = authenticate(&state, &headers, &meta).await?;
    let has_codes = user
        .backup_codes
        .as_ref()
        .map(|codes| !codes.0.is_empty())
        .unwrap_or(false);
    Ok(json_reply(
        json!({ "response": totp_json(&user.id, user.totp_verified, has_codes) }),
        cookies,
    ))
}

pub async fn start_totp(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (MeAuth { user, .. }, cookies) = authenticate(&state, &headers, &meta).await?;
    if user.totp_verified {
        return Err(OrbitError::bad_request(
            error_codes::TOTP_NOT_ENABLED,
            "TOTP is already enabled. Disable it before setting it up again.",
        ));
    }
    let setup = start_totp_setup(&state, &user).await?;
    Ok(json_reply(
        json!({
            "response": {
                "object": "totp",
                "id": user.id,
                "secret": setup.secret,
                "uri": setup.uri,
                "qr_code": setup.qr_code,
                "verified": false,
                "backup_code_enabled": false,
            }
        }),
        cookies,
    ))
}

pub async fn attempt_totp_verification(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    OrbitJson(body): OrbitJson<TotpAttemptBody>,
) -> Result<Response> {
    let (MeAuth { user, session, .. }, cookies) = authenticate(&state, &headers, &meta).await?;
    super::shared::assert_max_chars(&body.code, 64, "code")?;
    orbitid_core::http::hit(&state, &format!("totp:attempt:{}", user.id), 20, 60_000).await?;
    // TOTP confirmation, backup codes, the pending session's activation and
    // `user.updated` are one transaction; a wrong code rolls the whole thing
    // back and the previous secret stays pending.
    let mut tx = state.pool.begin().await?;
    // Rank 2 → 3 before `finish_totp_setup_on` (which locks the user) and
    // `complete_mfa_enrollment_on` (which locks the session's client again).
    orbitid_identity::locks::lock_client_then_user_on(&mut tx, &session.client_id, &user.id)
        .await?;
    let backup_codes = finish_totp_setup_on(&mut tx, &state, &user, &body.code).await?;
    let reloaded = orbitid_identity::users::require_user_on(&mut tx, &user.id).await?;
    if user_has_mfa_on(&mut tx, &state, &reloaded).await? {
        complete_mfa_enrollment_on(&mut tx, &state, &user.id, &session.id).await?;
    }
    crate::util::emit_user_updated_on(&mut tx, &state, &user.id).await?;
    tx.commit().await?;
    let mut response = totp_json(&user.id, true, true);
    if let Some(object) = response.as_object_mut() {
        object.insert(
            "backup_codes".into(),
            serde_json::Value::Array(backup_code_json(&backup_codes)),
        );
    }
    Ok(json_reply(json!({ "response": response }), cookies))
}

pub async fn disable_totp_route(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (MeAuth { user, .. }, cookies) = authenticate(&state, &headers, &meta).await?;
    // The second-factor removal, the trusted-device revocation and the
    // `user.updated` event are one transaction: a failure can never disable TOTP
    // on some replicas/browsers but not others, or lose the announcement.
    let mut tx = state.pool.begin().await?;
    orbitid_credentials::mfa::disable_totp_on(&mut tx, &user.id).await?;
    orbitid_identity::trusted_devices::revoke_all_trusted_devices_on(&mut tx, &user.id).await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &user.id).await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": totp_json(&user.id, false, false) }),
        cookies,
    ))
}

pub async fn regenerate_backup_codes(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (MeAuth { user, .. }, cookies) = authenticate(&state, &headers, &meta).await?;
    if !user.totp_verified {
        return Err(OrbitError::bad_request(
            error_codes::TOTP_NOT_ENABLED,
            "Enable TOTP before generating backup codes",
        ));
    }
    let codes = generate_backup_codes(10);
    let mut tx = state.pool.begin().await?;
    sqlx::query("UPDATE users SET backup_codes = $1, updated_at = $2 WHERE id = $3")
        .bind(sqlx::types::Json(&codes.hashed))
        .bind(now())
        .bind(&user.id)
        .execute(&mut *tx)
        .await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &user.id).await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": backup_code_json(&codes.plain) }),
        cookies,
    ))
}
