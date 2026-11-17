//! The `handleExternalIdentity` sign-in/sign-up state machine shared by social
//! OAuth and enterprise SAML/OIDC. Ported from
//! `services/external-identity.ts`.

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{SignInRow, SignUpRow};
use orbitid_core::state::AppState;
use orbitid_identity::enterprise_access::assert_additional_identifications_allowed;
use orbitid_identity::external_identity::{
    assert_sign_in_identity_allowed, find_external_account, link_external_account_on,
    profile_email_may_link, ExternalProfile,
};
use orbitid_identity::restrictions::{assert_identifiers_allowed, IdentifiersToCheck};
use orbitid_identity::users::{find_email, find_user_by_verified_email, get_user_by_id};

use crate::signin::core::stash_transfer_profile;
use crate::signup::core::{
    apply_external_profile, assert_sign_up_identifiers, maybe_complete_sign_up, reload_sign_up,
    CompleteSignUpOptions, SignUpIdentifierOptions,
};
use crate::util::with_query;

use crate::external_signin::{complete_sign_up_for_existing_user, sign_in_existing_user};

#[derive(Clone)]
pub struct ExternalIdentityFlow {
    pub client_id: String,
    /// `sign_in`, `sign_up` or `connect`.
    pub kind: String,
    pub owner_id: Option<String>,
    pub user_id: Option<String>,
    pub redirect_url: String,
    pub action_complete_redirect_url: Option<String>,
    pub trusted_device_token: Option<String>,
}

impl std::fmt::Debug for ExternalIdentityFlow {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExternalIdentityFlow")
            .field("client_id", &self.client_id)
            .field("kind", &self.kind)
            .field("owner_id", &self.owner_id)
            .field("user_id", &self.user_id)
            .field("redirect_url", &self.redirect_url)
            .field(
                "action_complete_redirect_url",
                &self.action_complete_redirect_url,
            )
            .field("trusted_device_token", &"<redacted>")
            .finish()
    }
}

impl ExternalIdentityFlow {
    pub fn target(&self) -> String {
        self.action_complete_redirect_url
            .clone()
            .unwrap_or_else(|| self.redirect_url.clone())
    }
}

#[derive(Clone, Default)]
pub struct ExternalIdentityResult {
    pub redirect_to: String,
    pub trusted_device_token: Option<String>,
    pub trusted_device_expires_at: Option<i64>,
    pub clear_trusted_device: bool,
}

impl std::fmt::Debug for ExternalIdentityResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ExternalIdentityResult")
            .field("redirect_to", &self.redirect_to)
            .field("trusted_device_token", &"<redacted>")
            .field("trusted_device_expires_at", &self.trusted_device_expires_at)
            .field("clear_trusted_device", &self.clear_trusted_device)
            .finish()
    }
}

pub(crate) fn status_url(target: &str, status: &str) -> String {
    with_query(target, &[("__orbit_status", Some(status))])
}

fn is_enterprise(provider: &str) -> bool {
    provider.starts_with("enterprise_")
}

pub(crate) fn sign_in_strategy_for(provider: &str) -> String {
    if is_enterprise(provider) {
        "enterprise_sso".to_string()
    } else {
        format!("oauth_{provider}")
    }
}

async fn abandon_other_attempts(
    state: &AppState,
    client_id: &str,
    kind: &str,
    except_id: &str,
) -> Result<()> {
    let now = now();
    if kind == "sign_in" {
        sqlx::query(
            "UPDATE sign_ins SET status = 'abandoned', version = version + 1, updated_at = $1 \
             WHERE client_id = $2 AND id <> $3 AND status NOT IN ('complete','abandoned')",
        )
        .bind(now)
        .bind(client_id)
        .bind(except_id)
        .execute(&state.pool)
        .await?;
    } else {
        sqlx::query(
            "UPDATE sign_ups SET status = 'abandoned', version = version + 1, updated_at = $1 \
             WHERE client_id = $2 AND id <> $3 AND status NOT IN ('complete','abandoned')",
        )
        .bind(now)
        .bind(client_id)
        .bind(except_id)
        .execute(&state.pool)
        .await?;
    }
    Ok(())
}

async fn new_sign_in(
    state: &AppState,
    flow: &ExternalIdentityFlow,
    identifier: Option<&str>,
    user_id: Option<&str>,
    first_strategy: Option<&str>,
) -> Result<SignInRow> {
    let now = now();
    let id = new_id(id_prefix::SIGN_IN);
    let state_json = match first_strategy {
        Some(strategy) => serde_json::json!({
            "first": { "strategy": strategy, "status": "verified" },
        }),
        None => serde_json::json!({}),
    };
    sqlx::query(
        "INSERT INTO sign_ins (id, client_id, status, identifier, user_id, state, abandon_at, created_at, updated_at) \
         VALUES ($1,$2,'needs_first_factor',$3,$4,$5,$6,$7,$7)",
    )
    .bind(&id)
    .bind(&flow.client_id)
    .bind(identifier)
    .bind(user_id)
    .bind(sqlx::types::Json(state_json))
    .bind(now + 86_400_000)
    .bind(now)
    .execute(&state.pool)
    .await?;
    crate::signin::core::reload_sign_in(state, &id).await
}

async fn new_sign_up(state: &AppState, flow: &ExternalIdentityFlow) -> Result<SignUpRow> {
    let now = now();
    let id = new_id(id_prefix::SIGN_UP);
    sqlx::query(
        "INSERT INTO sign_ups (id, client_id, status, fields, unsafe_metadata, verifications, \
         abandon_at, created_at, updated_at) \
         VALUES ($1,$2,'missing_requirements','{}'::jsonb,'{}'::jsonb,'{}'::jsonb,$3,$4,$4)",
    )
    .bind(&id)
    .bind(&flow.client_id)
    .bind(now + 86_400_000)
    .bind(now)
    .execute(&state.pool)
    .await?;
    reload_sign_up(state, &id).await
}

/// Resolves an authenticated external identity inside a client's flow.
pub async fn handle_external_identity(
    state: &AppState,
    flow: &ExternalIdentityFlow,
    profile: &ExternalProfile,
) -> Result<ExternalIdentityResult> {
    match resolve_external_identity(state, flow, profile).await {
        Ok(result) => Ok(result),
        // A database or key failure is not an authentication outcome: the caller
        // must see the 500 (TS rethrows anything that is not an `OrbitError`).
        Err(error) if error.status.is_server_error() => Err(error),
        Err(error) => Ok(ExternalIdentityResult {
            redirect_to: with_query(
                &flow.target(),
                &[
                    ("__orbit_error", Some(error.code.as_str())),
                    ("__orbit_error_message", Some(error.message.as_str())),
                ],
            ),
            ..Default::default()
        }),
    }
}

async fn resolve_external_identity(
    state: &AppState,
    flow: &ExternalIdentityFlow,
    profile: &ExternalProfile,
) -> Result<ExternalIdentityResult> {
    let account =
        find_external_account(state, &profile.provider, &profile.provider_user_id).await?;

    if flow.kind == "connect" {
        let Some(user_id) = &flow.user_id else {
            return Err(OrbitError::bad_request(
                error_codes::CLIENT_STATE_INVALID,
                "No user to connect the account to",
            ));
        };
        assert_additional_identifications_allowed(state, user_id).await?;
        if let Some(owner) = account.as_ref().and_then(|account| account.user_id.clone()) {
            if &owner != user_id {
                return Err(OrbitError::conflict(
                    error_codes::EXTERNAL_ACCOUNT_EXISTS,
                    "This external account is already linked to another user",
                ));
            }
        }
        let guest = get_user_by_id(state, user_id).await?;
        if guest.map(|guest| guest.is_anonymous).unwrap_or(false) {
            let settings = state.settings.get();
            let restricted = settings.restrictions.allowlist_enabled
                || settings.sign_up.mode != orbitid_core::settings::types::SignUpMode::Public;
            if let Some(email) = &profile.email {
                assert_identifiers_allowed(
                    state,
                    &IdentifiersToCheck {
                        emails: vec![email.clone()],
                        phones: Vec::new(),
                        invitation_ticket: None,
                    },
                    false,
                )
                .await?;
            }
            if restricted && !(profile.email.is_some() && profile.email_verified == Some(true)) {
                return Err(OrbitError::unprocessable(
                    error_codes::NOT_ALLOWED_ACCESS,
                    "This account does not share a verified email address, which this instance requires to sign up.",
                ));
            }
        }
        let mut tx = state.pool.begin().await?;
        // Rank 2 before the `users` write below.
        orbitid_identity::locks::lock_client_on(&mut tx, &flow.client_id).await?;
        let linked = link_external_account_on(&mut tx, state, user_id, profile).await?;
        sqlx::query(
            "UPDATE users SET is_anonymous = false, updated_at = $1 \
             WHERE id = $2 AND is_anonymous = true AND ( \
                 EXISTS(SELECT 1 FROM email_addresses WHERE user_id = $2 AND verified = true) \
                 OR EXISTS(SELECT 1 FROM phone_numbers WHERE user_id = $2 AND verified = true) \
                 OR EXISTS(SELECT 1 FROM external_accounts WHERE user_id = $2) \
             )",
        )
        .bind(now())
        .bind(user_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        return Ok(ExternalIdentityResult {
            redirect_to: with_query(
                &flow.target(),
                &[
                    ("__orbit_status", Some("connected")),
                    ("external_account_id", Some(linked.id.as_str())),
                ],
            ),
            ..Default::default()
        });
    }

    if flow.kind == "sign_up" {
        let owner_id = match &flow.owner_id {
            Some(owner_id) => owner_id.clone(),
            None => new_sign_up(state, flow).await?.id,
        };
        let sign_up = reload_sign_up(state, &owner_id).await?;
        let existing_user = match account.as_ref().and_then(|account| account.user_id.clone()) {
            Some(user_id) => get_user_by_id(state, &user_id).await?,
            None => None,
        };
        if let Some(existing) = existing_user {
            assert_sign_in_identity_allowed(state, profile.email.as_deref()).await?;
            return complete_sign_up_for_existing_user(
                state,
                flow,
                &sign_up.id,
                &existing,
                profile,
            )
            .await;
        }
        let verified_email_user = if profile_email_may_link(profile) {
            find_user_by_verified_email(state, profile.email.as_deref().unwrap_or_default()).await?
        } else {
            None
        };
        if let Some(verified) = verified_email_user {
            assert_sign_in_identity_allowed(state, profile.email.as_deref()).await?;
            return complete_sign_up_for_existing_user(
                state,
                flow,
                &sign_up.id,
                &verified,
                profile,
            )
            .await;
        }
        if let Some(email) = &profile.email {
            let claimed = find_email(state, email).await?;
            if claimed
                .as_ref()
                .map(|claimed| {
                    claimed.user_id.is_some()
                        && (claimed.verified || profile.email_verified != Some(true))
                })
                .unwrap_or(false)
            {
                return Err(OrbitError::unprocessable(
                    error_codes::FORM_IDENTIFIER_EXISTS,
                    "That email address is already in use",
                ));
            }
        }
        if let Some(email) = &profile.email {
            assert_sign_up_identifiers(
                state,
                &crate::state::SignUpFields {
                    email_address: Some(email.clone()),
                    ..Default::default()
                },
                &SignUpIdentifierOptions {
                    verified_email: profile.email_verified == Some(true),
                    ..Default::default()
                },
            )
            .await?;
        }
        let updated = apply_external_profile(state, &sign_up, profile).await?;
        let completed =
            maybe_complete_sign_up(state, &updated, &CompleteSignUpOptions::default()).await?;
        if completed.is_some() {
            abandon_other_attempts(state, &flow.client_id, "sign_up", &sign_up.id).await?;
        }
        return Ok(ExternalIdentityResult {
            redirect_to: status_url(
                &flow.target(),
                if completed.is_some() {
                    "complete"
                } else {
                    "missing_requirements"
                },
            ),
            ..Default::default()
        });
    }

    // kind === "sign_in"
    assert_sign_in_identity_allowed(state, profile.email.as_deref()).await?;
    let existing_user = match account.as_ref().and_then(|account| account.user_id.clone()) {
        Some(user_id) => get_user_by_id(state, &user_id).await?,
        None => None,
    };
    if let Some(existing) = existing_user {
        return sign_in_existing_user(state, flow, &existing, profile).await;
    }
    if let Some(account) = &account {
        if account.user_id.is_none() {
            sqlx::query("DELETE FROM external_accounts WHERE id = $1")
                .bind(&account.id)
                .execute(&state.pool)
                .await?;
        }
    }
    let verified_email_user = if profile_email_may_link(profile) {
        find_user_by_verified_email(state, profile.email.as_deref().unwrap_or_default()).await?
    } else {
        None
    };
    if let Some(verified) = verified_email_user {
        return sign_in_existing_user(state, flow, &verified, profile).await;
    }
    let owner_id = match &flow.owner_id {
        Some(owner_id) => owner_id.clone(),
        None => {
            new_sign_in(state, flow, profile.email.as_deref(), None, None)
                .await?
                .id
        }
    };
    let row = crate::signin::core::reload_sign_in(state, &owner_id).await?;
    let strategy = sign_in_strategy_for(&profile.provider);
    stash_transfer_profile(state, &row, profile, &strategy).await?;
    abandon_other_attempts(state, &flow.client_id, "sign_in", &row.id).await?;
    Ok(ExternalIdentityResult {
        redirect_to: status_url(&flow.target(), "transferable"),
        ..Default::default()
    })
}
