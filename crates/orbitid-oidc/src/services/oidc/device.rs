//! OIDC device authorization grant (RFC 8628), ported from
//! `services/oidc/device.ts`.

use rand::Rng;
use serde::Serialize;

use orbitid_core::crypto::{random_token, safe_equal, sha256};
use orbitid_core::error::{error_codes, is_unique_violation, OrbitError, Result};
use orbitid_core::http::now;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{DeviceCodeRow, UserRow};
use orbitid_core::state::AppState;

use super::applications::{get_application, ApplicationRow};
use super::shared::parse_scopes;
use super::token_set::{insert_planned_token_set, plan_token_set, TokenSet, TokenSetInput};

/// Unambiguous alphabet: no 0/O, 1/I/L, so a code read off a TV can be typed
/// back without guessing.
const USER_CODE_ALPHABET: &[u8] = b"BCDFGHJKMNPQRSTVWXZ23456789";
pub const USER_CODE_LENGTH: usize = 8;

pub fn generate_user_code() -> String {
    let mut rng = rand::rng();
    let mut raw = String::with_capacity(USER_CODE_LENGTH);
    for _ in 0..USER_CODE_LENGTH {
        let index = rng.random_range(0..USER_CODE_ALPHABET.len());
        raw.push(USER_CODE_ALPHABET[index] as char);
    }
    raw
}

/// `ABCD1234` -> `ABCD-1234` (the form users see).
pub fn format_user_code(code: &str) -> String {
    let split = 4.min(code.len());
    format!("{}-{}", &code[..split], &code[split..])
}

/// Normalizes typed input: upper-case, separators and whitespace removed.
/// Returns `None` when it cannot be a code.
pub fn normalize_user_code(input: &str) -> Option<String> {
    let raw: String = input
        .to_uppercase()
        .chars()
        .filter(|character| !character.is_whitespace() && *character != '-' && *character != '_')
        .collect();
    if raw.len() != USER_CODE_LENGTH {
        return None;
    }
    if !raw.bytes().all(|byte| USER_CODE_ALPHABET.contains(&byte)) {
        return None;
    }
    Some(raw)
}

/// Device codes are bearer secrets: only their hash is stored.
pub fn device_code_hash(code: &str) -> String {
    sha256(&format!("device:{code}"))
}

#[derive(Debug, Clone)]
pub struct DeviceAuthorizationInput<'a> {
    pub application: &'a ApplicationRow,
    pub scopes: &'a [String],
}

#[derive(Debug, Clone)]
pub struct DeviceAuthorization {
    pub device_code: String,
    pub row: DeviceCodeRow,
    pub interval_seconds: i64,
    pub expires_in_seconds: i64,
}

/// `POST /oauth/device_authorization`: creates a pending device code and its
/// short user code.
pub async fn create_device_authorization(
    state: &AppState,
    input: DeviceAuthorizationInput<'_>,
) -> Result<DeviceAuthorization> {
    let settings = state.settings.get().oidc_provider.clone();
    let device_code = format!("odc_{}", random_token(32));
    let now_ms = now();
    let mut attempt = 0;
    loop {
        let user_code = generate_user_code();
        let row = DeviceCodeRow {
            id: new_id(id_prefix::OAUTH_GRANT),
            application_id: input.application.id.clone(),
            device_code_hash: device_code_hash(&device_code),
            user_code,
            scopes: input.scopes.join(" "),
            status: "pending".into(),
            user_id: None,
            interval_seconds: settings.device_code_interval_seconds,
            last_polled_at: None,
            expires_at: now_ms + settings.device_code_lifetime_seconds * 1000,
            created_at: now_ms,
        };
        let result = sqlx::query(
            "INSERT INTO device_codes (id, application_id, device_code_hash, user_code, scopes, \
             status, user_id, interval_seconds, last_polled_at, expires_at, created_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)",
        )
        .bind(&row.id)
        .bind(&row.application_id)
        .bind(&row.device_code_hash)
        .bind(&row.user_code)
        .bind(&row.scopes)
        .bind(&row.status)
        .bind(&row.user_id)
        .bind(row.interval_seconds)
        .bind(row.last_polled_at)
        .bind(row.expires_at)
        .bind(row.created_at)
        .execute(&state.pool)
        .await;
        match result {
            Ok(_) => {
                return Ok(DeviceAuthorization {
                    device_code,
                    interval_seconds: row.interval_seconds,
                    expires_in_seconds: settings.device_code_lifetime_seconds,
                    row,
                })
            }
            Err(error) if attempt < 5 && is_user_code_collision(&error) => {
                attempt += 1;
                continue;
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn is_user_code_collision(error: &sqlx::Error) -> bool {
    is_unique_violation(error)
}

/// Looks up a device row by its secret, comparing hashes in constant time.
pub async fn find_device_grant(
    state: &AppState,
    device_code: &str,
) -> Result<Option<DeviceCodeRow>> {
    let hash = device_code_hash(device_code);
    let row = sqlx::query_as::<_, DeviceCodeRow>(
        "SELECT * FROM device_codes WHERE device_code_hash = $1",
    )
    .bind(&hash)
    .fetch_optional(&state.pool)
    .await?;
    Ok(row.filter(|row| safe_equal(&row.device_code_hash, &hash)))
}

/// Looks up a device row by the user code typed in the browser.
pub async fn find_device_by_user_code(
    state: &AppState,
    user_code: &str,
) -> Result<Option<DeviceCodeRow>> {
    let Some(normalized) = normalize_user_code(user_code) else {
        return Ok(None);
    };
    Ok(
        sqlx::query_as::<_, DeviceCodeRow>("SELECT * FROM device_codes WHERE user_code = $1")
            .bind(normalized)
            .fetch_optional(&state.pool)
            .await?,
    )
}

/// The application behind a device code, for the consent view.
pub async fn device_application(
    state: &AppState,
    row: &DeviceCodeRow,
) -> Result<Option<ApplicationRow>> {
    get_application(state, &row.application_id).await
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum DeviceTokenResult {
    Ok {
        tokens: TokenSet,
    },
    Pending {
        error: String,
        description: String,
        interval_seconds: Option<i64>,
    },
}

impl DeviceTokenResult {
    pub fn error(&self) -> Option<(&str, &str, Option<i64>)> {
        match self {
            Self::Ok { .. } => None,
            Self::Pending {
                error,
                description,
                interval_seconds,
            } => Some((error, description, *interval_seconds)),
        }
    }
}

/// One poll of `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
pub async fn poll_device_code(
    state: &AppState,
    application: &ApplicationRow,
    device_code: &str,
    issuer: Option<&str>,
) -> Result<DeviceTokenResult> {
    poll_device_code_with_hooks(state, application, device_code, issuer, None).await
}

/// [`poll_device_code`] with a test seam around the issuing transaction.
pub async fn poll_device_code_with_hooks(
    state: &AppState,
    application: &ApplicationRow,
    device_code: &str,
    issuer: Option<&str>,
    hooks: Option<&(dyn super::refresh::RefreshExchangeHooks + '_)>,
) -> Result<DeviceTokenResult> {
    let pending = |error: &str, description: &str| DeviceTokenResult::Pending {
        error: error.to_string(),
        description: description.to_string(),
        interval_seconds: None,
    };
    let Some(row) = find_device_grant(state, device_code).await? else {
        return Ok(pending(
            "expired_token",
            "The device code is invalid or has expired",
        ));
    };
    if row.application_id != application.id {
        return Ok(pending(
            "expired_token",
            "The device code is invalid or has expired",
        ));
    }
    let now_ms = now();
    if row.expires_at <= now_ms || row.status == "consumed" {
        return Ok(pending(
            "expired_token",
            "The device code is invalid or has expired",
        ));
    }
    if row.status == "denied" {
        return Ok(pending("access_denied", "The user denied the request"));
    }

    // RFC 8628 §3.5: polled faster than the interval -> slow_down.
    let min_interval_ms = row.interval_seconds * 1000;
    if let Some(last_polled_at) = row.last_polled_at {
        if now_ms - last_polled_at < min_interval_ms {
            let interval_seconds = row.interval_seconds + 5;
            sqlx::query(
                "UPDATE device_codes SET interval_seconds = $2, last_polled_at = $3 WHERE id = $1",
            )
            .bind(&row.id)
            .bind(interval_seconds)
            .bind(now_ms)
            .execute(&state.pool)
            .await?;
            return Ok(DeviceTokenResult::Pending {
                error: "slow_down".into(),
                description: "Polling too quickly; increase the interval".into(),
                interval_seconds: Some(interval_seconds),
            });
        }
    }
    sqlx::query("UPDATE device_codes SET last_polled_at = $2 WHERE id = $1")
        .bind(&row.id)
        .bind(now_ms)
        .execute(&state.pool)
        .await?;

    let Some(user_id) = row.user_id.as_deref().filter(|_| row.status != "pending") else {
        return Ok(pending(
            "authorization_pending",
            "The user has not approved this request yet",
        ));
    };

    let Some(user) = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.pool)
        .await?
        .filter(|user| !user.banned)
    else {
        return Ok(pending(
            "access_denied",
            "The user is not allowed to sign in",
        ));
    };

    let scopes = parse_scopes(&row.scopes);
    let family = random_token(9);
    // Plan the token set (pure reads and signing) before the transaction, then
    // claim the device code and persist the grants on one connection. A failed
    // insert rolls the claim back, so a retry can still receive its tokens, and
    // exactly one poll can consume an approval.
    let authority = super::token_set::authority_snapshot(state, &user.id, None).await?;
    if let Some(hooks) = hooks {
        hooks.after_authority_snapshot().await;
    }
    let plan = plan_token_set(
        state,
        &TokenSetInput {
            application,
            user: &user,
            scopes: &scopes,
            family: &family,
            nonce: None,
            session_id: None,
            issuer,
            refresh: None,
            reuse_refresh_token: None,
        },
        &authority,
    )
    .await?;
    if let Some(hooks) = hooks {
        hooks.before_consume().await;
    }
    let mut tx = state.pool.begin().await?;
    // The grant inserts reference `users` (rank 3); take the key-share before
    // the device row is locked (user deletion holds the user and cascades into
    // `device_codes`) and re-check eligibility under it: a ban that committed
    // after the unlocked read above must not receive tokens. A user deleted or
    // banned meanwhile is the same "not allowed".
    let eligible = orbitid_identity::locks::key_share_active_user_on(&mut tx, &user.id).await?;
    if !matches!(eligible, Some(state) if !state.banned) {
        return Ok(pending(
            "access_denied",
            "The user is not allowed to sign in",
        ));
    }
    if !super::token_set::authority_unchanged_on(&mut tx, state, &user.id, &authority).await? {
        // Claims were planned from stale authority: the next poll re-plans.
        return Ok(pending(
            "authorization_pending",
            "The organization authority of this grant has changed",
        ));
    }
    let claimed = sqlx::query_scalar::<_, String>(
        "UPDATE device_codes SET status = 'consumed', last_polled_at = $2 \
         WHERE id = $1 AND status = 'approved' RETURNING id",
    )
    .bind(&row.id)
    .bind(now_ms)
    .fetch_optional(&mut *tx)
    .await?;
    if claimed.is_none() {
        return Ok(pending(
            "authorization_pending",
            "The user has not approved this request yet",
        ));
    }
    insert_planned_token_set(&mut tx, &plan).await?;
    tx.commit().await?;
    Ok(DeviceTokenResult::Ok { tokens: plan.set })
}

#[derive(Debug, Clone)]
pub struct DeviceDecisionInput<'a> {
    pub user_code: &'a str,
    pub user_id: &'a str,
    pub approve: bool,
}

#[derive(Debug, Clone)]
pub enum DeviceDecision {
    Ok {
        application: Box<ApplicationRow>,
        scopes: Vec<String>,
    },
    Rejected {
        reason: &'static str,
    },
}

/// Approves or denies a pending device code on behalf of a signed-in user.
pub async fn decide_device_code(
    state: &AppState,
    input: DeviceDecisionInput<'_>,
) -> Result<DeviceDecision> {
    let Some(row) = find_device_by_user_code(state, input.user_code).await? else {
        return Ok(DeviceDecision::Rejected {
            reason: "not_found",
        });
    };
    if row.expires_at <= now() {
        return Ok(DeviceDecision::Rejected { reason: "expired" });
    }
    if row.status != "pending" {
        return Ok(DeviceDecision::Rejected {
            reason: "already_decided",
        });
    }
    let Some(application) = get_application(state, &row.application_id).await? else {
        return Ok(DeviceDecision::Rejected {
            reason: "not_found",
        });
    };

    // `device_codes.user_id` references `users` (rank 3): an approval writes
    // that foreign key, so the user key-share is taken first, in the same
    // transaction, before the device row is locked. User deletion holds the user
    // and then cascades into `device_codes`.
    let mut tx = state.pool.begin().await?;
    if input.approve {
        // Eligibility re-checked under the key-share (a ban that committed
        // after the caller authenticated must not approve a device).
        let eligible =
            orbitid_identity::locks::key_share_active_user_on(&mut tx, input.user_id).await?;
        match eligible {
            None => {
                return Err(OrbitError::not_found(
                    error_codes::RESOURCE_NOT_FOUND,
                    "User not found",
                ))
            }
            Some(state) if state.banned => {
                return Err(OrbitError::forbidden(
                    error_codes::USER_BANNED,
                    "This user has been banned",
                ))
            }
            Some(_) => {}
        }
    }
    let claimed = sqlx::query_scalar::<_, String>(
        "UPDATE device_codes SET status = $2, user_id = $3 \
         WHERE id = $1 AND status = 'pending' AND expires_at > $4 RETURNING id",
    )
    .bind(&row.id)
    .bind(if input.approve { "approved" } else { "denied" })
    .bind(if input.approve {
        Some(input.user_id)
    } else {
        None
    })
    .bind(now())
    .fetch_optional(&mut *tx)
    .await?;
    tx.commit().await?;
    if claimed.is_none() {
        return Ok(DeviceDecision::Rejected {
            reason: "already_decided",
        });
    }
    Ok(DeviceDecision::Ok {
        application: Box::new(application),
        scopes: parse_scopes(&row.scopes),
    })
}

/// Consumes a user code that was brute-forced too often.
pub async fn burn_device_code(state: &AppState, row: &DeviceCodeRow) -> Result<()> {
    sqlx::query("UPDATE device_codes SET status = 'denied' WHERE id = $1")
        .bind(&row.id)
        .execute(&state.pool)
        .await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn user_codes_format_and_normalize() {
        let code = generate_user_code();
        assert_eq!(code.len(), 8);
        assert!(code.bytes().all(|byte| USER_CODE_ALPHABET.contains(&byte)));
        let formatted = format_user_code(&code);
        assert_eq!(formatted.len(), 9);
        assert_eq!(formatted.as_bytes()[4], b'-');
        assert_eq!(
            normalize_user_code(&formatted).as_deref(),
            Some(code.as_str())
        );
        assert_eq!(
            normalize_user_code("bcdf-ghjk").as_deref(),
            Some("BCDFGHJK")
        );
        assert!(normalize_user_code("short").is_none());
        assert!(normalize_user_code("ABC0EFGH").is_none());
    }
}
