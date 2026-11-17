//! Session JWTs and generic instance-signed JWTs, ported from
//! `services/tokens.ts`.
//!
//! The TypeScript functions load users, sessions and organizations themselves
//! through higher-level services. This layer stays below those services: the
//! caller passes the rows and the resolved organization/role claims. Templates
//! still read the shortcode tables directly, exactly like
//! `services/jwt-templates.ts`.

use std::collections::HashSet;

use serde_json::{Map, Value};

use orbitid_core::claims::{SessionClaims, RESERVED_SESSION_CLAIMS};
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::keys::SESSION_NEVER_EXPIRES_AT;
use orbitid_core::models::{SessionRow, UserRow};
use orbitid_core::resources::UserJson;
use orbitid_core::AppState;

use crate::jwt::{JwkSet, JwsAlgorithm, VerifyOptions};
use crate::keys::{get_jwks, sign_with_instance_key};
use crate::templates::{render_template_claims, TemplateRenderInput};

mod shortcode;

pub use shortcode::resolve_shortcode_value;
use shortcode::{resolve_claim_map, shortcode_source};

/// Organization context carried as `org_*` claims. The upper layer resolves
/// the membership and its permissions (RBAC lives in `orbitid-identity`).
#[derive(Debug, Clone)]
pub struct TokenOrg {
    pub id: String,
    pub slug: Option<String>,
    pub name: String,
    pub role: String,
    pub permissions: Vec<String>,
}

/// Everything the token mint needs from the higher layers.
#[derive(Debug)]
pub struct SessionTokenInput<'a> {
    pub session: &'a SessionRow,
    pub user: &'a UserRow,
    pub user_json: &'a UserJson,
    pub org: Option<&'a TokenOrg>,
    /// Instance role keys (`user_roles`), already validated and sorted.
    pub roles: Vec<String>,
    /// Union of those roles' permissions, sorted.
    pub role_permissions: Vec<String>,
}

/// Options for [`sign_session_token`].
#[derive(Debug, Default, Clone)]
pub struct SessionTokenOptions<'a> {
    /// Render a named JWT template instead of `session.customClaims`.
    pub template: Option<&'a str>,
    pub azp: Option<&'a str>,
}

/// Which kind of token a verifier accepts.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TokenType {
    Session,
    JwtTemplate,
}

#[derive(Debug, Clone, Default)]
pub struct VerifySessionOptions {
    pub token_type: Option<TokenType>,
}

const SERVER_CLOCK_TOLERANCE_SECONDS: i64 = 60;
const SERVER_EXP_CLOCK_TOLERANCE_SECONDS: i64 = 10;

fn minutes_since(timestamp: Option<i64>) -> i64 {
    match timestamp {
        Some(value) if value != 0 => (now() - value) / 60_000,
        _ => -1,
    }
}

fn session_expires_at(state: &AppState, session: &SessionRow) -> i64 {
    let lifetime = state.settings.get().session.lifetime_seconds;
    let policy_deadline = if lifetime > 0 {
        session.created_at + lifetime * 1000
    } else {
        i64::MAX
    };
    if session.expire_at == SESSION_NEVER_EXPIRES_AT {
        policy_deadline
    } else {
        session.expire_at.min(policy_deadline)
    }
}

/// Mints a session JWT. Mirrors `signSessionToken`: active/pending status,
/// ban, expiry and inactivity are enforced here; the claims and the signing key
/// match the TypeScript wire format.
pub async fn sign_session_token(
    state: &AppState,
    input: SessionTokenInput<'_>,
    options: SessionTokenOptions<'_>,
) -> Result<String> {
    let user_id = input.user.id.clone();
    let token = sign_session_token_unchecked(state, input, options).await?;
    // `input.user` came from an unlocked read. A JWT is offline-valid until it
    // expires, so a ban that committed since that read must not be followed by
    // a fresh token: re-read the flag under `FOR KEY SHARE` (a ban holds
    // `FOR UPDATE` until it commits) after signing and discard the token if the
    // user is gone or banned. (Checked after signing, not around it, so no pool
    // connection is held while the signing key is loaded.)
    let banned: Option<bool> =
        sqlx::query_scalar("SELECT banned FROM users WHERE id = $1 FOR KEY SHARE")
            .bind(&user_id)
            .fetch_optional(&state.pool)
            .await?;
    match banned {
        Some(false) => Ok(token),
        Some(true) => Err(OrbitError::forbidden(
            error_codes::USER_BANNED,
            "This user has been banned",
        )),
        None => Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "Not signed in",
        )),
    }
}

async fn sign_session_token_unchecked(
    state: &AppState,
    input: SessionTokenInput<'_>,
    options: SessionTokenOptions<'_>,
) -> Result<String> {
    let session = input.session;
    if session.status != "active" && session.status != "pending" {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "This session is no longer active",
        ));
    }
    if input.user.banned {
        return Err(OrbitError::forbidden(
            error_codes::USER_BANNED,
            "This user has been banned",
        ));
    }
    let now_ms = now();
    let inactivity_ms = state.settings.get().session.inactivity_timeout_seconds * 1000;
    if session_expires_at(state, session) <= now_ms
        || (inactivity_ms > 0 && now_ms - session.last_active_at > inactivity_ms)
    {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "This session has expired",
        ));
    }

    let settings = state.settings.get();
    let now_seconds = now_ms / 1000;
    let mut lifetime = settings.session.token_lifetime_seconds;
    let mut extra_claims = Map::new();
    let mut template = None;

    if let Some(name) = options.template {
        let rendered = render_template_claims(
            state,
            name,
            TemplateRenderInput {
                user_id: input.user.id.clone(),
                session_id: Some(session.id.clone()),
                org_id: session.last_active_organization_id.clone(),
            },
        )
        .await?;
        let Some(rendered) = rendered else {
            return Err(OrbitError::not_found(
                error_codes::RESOURCE_NOT_FOUND,
                format!("JWT template \"{name}\" not found"),
            ));
        };
        lifetime = rendered.lifetime_seconds;
        extra_claims = rendered.claims_as_map();
        template = Some(rendered);
    } else if !settings.session.custom_claims.is_empty() {
        let source = shortcode_source(input.user_json, input.org, session);
        extra_claims = resolve_claim_map(&settings.session.custom_claims, &source);
    }

    let mut claims = Map::new();
    claims.insert("iss".into(), Value::String(state.env.base_url.clone()));
    claims.insert("sub".into(), Value::String(input.user.id.clone()));
    claims.insert("sid".into(), Value::String(session.id.clone()));
    claims.insert("iat".into(), Value::from(now_seconds));
    claims.insert("nbf".into(), Value::from(now_seconds));
    claims.insert("exp".into(), Value::from(now_seconds + lifetime));
    claims.insert(
        "sts".into(),
        Value::String(if session.status == "pending" {
            "pending".into()
        } else {
            "active".into()
        }),
    );
    claims.insert(
        "fva".into(),
        Value::Array(vec![
            Value::from(minutes_since(session.first_factor_verified_at)),
            Value::from(minutes_since(session.second_factor_verified_at)),
        ]),
    );
    claims.insert(
        "token_type".into(),
        Value::String(if options.template.is_some() {
            "jwt_template".into()
        } else {
            "session".into()
        }),
    );
    if input.user.is_anonymous {
        claims.insert("anonymous".into(), Value::Bool(true));
    }
    if let Some(azp) = options.azp {
        claims.insert("azp".into(), Value::String(azp.to_string()));
    }
    if let Some(org) = input.org {
        claims.insert("org_id".into(), Value::String(org.id.clone()));
        claims.insert(
            "org_slug".into(),
            org.slug.clone().map(Value::String).unwrap_or(Value::Null),
        );
        claims.insert("org_role".into(), Value::String(org.role.clone()));
        claims.insert(
            "org_permissions".into(),
            Value::Array(org.permissions.iter().cloned().map(Value::String).collect()),
        );
    }
    claims.insert(
        "roles".into(),
        Value::Array(input.roles.iter().cloned().map(Value::String).collect()),
    );
    claims.insert(
        "role_permissions".into(),
        Value::Array(
            input
                .role_permissions
                .iter()
                .cloned()
                .map(Value::String)
                .collect(),
        ),
    );
    if let Some(actor) = &session.actor {
        claims.insert("act".into(), actor.0.clone());
    }

    // Configured or templated claims may add to the token, never redefine who
    // or what the session is.
    let protected: HashSet<&str> = RESERVED_SESSION_CLAIMS.iter().copied().collect();
    let mut merged = Map::new();
    for (key, value) in extra_claims {
        if !protected.contains(key.as_str()) {
            merged.insert(key, value);
        }
    }
    for (key, value) in claims {
        merged.insert(key, value);
    }

    if let Some(template) = template {
        if let Some(encrypted) = template.signing_key_enc.as_deref() {
            let key = crate::templates::import_template_key(state, encrypted, &template.algorithm)?;
            let algorithm = JwsAlgorithm::parse(&template.algorithm)
                .ok_or_else(|| OrbitError::internal("Unsupported template signing algorithm"))?;
            return crate::jwt::sign_jws(&Value::Object(merged), algorithm, &key, None)
                .map_err(crate::keys::jwt_error);
        }
    }
    sign_with_instance_key(state, &Value::Object(merged), None).await
}

/// Verifies a stored session JWT, exactly like `verifySessionToken`: only
/// RS256 instance keys, issuer pinned, a 60 s early-clock tolerance, a 10 s
/// expiry bound, no `aud`, and template tokens refused unless explicitly
/// requested.
pub async fn verify_session_token(
    state: &AppState,
    jwt: &str,
    options: VerifySessionOptions,
) -> Result<SessionClaims> {
    let generic =
        || OrbitError::unauthorized(error_codes::AUTHENTICATION_INVALID, "Invalid session token");
    let keys = get_jwks(state).await?;
    let keyset = JwkSet::new(
        keys.iter()
            .filter_map(|value| crate::jwt::Jwk::from_value(value).ok())
            .collect(),
    );
    let payload = crate::jwt::verify_jws(
        jwt,
        &keyset,
        &VerifyOptions {
            algorithms: vec![JwsAlgorithm::RS256],
            issuer: Some(vec![state.env.base_url.clone()]),
            audience: None,
            clock_tolerance_seconds: SERVER_CLOCK_TOLERANCE_SECONDS,
        },
    )
    .map_err(|_| generic())?;
    let Some(map) = payload.as_object() else {
        return Err(generic());
    };
    let now_seconds = now() / 1000;
    if let Some(exp) = map.get("exp").and_then(Value::as_i64) {
        if exp + SERVER_EXP_CLOCK_TOLERANCE_SECONDS < now_seconds {
            return Err(generic());
        }
    }
    for claim in ["nbf", "iat"] {
        if let Some(value) = map.get(claim).and_then(Value::as_i64) {
            if value > now_seconds + SERVER_CLOCK_TOLERANCE_SECONDS {
                return Err(generic());
            }
        }
    }
    if map.get("sid").and_then(Value::as_str).is_none()
        || map.get("sub").and_then(Value::as_str).is_none()
        || map.contains_key("aud")
    {
        return Err(generic());
    }
    match options.token_type {
        Some(TokenType::JwtTemplate) => {
            if map.get("token_type").and_then(Value::as_str) != Some("jwt_template") {
                return Err(generic());
            }
        }
        _ => {
            if map.get("token_type").and_then(Value::as_str) == Some("jwt_template") {
                return Err(generic());
            }
        }
    }
    serde_json::from_value(payload).map_err(|_| generic())
}

#[derive(Debug, Clone, Default)]
pub struct SignJwtOptions {
    pub expires_in_seconds: i64,
    pub audience: Option<String>,
    pub issuer: Option<String>,
    pub kid: Option<String>,
}

/// Signs arbitrary claims with the instance key (OIDC `id_token`, API keys,
/// JWT templates used by integrations).
pub async fn sign_jwt(
    state: &AppState,
    claims: &Map<String, Value>,
    options: SignJwtOptions,
) -> Result<String> {
    let now_seconds = now() / 1000;
    let mut payload = claims.clone();
    let issuer = options
        .issuer
        .or_else(|| {
            claims
                .get("iss")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
        .unwrap_or_else(|| state.env.base_url.clone());
    payload.insert("iss".into(), Value::String(issuer));
    payload.insert("iat".into(), Value::from(now_seconds));
    payload.insert(
        "exp".into(),
        Value::from(now_seconds + options.expires_in_seconds),
    );
    if let Some(audience) = options.audience {
        payload.insert("aud".into(), Value::String(audience));
    }
    sign_with_instance_key(state, &Value::Object(payload), options.kid.as_deref()).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn minutes_are_negative_when_absent() {
        assert_eq!(minutes_since(None), -1);
        assert_eq!(minutes_since(Some(0)), -1);
    }
}
