//! Passkey (WebAuthn) ceremonies, ported from `services/passkeys.ts`.
//!
//! Challenge rows live in `verifications` with the relying party captured at
//! issue time. Claiming a challenge is a single compare-and-set statement, so
//! concurrent finishes can never spend one challenge twice.

mod challenges;
pub mod fapi;
pub mod webauthn;

#[cfg(any(feature = "test-util", test))]
pub mod authenticator;

use sqlx::PgPool;

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, request_origin_allowed};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::{PasskeyRow, UserRow};
use orbitid_core::AppState;

use challenges::{
    ceremony_relying_party, claim_challenge, customer_id, load_challenge, mark_verified,
    release_challenge, store_challenge, stored_name, AUTHENTICATION_PURPOSE, REGISTRATION_PURPOSE,
};
use webauthn::{
    AuthenticationResponseJson, CreationOptionsJson, CredentialDescriptor,
    RegistrationResponseJson, RequestOptionsJson,
};

/// The relying party a ceremony is bound to.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RelyingParty {
    /// Hostname only (no port), as WebAuthn's `rpId` requires.
    pub rp_id: String,
    /// Full origin, e.g. `https://app.example.com`.
    pub origin: String,
}

/// Result of starting a registration ceremony.
#[derive(Debug, Clone)]
pub struct BeginRegistration {
    pub passkey_id: String,
    pub options: CreationOptionsJson,
}

/// Input for [`begin_passkey_registration`].
#[derive(Debug, Clone)]
pub struct BeginRegistrationInput {
    pub user_id: String,
    pub user_name: String,
    pub display_name: String,
    pub rp: RelyingParty,
    /// `platform` (device-bound) or `cross-platform` (security key).
    pub authenticator_type: Option<String>,
    pub name: Option<String>,
}

/// Input for [`finish_passkey_registration`].
#[derive(Debug, Clone)]
pub struct FinishRegistrationInput {
    pub passkey_id: String,
    pub user_id: String,
    pub credential: RegistrationResponseJson,
    pub name: Option<String>,
}

/// Input for [`begin_passkey_authentication`].
#[derive(Debug, Clone)]
pub struct BeginAuthenticationInput {
    pub rp: RelyingParty,
    pub user_id: Option<String>,
    /// Owner of the challenge row (a sign-in attempt id).
    pub owner_id: String,
    pub allow_credentials: Option<Vec<CredentialDescriptor>>,
}

/// Input for [`finish_passkey_authentication`].
#[derive(Debug, Clone)]
pub struct FinishAuthenticationInput {
    pub owner_id: String,
    pub credential: AuthenticationResponseJson,
}

fn origin_of(value: &str) -> Option<String> {
    let url = url::Url::parse(value).ok()?;
    let origin = url.origin().ascii_serialization();
    (origin != "null").then_some(origin)
}

/// Derives `{rpID, origin}`: the request `Origin` wins only when the instance
/// trusts it, then `application.homeUrl`, then `baseUrl`.
pub fn relying_party(state: &AppState, origin_hint: Option<&str>) -> Result<RelyingParty> {
    let settings = state.settings.get();
    let trusted = |value: Option<&str>| {
        let origin = origin_of(value?)?;
        request_origin_allowed(state, &origin).then_some(origin)
    };
    let origin = trusted(origin_hint)
        .or_else(|| trusted(Some(&settings.application.home_url)))
        .or_else(|| origin_of(&state.env.base_url))
        .ok_or_else(|| OrbitError::internal("Could not determine the WebAuthn origin"))?;
    let rp_id = url::Url::parse(&origin)
        .ok()
        .and_then(|url| url.host_str().map(str::to_string))
        .ok_or_else(|| OrbitError::internal("Could not determine the WebAuthn rpID"))?;
    Ok(RelyingParty { rp_id, origin })
}

/// Starts a registration ceremony; no passkey row exists until the
/// attestation verifies.
pub async fn begin_passkey_registration(
    state: &AppState,
    input: BeginRegistrationInput,
) -> Result<BeginRegistration> {
    let settings = state.settings.get();
    let existing = sqlx::query_as::<_, PasskeyRow>(
        "SELECT * FROM passkeys WHERE user_id = $1 ORDER BY created_at ASC",
    )
    .bind(&input.user_id)
    .fetch_all(&state.pool)
    .await?;
    let passkey_id = new_id(id_prefix::PASSKEY);
    let exclude = existing
        .into_iter()
        .map(|passkey| CredentialDescriptor {
            id: passkey.credential_id,
            key_type: "public-key".into(),
            transports: passkey.transports.map(|transports| transports.0),
        })
        .collect();
    let options = webauthn::creation_options(
        &settings.application.name,
        &input.rp.rp_id,
        &input.user_id,
        &input.user_name,
        &input.display_name,
        input.authenticator_type.as_deref(),
        exclude,
    );
    store_challenge(
        &state.pool,
        REGISTRATION_PURPOSE,
        &passkey_id,
        &options.challenge,
        serde_json::json!({
            "rpID": input.rp.rp_id,
            "origin": input.rp.origin,
            "userId": input.user_id,
            "name": input.name,
        }),
    )
    .await?;
    Ok(BeginRegistration {
        passkey_id,
        options,
    })
}

fn registration_failure(message: &str) -> OrbitError {
    OrbitError::bad_request(error_codes::PASSKEY_REGISTRATION_FAILURE, message)
}

/// Finishes a registration ceremony and stores the credential.
pub async fn finish_passkey_registration(
    state: &AppState,
    input: FinishRegistrationInput,
) -> Result<PasskeyRow> {
    let stored = load_challenge(&state.pool, REGISTRATION_PURPOSE, &input.passkey_id).await?;
    let stored = match stored {
        Some(stored) if customer_id(&stored).as_deref() == Some(input.user_id.as_str()) => stored,
        _ => {
            return Err(OrbitError::bad_request(
                error_codes::VERIFICATION_EXPIRED,
                "Passkey registration expired. Please try again.",
            ))
        }
    };
    let claimed = claim_challenge(&state.pool, &stored.id).await?;
    let Some(claimed) = claimed else {
        return Err(OrbitError::bad_request(
            error_codes::VERIFICATION_EXPIRED,
            "Passkey registration expired. Please try again.",
        ));
    };
    let rp = ceremony_relying_party(&claimed)?;
    let info = match webauthn::verify_registration(
        &input.credential,
        &claimed.identifier,
        &rp.origin,
        &rp.rp_id,
        true,
    ) {
        Ok(info) => info,
        Err(_) => {
            release_challenge(&state.pool, &claimed.id).await?;
            return Err(registration_failure(
                "Passkey registration could not be verified",
            ));
        }
    };
    mark_verified(&state.pool, &claimed.id).await?;

    let duplicate =
        sqlx::query_as::<_, PasskeyRow>("SELECT * FROM passkeys WHERE credential_id = $1")
            .bind(&info.credential_id)
            .fetch_optional(&state.pool)
            .await?;
    if duplicate.is_some() {
        return Err(OrbitError::conflict(
            error_codes::PASSKEY_REGISTRATION_FAILURE,
            "This authenticator is already registered",
        ));
    }
    let timestamp = now();
    let name = input
        .name
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .map(str::to_string)
        .or_else(|| stored_name(&claimed))
        .unwrap_or_else(|| "Passkey".to_string());
    let inserted = sqlx::query_as::<_, PasskeyRow>(
        "INSERT INTO passkeys \
         (id, user_id, name, credential_id, public_key, counter, transports, device_type, backed_up, created_at, updated_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $10) \
         ON CONFLICT DO NOTHING RETURNING *",
    )
    .bind(&input.passkey_id)
    .bind(&input.user_id)
    .bind(name)
    .bind(&info.credential_id)
    .bind(webauthn::b64_encode(&info.public_key))
    .bind(info.counter)
    .bind(info.transports.as_ref().map(sqlx::types::Json))
    .bind(&info.device_type)
    .bind(info.backed_up)
    .bind(timestamp)
    .fetch_optional(&state.pool)
    .await?;
    inserted.ok_or_else(|| {
        OrbitError::conflict(
            error_codes::PASSKEY_REGISTRATION_FAILURE,
            "This authenticator is already registered",
        )
    })
}

/// Starts an authentication ceremony. With `user_id` the options list only that
/// user's credentials.
pub async fn begin_passkey_authentication(
    state: &AppState,
    input: BeginAuthenticationInput,
) -> Result<RequestOptionsJson> {
    let credentials = match input.allow_credentials {
        Some(credentials) => credentials,
        None => match &input.user_id {
            Some(user_id) => {
                let rows = sqlx::query_as::<_, PasskeyRow>(
                    "SELECT * FROM passkeys WHERE user_id = $1 ORDER BY created_at ASC",
                )
                .bind(user_id)
                .fetch_all(&state.pool)
                .await?;
                rows.into_iter()
                    .map(|passkey| CredentialDescriptor {
                        id: passkey.credential_id,
                        key_type: "public-key".into(),
                        transports: passkey.transports.map(|transports| transports.0),
                    })
                    .collect()
            }
            None => Vec::new(),
        },
    };
    let options = webauthn::request_options(&input.rp.rp_id, credentials);
    store_challenge(
        &state.pool,
        AUTHENTICATION_PURPOSE,
        &input.owner_id,
        &options.challenge,
        serde_json::json!({
            "rpID": input.rp.rp_id,
            "origin": input.rp.origin,
            "userId": input.user_id,
        }),
    )
    .await?;
    Ok(options)
}

fn authentication_failure(message: &str) -> OrbitError {
    OrbitError::bad_request(error_codes::PASSKEY_AUTHENTICATION_FAILURE, message)
}

/// Finishes an authentication ceremony and returns the owning user and the
/// updated passkey. The caller performs ban/lock/session policy.
pub async fn finish_passkey_authentication(
    state: &AppState,
    input: FinishAuthenticationInput,
) -> Result<(UserRow, PasskeyRow)> {
    let stored = load_challenge(&state.pool, AUTHENTICATION_PURPOSE, &input.owner_id).await?;
    let Some(stored) = stored else {
        return Err(OrbitError::bad_request(
            error_codes::VERIFICATION_EXPIRED,
            "Passkey sign-in expired. Please try again.",
        ));
    };
    let claimed = claim_challenge(&state.pool, &stored.id).await?;
    let Some(claimed) = claimed else {
        return Err(OrbitError::bad_request(
            error_codes::VERIFICATION_EXPIRED,
            "Too many passkey attempts. Please try again.",
        ));
    };
    let rp = ceremony_relying_party(&claimed)?;
    let passkey =
        sqlx::query_as::<_, PasskeyRow>("SELECT * FROM passkeys WHERE credential_id = $1")
            .bind(&input.credential.id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(passkey) = passkey else {
        return Err(authentication_failure("Unknown passkey"));
    };
    let public_key = webauthn::b64_decode(&passkey.public_key)
        .map_err(|_| authentication_failure("Passkey could not be verified"))?;
    let info = match webauthn::verify_authentication(
        &input.credential,
        &claimed.identifier,
        &rp.origin,
        &rp.rp_id,
        &public_key,
        passkey.counter,
        true,
    ) {
        Ok(info) => info,
        Err(_) => {
            release_challenge(&state.pool, &claimed.id).await?;
            return Err(authentication_failure("Passkey could not be verified"));
        }
    };
    mark_verified(&state.pool, &claimed.id).await?;
    let timestamp = now();
    let updated = sqlx::query_as::<_, PasskeyRow>(
        "UPDATE passkeys SET counter = CASE WHEN counter < $1 THEN $1 ELSE counter END, \
         last_used_at = $2, updated_at = $2 WHERE id = $3 RETURNING *",
    )
    .bind(info.new_counter)
    .bind(timestamp)
    .bind(&passkey.id)
    .fetch_one(&state.pool)
    .await?;
    let user = sqlx::query_as::<_, UserRow>("SELECT * FROM users WHERE id = $1")
        .bind(&passkey.user_id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| OrbitError::internal("Passkey owner no longer exists"))?;
    Ok((user, updated))
}

/// Input for [`add_passkey_on`], the transaction-safe primitive the account
/// routes use after a WebAuthn attestation has been verified.
#[derive(Debug, Clone)]
pub struct AddPasskeyInput {
    pub id: String,
    pub user_id: String,
    pub name: String,
    pub credential_id: String,
    pub public_key: String,
    pub counter: i64,
    pub transports: Option<Vec<String>>,
    pub device_type: Option<String>,
    pub backed_up: bool,
}

/// Inserts a verified passkey on a caller-owned connection. A duplicate
/// credential id is a 409, never a silent overwrite.
pub async fn add_passkey_on(
    conn: &mut sqlx::PgConnection,
    input: &AddPasskeyInput,
) -> Result<PasskeyRow> {
    let timestamp = now();
    let row = sqlx::query_as::<_, PasskeyRow>(
        "INSERT INTO passkeys \
         (id, user_id, name, credential_id, public_key, counter, transports, device_type, \
          backed_up, created_at, updated_at) \
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10) \
         ON CONFLICT DO NOTHING RETURNING *",
    )
    .bind(&input.id)
    .bind(&input.user_id)
    .bind(&input.name)
    .bind(&input.credential_id)
    .bind(&input.public_key)
    .bind(input.counter)
    .bind(
        input
            .transports
            .as_ref()
            .map(|values| sqlx::types::Json(values.clone())),
    )
    .bind(&input.device_type)
    .bind(input.backed_up)
    .bind(timestamp)
    .fetch_optional(&mut *conn)
    .await?;
    row.ok_or_else(|| {
        OrbitError::conflict(
            error_codes::PASSKEY_REGISTRATION_FAILURE,
            "This authenticator is already registered",
        )
    })
}

/// Deletes one passkey owned by `user_id` on a caller-owned connection.
pub async fn delete_passkey_on(
    conn: &mut sqlx::PgConnection,
    user_id: &str,
    id: &str,
) -> Result<Option<PasskeyRow>> {
    Ok(sqlx::query_as::<_, PasskeyRow>(
        "DELETE FROM passkeys WHERE id = $1 AND user_id = $2 RETURNING *",
    )
    .bind(id)
    .bind(user_id)
    .fetch_optional(&mut *conn)
    .await?)
}

/// [`delete_passkey_on`] on the pool, for callers without a transaction.
pub async fn delete_passkey(pool: &PgPool, user_id: &str, id: &str) -> Result<Option<PasskeyRow>> {
    let mut conn = pool.acquire().await?;
    delete_passkey_on(&mut conn, user_id, id).await
}

/// Lists a user's passkeys.
pub async fn list_passkeys(pool: &PgPool, user_id: &str) -> Result<Vec<PasskeyRow>> {
    Ok(sqlx::query_as::<_, PasskeyRow>(
        "SELECT * FROM passkeys WHERE user_id = $1 ORDER BY created_at ASC",
    )
    .bind(user_id)
    .fetch_all(pool)
    .await?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn origins_normalize_like_the_url_api() {
        assert_eq!(
            origin_of("http://localhost:3000/page?x=1"),
            Some("http://localhost:3000".into())
        );
        assert_eq!(origin_of("not a url"), None);
    }
}
