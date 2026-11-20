//! Profile, avatar and password routes (`modules/me/profile.ts`).

use axum::extract::State;
use axum::http::HeaderMap;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::keys::cookies::CLIENT;
use orbitid_core::models::UserRow;
use orbitid_core::state::AppState;
use orbitid_identity::enterprise_access::assert_additional_identifications_allowed;
use orbitid_identity::serializers::{serialize_user, UserSerializeOptions};
use orbitid_identity::users::{
    assert_required_profile_field, assert_username_available_on, delete_user_on,
    has_verified_identifier, primary_email, record_failed_attempt, reset_failed_attempts,
    ProfileField,
};
use orbitid_platform::mail::{send_email, EmailTemplate, SendEmailInput};
use serde_json::json;

use crate::reply::json_reply;
use crate::util::{reload_user, require_reverification};

use super::shared::{assert_max_chars, PasswordChangeBody, PasswordRemoveBody, UpdateProfileBody};
use super::{authenticate, HttpMeta, MeAuth};

pub(super) async fn user_reply(
    state: &AppState,
    user: &UserRow,
    cookies: Vec<String>,
) -> Result<Response> {
    let json = serialize_user(state, user, UserSerializeOptions::default()).await?;
    Ok(json_reply(json!({ "response": json }), cookies))
}

pub async fn get_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    user_reply(&state, &me.user, cookies).await
}

pub async fn update_profile(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    OrbitJson(body): OrbitJson<UpdateProfileBody>,
) -> Result<Response> {
    let (MeAuth { user, .. }, cookies) = authenticate(&state, &headers, &meta).await?;
    // Every column written below is derived from the row read under the user
    // lock (rank 3), never from the authentication read: two concurrent PATCHes
    // of different fields must both survive.
    let mut tx = state.pool.begin().await?;
    let user = sqlx::query_as::<_, orbitid_core::models::UserRow>(
        "SELECT * FROM users WHERE id = $1 FOR UPDATE",
    )
    .bind(&user.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found"))?;
    let mut first_name = user.first_name.clone();
    let mut last_name = user.last_name.clone();
    let mut username = user.username.clone();
    let mut username_lower = user.username_lower.clone();
    let mut unsafe_metadata = user.unsafe_metadata.0.clone();
    let mut legal_accepted_at = user.legal_accepted_at;
    let mut primary_email_address_id = user.primary_email_address_id.clone();
    let mut primary_phone_number_id = user.primary_phone_number_id.clone();

    if let Some(value) = body.first_name.as_option() {
        assert_required_profile_field(&state, ProfileField::FirstName, Some(value))?;
        if let Some(value) = value {
            assert_max_chars(value, 256, "first_name")?;
        }
        first_name = value.map(str::to_string);
    }
    if let Some(value) = body.last_name.as_option() {
        assert_required_profile_field(&state, ProfileField::LastName, Some(value))?;
        if let Some(value) = value {
            assert_max_chars(value, 256, "last_name")?;
        }
        last_name = value.map(str::to_string);
    }
    if let Some(value) = body.username.as_option() {
        if let Some(value) = value {
            assert_max_chars(value, 64, "username")?;
        }
        let cleared = value.map(str::is_empty).unwrap_or(true);
        if !cleared && !state.settings.get().attributes.username.enabled {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_UNKNOWN,
                "Usernames are disabled for this instance",
            )
            .with_meta(json!({ "param_name": "username" })));
        }
        if cleared {
            assert_required_profile_field(&state, ProfileField::Username, None)?;
            username = None;
            username_lower = None;
        } else if let Some(value) = value {
            username = Some(value.to_string());
            username_lower = Some(value.to_lowercase());
        }
    }
    if let Some(value) = body.unsafe_metadata {
        unsafe_metadata = crate::util::parse_metadata(value, "unsafe_metadata")?;
    }
    if body.legal_accepted == Some(true) {
        legal_accepted_at = Some(now());
    }
    let requested_primary_email = body
        .primary_email_address_id
        .as_option()
        .flatten()
        .map(str::to_string);
    let requested_primary_phone = body
        .primary_phone_number_id
        .as_option()
        .flatten()
        .map(str::to_string);
    // The username uniqueness check, the primary-identifier checks (both read
    // under a share lock, so a concurrent delete cannot race the write), the row
    // update and the `user.updated` event are one transaction.
    if let Some(value) = body
        .username
        .as_option()
        .flatten()
        .filter(|value| !value.is_empty())
    {
        assert_username_available_on(&state, &mut tx, value, Some(&user.id)).await?;
    }
    if let Some(id) = requested_primary_email.filter(|id| !id.is_empty()) {
        let email = sqlx::query_as::<_, orbitid_core::models::EmailAddressRow>(
            "SELECT * FROM email_addresses WHERE id = $1 AND user_id = $2 FOR SHARE",
        )
        .bind(&id)
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(email) = email else {
            return Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "Email address not found",
            ));
        };
        if !email.verified {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_VALUE_INVALID,
                "The primary email address must be verified",
            )
            .with_meta(json!({ "param_name": "primary_email_address_id" })));
        }
        primary_email_address_id = Some(email.id);
    }
    if let Some(id) = requested_primary_phone.filter(|id| !id.is_empty()) {
        let phone = sqlx::query_as::<_, orbitid_core::models::PhoneNumberRow>(
            "SELECT * FROM phone_numbers WHERE id = $1 AND user_id = $2 FOR SHARE",
        )
        .bind(&id)
        .bind(&user.id)
        .fetch_optional(&mut *tx)
        .await?;
        let Some(phone) = phone else {
            return Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                "Phone number not found",
            ));
        };
        if !phone.verified {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_VALUE_INVALID,
                "The primary phone number must be verified",
            )
            .with_meta(json!({ "param_name": "primary_phone_number_id" })));
        }
        primary_phone_number_id = Some(phone.id);
    }
    sqlx::query(
        "UPDATE users SET first_name = $1, last_name = $2, username = $3, username_lower = $4, \
         unsafe_metadata = $5, legal_accepted_at = $6, primary_email_address_id = $7, \
         primary_phone_number_id = $8, updated_at = $9 WHERE id = $10",
    )
    .bind(&first_name)
    .bind(&last_name)
    .bind(&username)
    .bind(&username_lower)
    .bind(sqlx::types::Json(unsafe_metadata))
    .bind(legal_accepted_at)
    .bind(&primary_email_address_id)
    .bind(&primary_phone_number_id)
    .bind(now())
    .bind(&user.id)
    .execute(&mut *tx)
    .await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &user.id).await?;
    tx.commit().await?;
    let reloaded = reload_user(&state, &user.id).await?;
    user_reply(&state, &reloaded, cookies).await
}

pub async fn delete_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    if !state.settings.get().user_settings.delete_self_enabled || !me.user.delete_self_enabled {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Account deletion is disabled",
        ));
    }
    let user_id = me.user.id.clone();
    // The user (and every identifier, session, membership and grant) and the
    // browser's client pointer leave together: a failure can never delete an
    // account while its client still points at one of its sessions.
    let mut tx = state.pool.begin().await?;
    if !me.user.is_anonymous {
        // First, before any row lock: deleting a real account claims the
        // instance in the same transaction, so owner setup can never reopen.
        orbitid_identity::console::claim_on(&mut tx).await?;
    }
    delete_user_on(&mut tx, &state, &user_id).await?;
    sqlx::query("UPDATE clients SET last_active_session_id = NULL, updated_at = $1 WHERE id = $2")
        .bind(now())
        .bind(&me.client.id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    let secure =
        orbitid_core::http::request_is_secure(&headers, &state.env.base_url, state.env.trust_proxy);
    let mut cookies = cookies;
    cookies.push(orbitid_core::http::clear_cookie(CLIENT, "/", secure));
    let delete_event = json!({ "object": "user", "id": user_id, "deleted": true });
    Ok(json_reply(json!({ "response": delete_event }), cookies))
}

pub async fn change_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    OrbitJson(body): OrbitJson<PasswordChangeBody>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    assert_additional_identifications_allowed(&state, &me.user.id).await?;
    if let Some(current) = &body.current_password {
        assert_max_chars(current, 256, "current_password")?;
    }
    assert_max_chars(&body.new_password, 256, "new_password")?;
    if let Some(hash) = me.user.password_hash.as_deref() {
        let Some(current) = body.current_password.as_deref() else {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_MISSING,
                "current_password is missing",
            )
            .with_meta(json!({ "param_name": "current_password" })));
        };
        if !orbitid_credentials::passwords::verify_password(hash, current).await {
            record_failed_attempt(&state, &me.user.id).await?;
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PASSWORD_INCORRECT,
                "Current password is incorrect",
            )
            .with_meta(json!({ "param_name": "current_password" })));
        }
        reset_failed_attempts(&state, &me.user.id).await?;
    }
    if me.user.is_anonymous && !has_verified_identifier(&state, &me.user.id).await? {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            "Add and verify an email address or phone number before setting a password.",
        )
        .with_meta(json!({ "param_name": "new_password" })));
    }
    orbitid_credentials::passwords::assert_password_valid(&state, &body.new_password).await?;
    let password_hash = orbitid_credentials::passwords::hash_password(&body.new_password).await?;
    let sign_out = body.sign_out_of_other_sessions.unwrap_or(
        state
            .settings
            .get()
            .password
            .sign_out_of_other_sessions_on_change,
    );
    // New hash, remembered-browser revocation, other-session sign-out and the
    // `user.updated` event commit together: a failure can never leave the old
    // password live, or the new one live while old sessions keep working.
    let mut tx = state.pool.begin().await?;
    sqlx::query(
        "UPDATE users SET password_hash = $1, password_updated_at = $2, updated_at = $2 \
         WHERE id = $3",
    )
    .bind(&password_hash)
    .bind(now())
    .bind(&me.user.id)
    .execute(&mut *tx)
    .await?;
    orbitid_identity::trusted_devices::revoke_all_trusted_devices_on(&mut tx, &me.user.id).await?;
    if sign_out {
        orbitid_identity::sessions::end_sessions_for_user_on(
            &mut tx,
            &state,
            &me.user.id,
            "revoked",
            Some(&me.session.id),
        )
        .await?;
    }
    orbitid_identity::users::upgrade_anonymous_user_on(&mut tx, &me.user.id).await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    // Post-commit, best-effort: the owner is told.
    if let Some(email) = primary_email(&state, &me.user).await? {
        let mut input = SendEmailInput::new(email.email.clone(), EmailTemplate::PasswordChanged);
        if let Some(name) = &me.user.first_name {
            input = input.with_var("user_name", name.clone());
        }
        send_email(&state, input).await;
    }
    let reloaded = reload_user(&state, &me.user.id).await?;
    user_reply(&state, &reloaded, cookies).await
}

pub async fn remove_password(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    OrbitJson(body): OrbitJson<PasswordRemoveBody>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    assert_max_chars(&body.current_password, 256, "current_password")?;
    let Some(hash) = me.user.password_hash.as_deref() else {
        return Err(OrbitError::bad_request(
            error_codes::STRATEGY_FOR_USER_INVALID,
            "This account does not have a password",
        ));
    };
    if !orbitid_credentials::passwords::verify_password(hash, &body.current_password).await {
        // The failed attempt is its own committed transaction: it must survive
        // even though this request is refused.
        record_failed_attempt(&state, &me.user.id).await?;
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PASSWORD_INCORRECT,
            "Current password is incorrect",
        )
        .with_meta(json!({ "param_name": "current_password" })));
    }
    // The last-identification guard takes the user-row lock inside the
    // transaction, so a concurrent deletion of the other identifiers cannot
    // leave the account with no sign-in method.
    let mut tx = state.pool.begin().await?;
    if orbitid_identity::users::guards::count_identifications_on(&mut tx, &me.user.id).await? == 0 {
        return Err(OrbitError::unprocessable(
            error_codes::STRATEGY_FOR_USER_INVALID,
            "You cannot remove your only sign-in method",
        ));
    }
    orbitid_identity::users::reset_failed_attempts_on(&mut tx, &me.user.id).await?;
    sqlx::query(
        "UPDATE users SET password_hash = NULL, password_updated_at = NULL, updated_at = $1 \
         WHERE id = $2",
    )
    .bind(now())
    .bind(&me.user.id)
    .execute(&mut *tx)
    .await?;
    orbitid_identity::trusted_devices::revoke_all_trusted_devices_on(&mut tx, &me.user.id).await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    let reloaded = reload_user(&state, &me.user.id).await?;
    user_reply(&state, &reloaded, cookies).await
}
