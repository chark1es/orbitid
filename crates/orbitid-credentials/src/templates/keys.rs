//! Custom JWT-template signing keys (HS256 secret or private JWK, sealed with
//! `ORBITID_ENCRYPTION_KEY`).

use serde_json::{Map, Value};

use orbitid_core::crypto::{decrypt, encrypt, random_token};
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::JwtTemplateRow;
use orbitid_core::AppState;

use crate::jwt::{Jwk, JwsAlgorithm};
use crate::limits::run_cpu;

pub const SUPPORTED_SIGNING_ALGORITHMS: [&str; 3] = ["RS256", "ES256", "HS256"];

/// Rejects claims owned by the session machinery. Message/meta match the
/// Backend API route.
pub fn assert_allowed_claims(claims: &Map<String, Value>) -> Result<()> {
    for key in claims.keys() {
        if orbitid_core::claims::RESERVED_SESSION_CLAIMS.contains(&key.as_str()) {
            return Err(OrbitError::new(
                axum::http::StatusCode::UNPROCESSABLE_ENTITY,
                error_codes::FORM_PARAM_VALUE_INVALID,
                format!("\"{key}\" is a reserved claim and cannot be set in a template."),
            )
            .with_meta(serde_json::json!({ "param_name": format!("claims.{key}") })));
        }
    }
    Ok(())
}

/// Generates and seals a custom template signing key: an HMAC secret for HS256
/// or a private JWK for RS256/ES256.
pub async fn generate_template_signing_key(state: &AppState, algorithm: &str) -> Result<String> {
    if !SUPPORTED_SIGNING_ALGORITHMS.contains(&algorithm) {
        return Err(OrbitError::new(
            axum::http::StatusCode::UNPROCESSABLE_ENTITY,
            error_codes::FORM_PARAM_VALUE_INVALID,
            "signing_algorithm must be RS256, ES256 or HS256",
        ));
    }
    let encryption_key = state.env.encryption_key.clone();
    let algorithm = algorithm.to_string();
    run_cpu(move || match algorithm.as_str() {
        "HS256" => encrypt(&encryption_key, &random_token(48)).map_err(|error| {
            OrbitError::internal(format!("Could not encrypt template key: {error}"))
        }),
        "RS256" => {
            let mut rng = rand_core::OsRng;
            let private = rsa::RsaPrivateKey::new(&mut rng, 2048).map_err(|error| {
                OrbitError::internal(format!("Could not generate an RSA key: {error}"))
            })?;
            let key = Jwk::Rsa {
                kid: None,
                alg: None,
                use_: None,
                public: rsa::RsaPublicKey::from(&private),
                private: Some(private),
            };
            let json = serde_json::to_string(&key.to_value(true)).map_err(|error| {
                OrbitError::internal(format!("Could not serialize template key: {error}"))
            })?;
            encrypt(&encryption_key, &json).map_err(|error| {
                OrbitError::internal(format!("Could not encrypt template key: {error}"))
            })
        }
        _ => {
            let secret = p256::SecretKey::random(&mut rand_core::OsRng);
            let key = Jwk::Ec {
                kid: None,
                alg: None,
                use_: None,
                public: secret.public_key(),
                private: Some(secret),
            };
            let json = serde_json::to_string(&key.to_value(true)).map_err(|error| {
                OrbitError::internal(format!("Could not serialize template key: {error}"))
            })?;
            encrypt(&encryption_key, &json).map_err(|error| {
                OrbitError::internal(format!("Could not encrypt template key: {error}"))
            })
        }
    })
    .await?
}

/// Imports a sealed template key for signing.
pub fn import_template_key(state: &AppState, encrypted: &str, algorithm: &str) -> Result<Jwk> {
    let plain = decrypt(&state.env.encryption_key, encrypted)
        .map_err(|_| OrbitError::internal("Could not decrypt template signing key"))?;
    if algorithm == "HS256" {
        return Ok(Jwk::Oct {
            kid: None,
            alg: Some(JwsAlgorithm::HS256),
            use_: None,
            secret: plain.into_bytes(),
        });
    }
    let value: Value = serde_json::from_str(&plain)
        .map_err(|_| OrbitError::internal("Template signing key is not a JWK"))?;
    let key = Jwk::from_value(&value).map_err(|error| {
        OrbitError::internal(format!("Template signing key is invalid: {error}"))
    })?;
    if !key.supports(
        JwsAlgorithm::parse(algorithm)
            .ok_or_else(|| OrbitError::internal("Unsupported template algorithm"))?,
    ) {
        return Err(OrbitError::internal(
            "Template signing key does not match its algorithm",
        ));
    }
    Ok(key)
}

/// The verification key exposed by the Backend API: HMAC secret or public JWK.
pub fn template_verification_key(state: &AppState, row: &JwtTemplateRow) -> Result<Option<Value>> {
    if !row.custom_signing_key {
        return Ok(None);
    }
    let Some(encrypted) = row.signing_key_enc.as_deref() else {
        return Ok(None);
    };
    let plain = decrypt(&state.env.encryption_key, encrypted)
        .map_err(|_| OrbitError::internal("Could not decrypt template signing key"))?;
    if row.signing_algorithm == "HS256" {
        return Ok(Some(Value::String(plain)));
    }
    let value: Value = serde_json::from_str(&plain)
        .map_err(|_| OrbitError::internal("Template signing key is not a JWK"))?;
    let key = Jwk::from_value(&value).map_err(|error| {
        OrbitError::internal(format!("Template signing key is invalid: {error}"))
    })?;
    Ok(Some(key.public_value()))
}
