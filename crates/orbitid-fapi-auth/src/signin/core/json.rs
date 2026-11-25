//! `SignInJSON`, the banned/locked guard and the ticket refusal.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::models::{SignInRow, UserRow};
use orbitid_core::resources::{SignInJson, SignInStatus, SignInUserData};
use orbitid_core::state::AppState;
use orbitid_credentials::{supported_second_factors, SecondFactorOptions};
use orbitid_identity::serializers::{serialize_user, UserSerializeOptions};

use super::attempts::as_sign_in_state;
use super::factors::{compute_first_factors, factor_json, supported_identifiers};

fn parse_status(value: &str) -> SignInStatus {
    match value {
        "needs_first_factor" => SignInStatus::NeedsFirstFactor,
        "needs_second_factor" => SignInStatus::NeedsSecondFactor,
        "needs_new_password" => SignInStatus::NeedsNewPassword,
        "complete" => SignInStatus::Complete,
        _ => SignInStatus::NeedsIdentifier,
    }
}

/// `buildSignInJSON`.
pub async fn build_sign_in_json(state: &AppState, row: &SignInRow) -> Result<SignInJson> {
    let sign_in_state = as_sign_in_state(row);
    let user = match &row.user_id {
        Some(id) => orbitid_identity::users::get_user_by_id(state, id).await?,
        None => None,
    };
    let user_json = match &user {
        Some(user) => Some(serialize_user(state, user, UserSerializeOptions::default()).await?),
        None => None,
    };
    let requested_reset = sign_in_state.requested_reset.unwrap_or(false)
        || sign_in_state
            .first
            .as_ref()
            .map(|first| first.strategy.starts_with("reset_password"))
            .unwrap_or(false);
    let decoy = sign_in_state.decoy.as_ref().filter(|_| user.is_none());
    let supported_first_factors = match (&user, decoy) {
        (Some(user), _) => Some(compute_first_factors(state, user, requested_reset).await?),
        (None, Some(decoy)) => Some(crate::signin::decoy::first_factors(
            state,
            row.identifier.as_deref().unwrap_or_default(),
            decoy,
            requested_reset,
        )),
        (None, None) => None,
    };
    let supported_second_factors_json = match &user {
        Some(user) => Some(
            supported_second_factors(
                state,
                user,
                SecondFactorOptions {
                    first_factor_strategy: sign_in_state.first.as_ref().map(|f| f.strategy.clone()),
                    first_factor_email_id: sign_in_state
                        .first
                        .as_ref()
                        .and_then(|f| f.email_id.clone()),
                    first_factor_phone_id: sign_in_state
                        .first
                        .as_ref()
                        .and_then(|f| f.phone_id.clone()),
                },
            )
            .await?,
        ),
        // A real account's list at this stage, as far as the factors a decoy offers go.
        None if decoy.is_some() => Some(Vec::new()),
        None => None,
    };
    // Who the account belongs to is not shown before the first factor proves it, or a name would tell an
    // existing account from a decoy.
    let hide_profile = state.settings.get().security.enumeration_protection
        && matches!(
            row.status.as_str(),
            "needs_identifier" | "needs_first_factor"
        );
    let user_data = user_json
        .as_ref()
        .filter(|_| !hide_profile)
        .map(|json| SignInUserData {
            first_name: json.first_name.clone(),
            last_name: json.last_name.clone(),
            image_url: json.image_url.clone(),
            has_image: json.has_image,
        });
    Ok(SignInJson {
        object: "sign_in".into(),
        id: row.id.clone(),
        status: parse_status(&row.status),
        supported_identifiers: supported_identifiers(state),
        supported_first_factors,
        supported_second_factors: supported_second_factors_json,
        first_factor_verification: factor_json(state, sign_in_state.first.as_ref()).await?,
        second_factor_verification: factor_json(state, sign_in_state.second.as_ref()).await?,
        identifier: row.identifier.clone(),
        user_data,
        created_session_id: row.created_session_id.clone(),
        abandon_at: row.abandon_at,
    })
}

/// Throws when the user is banned or locked.
pub fn assert_sign_in_allowed(user: &UserRow) -> Result<()> {
    if user.banned {
        return Err(OrbitError::forbidden(
            error_codes::USER_BANNED,
            "This user has been banned",
        ));
    }
    if user.locked
        && user
            .lockout_expires_at
            .map(|expires| expires > now())
            .unwrap_or(true)
    {
        let seconds = user
            .lockout_expires_at
            .map(|expires| ((expires - now()) as f64 / 1000.0).ceil() as i64);
        return Err(OrbitError::forbidden(
            error_codes::USER_LOCKED,
            "This account is locked due to too many failed attempts",
        )
        .with_meta(serde_json::json!({ "lockout_expires_in_seconds": seconds })));
    }
    Ok(())
}

/// A presented ticket is always refused: operator sign-in tickets were removed.
pub fn resolve_ticket(_state: &AppState, _ticket: &str) -> OrbitError {
    OrbitError::unprocessable(
        error_codes::TICKET_INVALID,
        "This ticket is invalid. Sign in with your own credentials.",
    )
}
