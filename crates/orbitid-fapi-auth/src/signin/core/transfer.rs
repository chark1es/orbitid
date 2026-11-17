//! Stashed OAuth profiles carried from sign-in to sign-up.

use orbitid_core::error::Result;
use orbitid_core::models::SignInRow;
use orbitid_core::state::AppState;
use orbitid_identity::external_identity::ExternalProfile;

use crate::state::{FactorState, StashedProfile};

use super::attempts::{as_sign_in_state, save_sign_in_state, transition_sign_in, SignInTransition};

pub async fn stash_transfer_profile(
    state: &AppState,
    row: &SignInRow,
    profile: &ExternalProfile,
    strategy: &str,
) -> Result<()> {
    let sign_in_state = as_sign_in_state(row);
    let encrypt = |value: &Option<String>| -> Option<String> {
        value
            .as_ref()
            .and_then(|value| orbitid_core::crypto::encrypt(&state.env.encryption_key, value).ok())
    };
    let stashed = StashedProfile {
        provider: profile.provider.clone(),
        provider_user_id: profile.provider_user_id.clone(),
        email: profile.email.clone(),
        email_verified: profile.email_verified,
        first_name: profile.first_name.clone(),
        last_name: profile.last_name.clone(),
        username: profile.username.clone(),
        image_url: profile.image_url.clone(),
        scopes: profile.scopes.clone(),
        access_token_enc: encrypt(&profile.access_token),
        refresh_token_enc: encrypt(&profile.refresh_token),
    };
    let mut next = sign_in_state;
    next.first = Some(FactorState::new(strategy).status("transferable"));
    next.transfer_profile = Some(stashed);
    transition_sign_in(
        state,
        row,
        SignInTransition {
            status: Some("needs_first_factor"),
            state: Some(&next),
            ..Default::default()
        },
    )
    .await?;
    Ok(())
}

/// Reads + decrypts a stashed OAuth profile.
pub fn read_transfer_profile(state: &AppState, row: &SignInRow) -> Option<ExternalProfile> {
    let stashed = as_sign_in_state(row).transfer_profile?;
    let decrypt = |value: &Option<String>| -> Option<String> {
        value
            .as_ref()
            .and_then(|value| orbitid_core::crypto::decrypt(&state.env.encryption_key, value).ok())
    };
    Some(ExternalProfile {
        provider: stashed.provider,
        provider_user_id: stashed.provider_user_id,
        email: stashed.email,
        email_verified: stashed.email_verified,
        first_name: stashed.first_name,
        last_name: stashed.last_name,
        username: stashed.username,
        image_url: stashed.image_url,
        access_token: decrypt(&stashed.access_token_enc),
        refresh_token: decrypt(&stashed.refresh_token_enc),
        expires_at: None,
        scopes: stashed.scopes,
    })
}

/// Clears the transferable state once the SDK moved it to a sign-up.
pub async fn clear_transfer_profile(state: &AppState, row: &SignInRow) -> Result<()> {
    let mut next = as_sign_in_state(row);
    next.transfer_profile = None;
    next.first = None;
    save_sign_in_state(state, row, &next).await?;
    Ok(())
}

/// Latest sign-in that carries a transferable OAuth profile.
pub async fn latest_transferable_sign_in(
    state: &AppState,
    client_id: &str,
) -> Result<Option<SignInRow>> {
    // The profile flag is stored in the state JSON; filter and limit in SQL so
    // a client with a long sign-in history is not loaded row by row.
    let row = sqlx::query_as::<_, SignInRow>(
        "SELECT * FROM sign_ins WHERE client_id = $1 AND state ? 'transferProfile' \
         ORDER BY created_at DESC LIMIT 1",
    )
    .bind(client_id)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row)
}
