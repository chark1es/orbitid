//! Custom-provider ID-token verification.

use orbitid_core::AppState;
use serde_json::Value;

use super::OidcDiscovery;
use crate::config::OAuthProviderConfig;
use crate::error::callback_error;
use crate::jwt::{remote_jwks, verify_id_token};

/// Verifies a custom provider's ID token. A failed check is final: falling back
/// to userinfo would let a forged token's claims be replaced by someone else's.
pub async fn verify_custom_id_token(
    state: &AppState,
    cfg: &OAuthProviderConfig,
    discovery: &OidcDiscovery,
    id_token: &str,
    nonce: Option<&str>,
) -> Result<Value, orbitid_core::OrbitError> {
    let Some(jwks_uri) = discovery.jwks_uri.as_deref() else {
        return Err(callback_error(
            "The identity provider has no JWKS to verify its ID token",
        ));
    };
    // A key rotation between the fetch and verification is common: retry once.
    for force_refresh in [false, true] {
        let result = async {
            let jwks = remote_jwks(Some(state), jwks_uri, force_refresh).await?;
            verify_id_token(
                &jwks,
                id_token,
                discovery.issuer.as_deref(),
                &cfg.client_id,
                60,
                nonce,
            )
        }
        .await;
        match result {
            Ok(claims) => return Ok(claims),
            Err(error) if error.message.contains("nonce did not match") => {
                return Err(callback_error(
                    "The identity provider returned an ID token whose nonce did not match",
                ));
            }
            Err(_) if !force_refresh => continue,
            Err(_) => break,
        }
    }
    Err(callback_error(
        "The identity provider returned an ID token that could not be verified",
    ))
}
