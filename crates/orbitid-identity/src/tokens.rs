//! Higher-level session-token minting, ported from `services/tokens.ts`.
//!
//! `orbitid-credentials` owns the signing key and claim assembly but stays
//! below this crate: the caller passes rows and resolved org/role claims. This
//! module loads those rows exactly like the TypeScript service (session, user,
//! active organization, instance roles) and then delegates to
//! [`orbitid_credentials::sign_session_token`].

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{SessionRow, UserRow};
use orbitid_core::state::AppState;
use orbitid_credentials::session::{SessionTokenInput, SessionTokenOptions, TokenOrg, TokenType};
use orbitid_credentials::{verify_session_token as verify_with_credentials, VerifySessionOptions};

use crate::orgs::get_membership_context;
use crate::serializers::{serialize_user, UserSerializeOptions};
use crate::user_roles::role_claims_for_user;

/// Options for [`sign_session_token`].
#[derive(Debug, Clone, Default)]
pub struct SignSessionTokenOptions {
    /// Render a named JWT template instead of `session.customClaims`.
    pub template: Option<String>,
    pub azp: Option<String>,
}

fn is_expired(state: &AppState, row: &SessionRow) -> bool {
    if row.status != "active" && row.status != "pending" {
        return false;
    }
    let now_ms = orbitid_core::http::now();
    let lifetime = state.settings.get().session.lifetime_seconds;
    let deadline = if lifetime > 0 {
        row.created_at + lifetime * 1000
    } else if row.expire_at == orbitid_core::keys::SESSION_NEVER_EXPIRES_AT {
        i64::MAX
    } else {
        row.expire_at
    };
    let expires_at = if row.expire_at == orbitid_core::keys::SESSION_NEVER_EXPIRES_AT {
        deadline
    } else {
        row.expire_at.min(deadline)
    };
    if expires_at <= now_ms {
        return true;
    }
    let inactivity_ms = state.settings.get().session.inactivity_timeout_seconds * 1000;
    inactivity_ms > 0 && now_ms - row.last_active_at > inactivity_ms
}

/// Mints a session JWT for an active session, including `org_*` claims for the
/// session's active organization and instance `roles`/`role_permissions`.
pub async fn sign_session_token(
    state: &AppState,
    session_id: &str,
    options: SignSessionTokenOptions,
) -> Result<String> {
    let session = sqlx::query_as::<_, SessionRow>("SELECT * FROM sessions WHERE id = $1")
        .bind(session_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Session not found")
        })?;
    if session.status != "active" && session.status != "pending" {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "This session is no longer active",
        ));
    }
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&session.user_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "User not found"))?;
    if user.banned {
        return Err(OrbitError::forbidden(
            error_codes::USER_BANNED,
            "This user has been banned",
        ));
    }
    if is_expired(state, &session) {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "This session has expired",
        ));
    }
    let user_json = serialize_user(state, &user, UserSerializeOptions::default()).await?;
    let org = match session.last_active_organization_id.as_deref() {
        Some(org_id) => get_membership_context(state, &user.id, org_id)
            .await?
            .map(|membership| TokenOrg {
                id: membership.org_id,
                slug: membership.slug,
                name: membership.name,
                role: membership.role,
                permissions: membership.permissions,
            }),
        None => None,
    };
    let claims = role_claims_for_user(state, &user.id).await?;
    let input = SessionTokenInput {
        session: &session,
        user: &user,
        user_json: &user_json,
        org: org.as_ref(),
        roles: claims.roles,
        role_permissions: claims.permissions,
    };
    orbitid_credentials::sign_session_token(
        state,
        input,
        SessionTokenOptions {
            template: options.template.as_deref(),
            azp: options.azp.as_deref(),
        },
    )
    .await
}

/// Verifies a session JWT against the instance JWKS (thin re-export so auth
/// callers do not need a second import).
pub async fn verify_session_token(
    state: &AppState,
    jwt: &str,
    token_type: Option<TokenType>,
) -> Result<orbitid_core::claims::SessionClaims> {
    verify_with_credentials(state, jwt, VerifySessionOptions { token_type }).await
}
