//! OIDC/OAuth2 provider service: authorization codes, access/refresh tokens,
//! consent, revocation and introspection. Ported from `services/oidc/tokens.ts`.

use orbitid_core::crypto::{random_token, safe_equal, sha256};
use orbitid_core::error::{OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{OauthGrantRow, UserRow};
use orbitid_core::state::AppState;

use orbitid_credentials::jwt::{verify_jws, Jwk, JwkSet, JwsAlgorithm, VerifyOptions};
use orbitid_credentials::keys::get_jwks;

use super::applications::{get_application, pkce_challenge_for, ApplicationRow};
use super::claims::primary_email;
pub use super::consent::{has_consent, record_consent, record_consent_on, stored_consent};
use super::grants::{authorizing_session_active, find_grant_by_token, is_grant_live};
use super::revocation::revoke_grant_family;
use super::shared::{parse_scopes, OAuthError, AUTHORIZATION_CODE_TTL_SECONDS};
use super::token_set::{
    authority_snapshot, authority_unchanged_on, insert_planned_token_set, plan_token_set,
    GrantInsert, TokenSet, TokenSetInput,
};

#[derive(Debug, Clone)]
pub struct IssueCodeInput<'a> {
    pub application: &'a ApplicationRow,
    pub user_id: &'a str,
    pub scopes: &'a [String],
    pub redirect_uri: &'a str,
    pub code_challenge: Option<&'a str>,
    pub code_challenge_method: Option<&'a str>,
    pub nonce: Option<&'a str>,
    /// The browser session that authorized the request (org claims, `sid`).
    pub session_id: Option<&'a str>,
}

pub async fn issue_authorization_code(
    state: &AppState,
    input: IssueCodeInput<'_>,
) -> Result<String> {
    let mut conn = state.pool.acquire().await?;
    issue_authorization_code_on(&mut conn, state, input).await
}

/// [`issue_authorization_code`] on a caller-owned connection, so the consent
/// record and the code it authorizes commit together.
pub async fn issue_authorization_code_on(
    conn: &mut sqlx::PgConnection,
    _state: &AppState,
    input: IssueCodeInput<'_>,
) -> Result<String> {
    let code = format!("oac_{}", random_token(32));
    let now_ms = now();
    super::token_set::insert_grant_on(
        conn,
        &GrantInsert {
            id: new_id(id_prefix::OAUTH_GRANT),
            kind: "code",
            application_id: input.application.id.clone(),
            user_id: input.user_id.to_string(),
            token_hash: sha256(&code),
            scopes: input.scopes.join(" "),
            redirect_uri: Some(input.redirect_uri.to_string()),
            code_challenge: input.code_challenge.map(str::to_string),
            code_challenge_method: input
                .code_challenge
                .map(|_| input.code_challenge_method.unwrap_or("S256").to_string()),
            nonce: input
                .nonce
                .filter(|value| !value.is_empty())
                .map(str::to_string),
            family_id: None,
            session_id: input.session_id.map(str::to_string),
            revoked: false,
            expires_at: now_ms + AUTHORIZATION_CODE_TTL_SECONDS * 1000,
            created_at: now_ms,
        },
    )
    .await?;
    Ok(code)
}

#[derive(Debug, Clone)]
pub struct CodeExchangeInput<'a> {
    pub application: &'a ApplicationRow,
    pub code: &'a str,
    pub redirect_uri: Option<&'a str>,
    pub code_verifier: Option<&'a str>,
    pub issuer: Option<&'a str>,
}

/// `grant_type=authorization_code`: single use, PKCE enforced for public /
/// pkceRequired clients.
pub async fn exchange_authorization_code(
    state: &AppState,
    input: CodeExchangeInput<'_>,
) -> std::result::Result<TokenSet, OAuthError> {
    exchange_authorization_code_with_hooks(state, input, None).await
}

/// [`exchange_authorization_code`] with the test seam of the refresh rotation:
/// `before_consume` runs after planning and before the transaction starts,
/// `after_consume` after the code row was claimed and before the token rows are
/// inserted (the code row lock is held, nothing is committed).
pub async fn exchange_authorization_code_with_hooks(
    state: &AppState,
    input: CodeExchangeInput<'_>,
    hooks: Option<&(dyn super::refresh::RefreshExchangeHooks + '_)>,
) -> std::result::Result<TokenSet, OAuthError> {
    let row = find_grant_by_token(state, input.code)
        .await
        .map_err(internal_oauth_error)?;
    let Some(row) = row else {
        return Err(OAuthError::invalid_grant(
            "Authorization code is invalid or expired",
        ));
    };
    if row.kind != "code" || row.application_id != input.application.id {
        return Err(OAuthError::invalid_grant(
            "Authorization code is invalid or expired",
        ));
    }
    if row.revoked {
        // A consumed code presented again (even after its own expiry): RFC 6749
        // §4.1.2 / OIDC Core 3.1.3.2 treat this as a possible leak, so every
        // token the first exchange issued from it is revoked. The family id was
        // recorded on the code row by that exchange.
        revoke_code_family(state, &row.id)
            .await
            .map_err(internal_oauth_error)?;
        return Err(OAuthError::invalid_grant(
            "Authorization code is invalid or expired",
        ));
    }
    if row.expires_at <= now() {
        return Err(OAuthError::invalid_grant(
            "Authorization code is invalid or expired",
        ));
    }
    if let Some(redirect_uri) = input.redirect_uri {
        if row.redirect_uri.as_deref() != Some(redirect_uri) {
            return Err(OAuthError::invalid_grant(
                "redirect_uri does not match the authorization request",
            ));
        }
    }
    if let Some(challenge) = row.code_challenge.as_deref() {
        let method = row.code_challenge_method.as_deref().unwrap_or("S256");
        if method != "S256" {
            return Err(OAuthError::invalid_grant(
                "Unsupported code_challenge_method",
            ));
        }
        let verified = input
            .code_verifier
            .map(|verifier| safe_equal(&pkce_challenge_for(verifier), challenge))
            .unwrap_or(false);
        if !verified {
            return Err(OAuthError::invalid_grant("PKCE verification failed"));
        }
    } else if input.application.is_public || input.application.pkce_required {
        return Err(OAuthError::invalid_grant(
            "PKCE code_challenge is required for this client",
        ));
    }

    let user = load_user(state, &row.user_id)
        .await
        .map_err(internal_oauth_error)?;
    let Some(user) = user.filter(|user| !user.banned) else {
        return Err(OAuthError::invalid_grant("User is not allowed to sign in"));
    };
    let session_active = authorizing_session_active(state, row.session_id.as_deref())
        .await
        .map_err(internal_oauth_error)?;
    if !session_active {
        return Err(OAuthError::invalid_grant(
            "The session that authorized this code has ended",
        ));
    }
    let scopes = parse_scopes(&row.scopes);
    let family = random_token(9);
    let authority = authority_snapshot(state, &user.id, row.session_id.as_deref())
        .await
        .map_err(internal_oauth_error)?;
    if let Some(hooks) = hooks {
        hooks.after_authority_snapshot().await;
    }
    let plan = plan_token_set(
        state,
        &TokenSetInput {
            application: input.application,
            user: &user,
            scopes: &scopes,
            family: &family,
            nonce: row.nonce.as_deref(),
            session_id: row.session_id.as_deref(),
            issuer: input.issuer,
            refresh: None,
            reuse_refresh_token: None,
        },
        &authority,
    )
    .await
    .map_err(internal_oauth_error)?;

    if let Some(hooks) = hooks {
        hooks.before_consume().await;
    }
    // Consuming the code and inserting the token set happen in one transaction.
    // The code row stays locked until commit, so a concurrent or later replay
    // cannot observe a half-done exchange: its claim fails only after the
    // winner's tokens are committed, which makes revoking them safe.
    let mut tx = state
        .pool
        .begin()
        .await
        .map_err(|error| internal_oauth_error(error.into()))?;
    let outcome: std::result::Result<Claim, OrbitError> = async {
        // Rank 3 before the rank-11 grant row: inserting a grant references
        // `users`, so its key-share lock must be held before the code row is
        // locked, or a user deletion (user → grant family) could cycle.
        // The ban check above was an unlocked read: re-check under the lock
        // (a ban commits `FOR UPDATE` and revokes grants, so after this
        // key-share the flag is final for this transaction).
        let eligible = orbitid_identity::locks::key_share_active_user_on(&mut tx, &user.id).await?;
        if !matches!(eligible, Some(state) if !state.banned) {
            return Ok(Claim::UserBlocked);
        }
        // Organization-authority changes hold this user `FOR UPDATE`; under the
        // key-share the claims planned above are either current or refused.
        if !authority_unchanged_on(&mut tx, state, &user.id, &authority).await? {
            return Ok(Claim::AuthorityChanged);
        }
        let claimed = sqlx::query_scalar::<_, String>(
            "UPDATE oauth_grants SET revoked = true, family_id = $3 \
             WHERE id = $1 AND revoked = false AND expires_at > $2 RETURNING id",
        )
        .bind(&row.id)
        .bind(now())
        .bind(&family)
        .fetch_optional(&mut *tx)
        .await?;
        if claimed.is_none() {
            return Ok(Claim::Replay);
        }
        if let Some(hooks) = hooks {
            hooks.after_consume().await;
        }
        insert_planned_token_set(&mut tx, &plan).await?;
        Ok(Claim::Claimed)
    }
    .await;
    let claimed = match outcome {
        Ok(Claim::Claimed) => {
            tx.commit()
                .await
                .map_err(|error| internal_oauth_error(error.into()))?;
            true
        }
        Ok(Claim::UserBlocked) => {
            tx.rollback().await.ok();
            return Err(OAuthError::invalid_grant("User is not allowed to sign in"));
        }
        Ok(Claim::AuthorityChanged) => {
            tx.rollback().await.ok();
            return Err(OAuthError::invalid_grant(
                "The organization authority of this grant has changed",
            ));
        }
        Ok(Claim::Replay) => {
            tx.rollback().await.ok();
            false
        }
        Err(error) => {
            tx.rollback().await.ok();
            return Err(internal_oauth_error(error));
        }
    };

    if !claimed {
        // RFC 6749 §4.1.2 / OIDC Core 3.1.3.2: a code presented twice means it
        // may have leaked, so every token issued from it is revoked. The family
        // id was recorded on the code row by the first exchange (and committed
        // before this claim could fail), so the revocation covers that set.
        revoke_code_family(state, &row.id)
            .await
            .map_err(internal_oauth_error)?;
        return Err(OAuthError::invalid_grant(
            "Authorization code is invalid or expired",
        ));
    }

    Ok(plan.set)
}

enum Claim {
    Claimed,
    Replay,
    UserBlocked,
    AuthorityChanged,
}

/// Revokes the token family the first exchange of `code_id` recorded, if any.
async fn revoke_code_family(state: &AppState, code_id: &str) -> Result<()> {
    let family: Option<Option<String>> =
        sqlx::query_scalar("SELECT family_id FROM oauth_grants WHERE id = $1")
            .bind(code_id)
            .fetch_optional(&state.pool)
            .await?;
    if let Some(Some(family)) = family {
        revoke_grant_family(state, &family).await?;
    }
    Ok(())
}

fn internal_oauth_error(error: OrbitError) -> OAuthError {
    OAuthError::new(error.status, error.code, error.message)
}

pub async fn load_user(state: &AppState, id: &str) -> Result<Option<UserRow>> {
    Ok(
        sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
            .bind(id)
            .fetch_optional(&state.pool)
            .await?,
    )
}

/// Resolves an access token to its grant + user (userinfo / introspection).
/// Opaque and JWT tokens both work.
pub async fn access_grant_from_token(
    state: &AppState,
    token: &str,
    issuer: Option<&str>,
) -> std::result::Result<(OauthGrantRow, UserRow), OAuthError> {
    let invalid =
        || OAuthError::unauthorized("invalid_token", "Access token is invalid or expired");
    let row = find_grant_by_token(state, token)
        .await
        .map_err(internal_oauth_error)?
        .filter(|row| row.kind == "access" && is_grant_live(row, now()))
        .ok_or_else(invalid)?;
    if !token.starts_with("oat_") {
        // JWT access tokens are recorded, so revocation still wins over an
        // offline-valid signature.
        if !verify_jwt_access_token(state, &row, token, issuer).await {
            return Err(invalid());
        }
    }
    let user = load_user(state, &row.user_id)
        .await
        .map_err(internal_oauth_error)?
        .filter(|user| !user.banned)
        .ok_or_else(|| {
            OAuthError::unauthorized("invalid_token", "User is not allowed to sign in")
        })?;
    // Access tokens are bearer credentials for an application, not a second,
    // session-independent login.
    let active = authorizing_session_active(state, row.session_id.as_deref())
        .await
        .map_err(internal_oauth_error)?;
    if !active {
        return Err(OAuthError::unauthorized(
            "invalid_token",
            "The session that authorized this access token has ended",
        ));
    }
    Ok((row, user))
}

async fn verify_jwt_access_token(
    state: &AppState,
    row: &OauthGrantRow,
    token: &str,
    issuer: Option<&str>,
) -> bool {
    let Ok(app) = get_application(state, &row.application_id).await else {
        return false;
    };
    let Some(app) = app else {
        return false;
    };
    let Ok(keys) = get_jwks(state).await else {
        return false;
    };
    let keyset = JwkSet::new(
        keys.iter()
            .filter_map(|value| Jwk::from_value(value).ok())
            .collect(),
    );
    let verified = verify_jws(
        token,
        &keyset,
        &VerifyOptions {
            algorithms: vec![JwsAlgorithm::RS256],
            issuer: Some(vec![issuer
                .map(str::to_string)
                .unwrap_or_else(|| state.env.base_url.clone())]),
            audience: Some(vec![app.client_id]),
            clock_tolerance_seconds: 0,
        },
    );
    let Ok(payload) = verified else {
        return false;
    };
    payload.get("sub").and_then(|value| value.as_str()) == Some(row.user_id.as_str())
        && payload.get("jti").and_then(|value| value.as_str()) == Some(row.id.as_str())
}

/// `POST /oauth/revoke` (RFC 7009): revoking a refresh token revokes its family.
pub async fn revoke_token(
    state: &AppState,
    application: &ApplicationRow,
    token: &str,
) -> Result<()> {
    let Some(row) = find_grant_by_token(state, token).await? else {
        return Ok(());
    };
    if row.application_id != application.id {
        return Ok(());
    }
    if row.kind == "refresh" && row.family_id.is_some() {
        if let Some(family) = row.family_id.as_deref() {
            revoke_grant_family(state, family).await?;
        }
    } else {
        sqlx::query("UPDATE oauth_grants SET revoked = true WHERE id = $1")
            .bind(&row.id)
            .execute(&state.pool)
            .await?;
    }
    Ok(())
}

/// `POST /oauth/introspect` (RFC 7662). Returns `{ active: false }` for
/// unknown/foreign/expired tokens.
pub async fn introspect_token(
    state: &AppState,
    application: &ApplicationRow,
    token: &str,
    issuer: Option<&str>,
) -> Result<serde_json::Value> {
    use serde_json::json;
    let inactive = || json!({ "active": false });
    let Some(row) = find_grant_by_token(state, token).await? else {
        return Ok(inactive());
    };
    if row.application_id != application.id || !is_grant_live(&row, now()) || row.kind == "code" {
        return Ok(inactive());
    }
    let Some(user) = load_user(state, &row.user_id)
        .await?
        .filter(|user| !user.banned)
    else {
        return Ok(inactive());
    };
    if !authorizing_session_active(state, row.session_id.as_deref()).await? {
        return Ok(inactive());
    }
    let email = primary_email(state, &user).await?;
    let username = user
        .username
        .clone()
        .or_else(|| email.as_ref().map(|email| email.email.clone()));
    let mut body = serde_json::Map::new();
    body.insert("active".into(), json!(true));
    body.insert("scope".into(), json!(row.scopes));
    body.insert("client_id".into(), json!(application.client_id));
    if let Some(username) = username {
        body.insert("username".into(), json!(username));
    }
    body.insert("sub".into(), json!(row.user_id));
    body.insert(
        "iss".into(),
        json!(issuer
            .map(str::to_string)
            .unwrap_or_else(|| state.env.base_url.clone())),
    );
    body.insert("aud".into(), json!(application.client_id));
    body.insert("exp".into(), json!(row.expires_at / 1000));
    body.insert("iat".into(), json!(row.created_at / 1000));
    body.insert("jti".into(), json!(row.id));
    body.insert(
        "token_type".into(),
        json!(if row.kind == "refresh" {
            "refresh_token"
        } else {
            "Bearer"
        }),
    );
    Ok(serde_json::Value::Object(body))
}
