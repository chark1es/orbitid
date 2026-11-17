//! Passkey routes (`modules/me/passkeys.ts`).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::models::PasskeyRow;
use orbitid_core::state::AppState;
use orbitid_credentials::passkeys::fapi::{finish_passkey_registration_on, PasskeyRegistration};
use orbitid_credentials::passkeys::webauthn::RegistrationResponseJson;
use orbitid_credentials::passkeys::{
    begin_passkey_registration, list_passkeys as list_user_passkeys, relying_party,
    BeginRegistrationInput, FinishRegistrationInput,
};
use orbitid_identity::enterprise_access::assert_additional_identifications_allowed;
use orbitid_identity::serializers::serialize_passkey;
use orbitid_identity::users::primary_email;
use serde_json::json;

use crate::reply::json_reply;

use super::shared::{
    assert_max_chars, validate_authenticator_type, PasskeyAttemptBody, PasskeyCreateBody,
    PasskeyRenameBody,
};
use super::{authenticate, HttpMeta};

pub async fn list_passkeys(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let rows = list_user_passkeys(&state.pool, &me.user.id).await?;
    let response: Vec<_> = rows.iter().map(serialize_passkey).collect();
    Ok(json_reply(json!({ "response": response }), cookies))
}

pub async fn begin_registration(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    OrbitJson(body): OrbitJson<PasskeyCreateBody>,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    assert_additional_identifications_allowed(&state, &me.user.id).await?;
    if !state.settings.get().attributes.passkey.enabled {
        return Err(OrbitError::bad_request(
            error_codes::WEBAUTHN_NOT_SUPPORTED,
            "Passkeys are disabled for this instance",
        ));
    }
    if let Some(name) = &body.name {
        assert_max_chars(name, 128, "name")?;
    }
    validate_authenticator_type(&body.authenticator_type)?;
    let email = primary_email(&state, &me.user).await?;
    let display_name = [me.user.first_name.as_deref(), me.user.last_name.as_deref()]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>()
        .join(" ");
    let display_name = if display_name.is_empty() {
        me.user
            .username
            .clone()
            .or_else(|| email.as_ref().map(|email| email.email.clone()))
            .unwrap_or_else(|| me.user.id.clone())
    } else {
        display_name
    };
    let user_name = email
        .as_ref()
        .map(|email| email.email.clone())
        .or_else(|| me.user.username.clone())
        .unwrap_or_else(|| me.user.id.clone());
    let rp = relying_party(&state, crate::util::header(&headers, "origin").as_deref())?;
    let begin = begin_passkey_registration(
        &state,
        BeginRegistrationInput {
            user_id: me.user.id.clone(),
            user_name,
            display_name,
            rp,
            authenticator_type: body.authenticator_type.clone(),
            name: body.name.clone(),
        },
    )
    .await?;
    let timestamp = now();
    Ok(json_reply(
        json!({
            "response": {
                "object": "passkey",
                "id": begin.passkey_id,
                "name": body.name.clone().unwrap_or_else(|| "Passkey".to_string()),
                "verification": {
                    "status": "unverified",
                    "strategy": "passkey",
                    "attempts": null,
                    "expire_at": null,
                    "nonce": begin.options.challenge,
                },
                "public_key_credential_creation_options": begin.options,
                "last_used_at": null,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
        }),
        cookies,
    ))
}

pub async fn attempt_registration(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PasskeyAttemptBody>,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    assert_additional_identifications_allowed(&state, &me.user.id).await?;
    let Some(credential) = body.public_key_credential else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_MISSING,
            "public_key_credential is missing",
        )
        .with_meta(json!({ "param_name": "public_key_credential" })));
    };
    if let Some(name) = &body.name {
        assert_max_chars(name, 128, "name")?;
    }
    let credential: RegistrationResponseJson =
        serde_json::from_value(credential).map_err(|error| {
            OrbitError::bad_request(
                error_codes::PASSKEY_REGISTRATION_FAILURE,
                format!("Passkey registration could not be verified: {error}"),
            )
        })?;
    // The challenge claim, the credential insert and `user.updated` commit as
    // one transaction: a failed attestation rolls the claim back (and is
    // committed separately so its attempt counter still counts), while a
    // concurrent finish with the same challenge inserts exactly one credential.
    let mut tx = state.pool.begin().await?;
    // The credential insert references `users` (rank 3) while the challenge
    // claim locks a verification row (rank 6): take the user key-share first.
    orbitid_identity::locks::key_share_user_on(&mut tx, &me.user.id).await?;
    let passkey = finish_passkey_registration_on(
        &mut tx,
        &state,
        &FinishRegistrationInput {
            passkey_id: id,
            user_id: me.user.id.clone(),
            credential,
            name: body.name,
        },
    )
    .await?;
    let passkey = match passkey {
        PasskeyRegistration::Created(passkey) => passkey,
        PasskeyRegistration::Refused(error) => {
            // Commit the claimed attempt (the challenge was released inside the
            // helper) so failed attestations keep counting. A database failure
            // propagated above and rolled back instead.
            tx.commit().await?;
            return Err(error);
        }
    };
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": serialize_passkey(&passkey) }),
        cookies,
    ))
}

pub async fn rename_passkey(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<PasskeyRenameBody>,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    if body.name.is_empty() || body.name.chars().count() > 128 {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "name: must be 1-128 characters",
        )
        .with_meta(json!({ "param_name": "name" })));
    }
    let mut tx = state.pool.begin().await?;
    // Rank 3: the user row before its passkey row.
    orbitid_identity::locks::lock_user_on(&mut tx, &me.user.id).await?;
    let row = sqlx::query_as::<_, PasskeyRow>(
        "UPDATE passkeys SET name = $1, updated_at = $2 WHERE id = $3 AND user_id = $4 \
         RETURNING *",
    )
    .bind(&body.name)
    .bind(now())
    .bind(&id)
    .bind(&me.user.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Passkey not found"))?;
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": serialize_passkey(&row) }),
        cookies,
    ))
}

pub async fn delete_passkey(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
) -> Result<Response> {
    crate::util::require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let mut tx = state.pool.begin().await?;
    orbitid_identity::locks::lock_user_on(&mut tx, &me.user.id).await?;
    let deleted = orbitid_credentials::delete_passkey_on(&mut tx, &me.user.id, &id).await?;
    if deleted.is_none() {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Passkey not found",
        ));
    }
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": { "object": "passkey", "id": id, "deleted": true } }),
        cookies,
    ))
}
