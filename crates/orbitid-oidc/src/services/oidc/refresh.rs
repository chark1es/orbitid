//! `grant_type=refresh_token`: rotating refresh tokens, reuse detection, and
//! the short idempotent retry window. Ported from `services/oidc/refresh.ts`.
//!
//! Consuming the presented token, checking the family is still live and
//! inserting its successor + access token happen in one transaction serialized
//! by the family advisory lock.

use async_trait::async_trait;
use orbitid_core::crypto::{decrypt, encrypt, random_token, safe_equal, sha256};
use orbitid_core::error::{OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::OauthGrantRow;
use orbitid_core::state::AppState;

use super::applications::ApplicationRow;
use super::grants::{authorizing_session_active, find_grant_by_id, find_grant_by_token};
use super::revocation::{lock_family, revoke_grant_family};
use super::shared::{parse_scopes, OAuthError};
use super::token_set::{
    authority_snapshot, authority_unchanged_on, insert_planned_token_set, plan_token_set, TokenSet,
    TokenSetInput,
};
use super::tokens::load_user;

/// Test seam around the rotation transaction, mirroring
/// `RefreshExchangeHooks` in the TypeScript service.
#[async_trait]
pub trait RefreshExchangeHooks: Send + Sync {
    /// Runs after the token set was planned but before the rotation transaction
    /// starts. A test can revoke the whole family here and prove no successor is
    /// inserted.
    async fn before_consume(&self) {}
    /// Runs after the authority snapshot was read, before the claims are
    /// planned from it. A test can change organization authority here.
    async fn after_authority_snapshot(&self) {}
    /// Runs after the conditional consumption update but before the
    /// successor/access rows are inserted.
    async fn after_consume(&self) {}
}

/// The default (no-op) hook set.
pub struct NoHooks;

#[async_trait]
impl RefreshExchangeHooks for NoHooks {}

#[derive(Default)]
pub struct RefreshExchangeOptions<'a> {
    pub issuer: Option<&'a str>,
    /// Scopes requested with this refresh; must be a subset of the original grant.
    pub scopes: Option<Vec<String>>,
    pub hooks: Option<&'a (dyn RefreshExchangeHooks + 'a)>,
}

struct RefreshRetry {
    successor: OauthGrantRow,
    token: String,
}

enum TxError {
    Oauth(OAuthError),
    Orbit(OrbitError),
}

impl From<OrbitError> for TxError {
    fn from(error: OrbitError) -> Self {
        Self::Orbit(error)
    }
}

impl From<sqlx::Error> for TxError {
    fn from(error: sqlx::Error) -> Self {
        Self::Orbit(error.into())
    }
}

impl From<OAuthError> for TxError {
    fn from(error: OAuthError) -> Self {
        Self::Oauth(error)
    }
}

fn internal(error: OrbitError) -> OAuthError {
    OAuthError::new(error.status, error.code, error.message)
}

/// A presented token that was already rotated out may be a client retrying a
/// lost response. The window is measured from when *that* token was consumed,
/// never from the successor's creation.
async fn retry_rotated_refresh(
    state: &AppState,
    consumed: &OauthGrantRow,
) -> Result<Option<RefreshRetry>> {
    let (Some(consumed_at), Some(successor_id), Some(sealed)) = (
        consumed.consumed_at,
        consumed.successor_id.as_deref(),
        consumed.successor_token_enc.as_deref(),
    ) else {
        return Ok(None);
    };
    let grace_seconds = state
        .settings
        .get()
        .oidc_provider
        .refresh_token_reuse_grace_seconds;
    if grace_seconds <= 0 || now() - consumed_at > grace_seconds * 1000 {
        return Ok(None);
    }
    let Some(successor) = find_grant_by_id(state, successor_id).await? else {
        return Ok(None);
    };
    if successor.kind != "refresh" || successor.revoked || successor.expires_at <= now() {
        return Ok(None);
    }
    let Ok(token) = decrypt(&state.env.encryption_key, sealed) else {
        return Ok(None);
    };
    if !safe_equal(&sha256(&token), &successor.token_hash) {
        return Ok(None);
    }
    Ok(Some(RefreshRetry { successor, token }))
}

/// Whether a rotation family has been revoked as a whole. A consumed rotation
/// predecessor is `revoked` too, but it carries `consumed_at`.
async fn family_is_revoked(conn: &mut sqlx::PgConnection, family: &str) -> Result<bool> {
    if family.is_empty() {
        return Ok(false);
    }
    let row: Option<String> = sqlx::query_scalar(
        "SELECT id FROM oauth_grants \
         WHERE family_id = $1 AND kind = 'refresh' AND revoked = true AND consumed_at IS NULL \
         LIMIT 1",
    )
    .bind(family)
    .fetch_optional(&mut *conn)
    .await?;
    Ok(row.is_some())
}

/// Mints a token set into an existing family, serialized against family revocation.
async fn issue_token_set_in_live_family(
    state: &AppState,
    input: &TokenSetInput<'_>,
    family: &str,
) -> std::result::Result<TokenSet, OAuthError> {
    let authority = authority_snapshot(state, &input.user.id, input.session_id)
        .await
        .map_err(internal)?;
    let plan = plan_token_set(state, input, &authority)
        .await
        .map_err(internal)?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|error| internal(error.into()))?;
    let outcome: std::result::Result<(), TxError> = async {
        // Re-check eligibility under the key-share: the unlocked `banned`
        // read earlier can be stale if a ban committed since.
        let eligible =
            orbitid_identity::locks::key_share_active_user_on(&mut tx, &input.user.id).await?;
        if !matches!(eligible, Some(state) if !state.banned) {
            return Err(OAuthError::invalid_grant("User is not allowed to sign in").into());
        }
        if !authority_unchanged_on(&mut tx, state, &input.user.id, &authority).await? {
            return Err(OAuthError::invalid_grant(
                "The organization authority of this grant has changed",
            )
            .into());
        }
        lock_family(&mut tx, family).await?;
        if family_is_revoked(&mut tx, family).await? {
            return Err(OAuthError::invalid_grant("Refresh token family has been revoked").into());
        }
        insert_planned_token_set(&mut tx, &plan).await?;
        Ok(())
    }
    .await;
    match outcome {
        Ok(()) => {
            tx.commit().await.map_err(|error| internal(error.into()))?;
            Ok(plan.set)
        }
        Err(TxError::Oauth(error)) => {
            tx.rollback().await.ok();
            Err(error)
        }
        Err(TxError::Orbit(error)) => {
            tx.rollback().await.ok();
            Err(internal(error))
        }
    }
}

/// `grant_type=refresh_token`: rotating refresh tokens with reuse detection and
/// a short retry grace window.
pub async fn exchange_refresh_token(
    state: &AppState,
    application: &ApplicationRow,
    refresh_token: &str,
    options: RefreshExchangeOptions<'_>,
) -> std::result::Result<TokenSet, OAuthError> {
    let row = find_grant_by_token(state, refresh_token)
        .await
        .map_err(internal)?
        .filter(|row| row.kind == "refresh" && row.application_id == application.id)
        .ok_or_else(|| OAuthError::invalid_grant("Refresh token is invalid"))?;
    let family = row.family_id.clone().unwrap_or_default();
    let mut active = row.clone();
    let mut replay = None;
    if row.revoked {
        replay = retry_rotated_refresh(state, &row).await.map_err(internal)?;
        let Some(retry) = replay.as_ref() else {
            // A rotated-out token outside the grace window, or one whose family
            // is already dead: assume theft.
            revoke_grant_family(state, &family)
                .await
                .map_err(internal)?;
            return Err(OAuthError::invalid_grant(
                "Refresh token has already been used",
            ));
        };
        active = retry.successor.clone();
    }
    if active.expires_at <= now() {
        return Err(OAuthError::invalid_grant("Refresh token has expired"));
    }
    if !authorizing_session_active(state, active.session_id.as_deref())
        .await
        .map_err(internal)?
    {
        revoke_grant_family(state, &family)
            .await
            .map_err(internal)?;
        return Err(OAuthError::invalid_grant(
            "The session that authorized this refresh token has ended",
        ));
    }
    let Some(user) = load_user(state, &active.user_id)
        .await
        .map_err(internal)?
        .filter(|user| !user.banned)
    else {
        revoke_grant_family(state, &family)
            .await
            .map_err(internal)?;
        return Err(OAuthError::invalid_grant("User is not allowed to sign in"));
    };

    let original_scopes = parse_scopes(&active.scopes);
    let mut scopes = original_scopes.clone();
    if let Some(requested) = options.scopes.as_ref().filter(|value| !value.is_empty()) {
        let mut unique: Vec<String> = Vec::new();
        for scope in requested {
            if !unique.contains(scope) {
                unique.push(scope.clone());
            }
        }
        let escalated: Vec<&str> = unique
            .iter()
            .filter(|scope| !original_scopes.contains(scope))
            .map(String::as_str)
            .collect();
        if !escalated.is_empty() {
            return Err(OAuthError::bad_request(
                "invalid_scope",
                format!("Scope was not granted: {}", escalated.join(", ")),
            ));
        }
        scopes = unique;
    }

    if let Some(retry) = replay {
        // Idempotent retry: hand back the same successor refresh token.
        return issue_token_set_in_live_family(
            state,
            &TokenSetInput {
                application,
                user: &user,
                scopes: &scopes,
                family: &family,
                nonce: None,
                session_id: active.session_id.as_deref(),
                issuer: options.issuer,
                refresh: None,
                reuse_refresh_token: Some(&retry.token),
            },
            &family,
        )
        .await;
    }

    // Everything that needs a read is prepared first; the conditional
    // consumption, the revoked-family check and both new rows then happen in one
    // transaction.
    let now_ms = now();
    let authority = authority_snapshot(state, &user.id, active.session_id.as_deref())
        .await
        .map_err(internal)?;
    if let Some(hooks) = options.hooks {
        hooks.after_authority_snapshot().await;
    }
    let successor_id = new_id(id_prefix::OAUTH_GRANT);
    let successor_token = format!("ort_{}", random_token(32));
    let plan = plan_token_set(
        state,
        &TokenSetInput {
            application,
            user: &user,
            scopes: &scopes,
            family: &family,
            nonce: None,
            session_id: active.session_id.as_deref(),
            issuer: options.issuer,
            refresh: Some((successor_id.clone(), successor_token.clone())),
            reuse_refresh_token: None,
        },
        &authority,
    )
    .await
    .map_err(internal)?;
    if let Some(hooks) = options.hooks {
        hooks.before_consume().await;
    }
    let sealed = encrypt(&state.env.encryption_key, &successor_token)
        .map_err(|error| internal(OrbitError::internal(error.to_string())))?;
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|error| internal(error.into()))?;
    let outcome: std::result::Result<bool, TxError> = async {
        // Re-check eligibility under the key-share: the unlocked `banned`
        // read earlier can be stale if a ban committed since.
        let eligible = orbitid_identity::locks::key_share_active_user_on(&mut tx, &user.id).await?;
        if !matches!(eligible, Some(state) if !state.banned) {
            return Err(OAuthError::invalid_grant("User is not allowed to sign in").into());
        }
        if !authority_unchanged_on(&mut tx, state, &user.id, &authority).await? {
            return Err(OAuthError::invalid_grant(
                "The organization authority of this grant has changed",
            )
            .into());
        }
        lock_family(&mut tx, &family).await?;
        let updated = sqlx::query_scalar::<_, String>(
            "UPDATE oauth_grants SET revoked = true, consumed_at = $2, successor_id = $3, \
             successor_token_enc = $4 \
             WHERE id = $1 AND revoked = false AND consumed_at IS NULL AND expires_at > $5 \
             RETURNING id",
        )
        .bind(&active.id)
        .bind(now_ms)
        .bind(&successor_id)
        .bind(&sealed)
        .bind(now_ms)
        .fetch_optional(&mut *tx)
        .await?;
        if updated.is_none() {
            return Ok(false);
        }
        if let Some(hooks) = options.hooks {
            hooks.after_consume().await;
        }
        if family_is_revoked(&mut tx, &family).await? {
            return Err(TxError::Oauth(OAuthError::invalid_grant(
                "Refresh token family has been revoked",
            )));
        }
        insert_planned_token_set(&mut tx, &plan).await?;
        Ok(true)
    }
    .await;
    let claimed = match outcome {
        Ok(claimed) => {
            if claimed {
                tx.commit().await.map_err(|error| internal(error.into()))?;
            } else {
                tx.rollback().await.ok();
            }
            claimed
        }
        Err(TxError::Oauth(error)) => {
            tx.rollback().await.ok();
            return Err(error);
        }
        Err(TxError::Orbit(error)) => {
            tx.rollback().await.ok();
            return Err(internal(error));
        }
    };
    if !claimed {
        // Another request consumed this token first. That is a concurrent
        // refresh, not necessarily theft: use the grace path, and never kill the
        // family solely because we lost the race.
        let fresh = find_grant_by_id(state, &active.id)
            .await
            .map_err(internal)?;
        let retry = match fresh {
            Some(fresh) => retry_rotated_refresh(state, &fresh)
                .await
                .map_err(internal)?,
            None => None,
        };
        let Some(retry) = retry else {
            revoke_grant_family(state, &family)
                .await
                .map_err(internal)?;
            return Err(OAuthError::invalid_grant(
                "Refresh token has already been used",
            ));
        };
        return issue_token_set_in_live_family(
            state,
            &TokenSetInput {
                application,
                user: &user,
                scopes: &scopes,
                family: &family,
                nonce: None,
                session_id: retry.successor.session_id.as_deref(),
                issuer: options.issuer,
                refresh: None,
                reuse_refresh_token: Some(&retry.token),
            },
            &family,
        )
        .await;
    }
    Ok(plan.set)
}
