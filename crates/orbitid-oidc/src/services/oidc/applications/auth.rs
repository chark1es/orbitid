use orbitid_core::crypto::{safe_equal, sha256};
use orbitid_core::state::AppState;

use crate::services::oidc::issuer::loopback_redirect_match;
use crate::services::oidc::shared::OAuthError;

use super::*;

/// Scopes this application may request. `openid` is always allowed.
pub fn application_scopes(app: &ApplicationRow) -> Vec<String> {
    let mut scopes = vec!["openid".to_string()];
    for scope in crate::services::oidc::shared::parse_scopes(&app.scopes) {
        if !scopes.contains(&scope) {
            scopes.push(scope);
        }
    }
    scopes
}

pub fn assert_scopes_allowed(
    app: &ApplicationRow,
    requested: &[String],
) -> std::result::Result<Vec<String>, OAuthError> {
    let allowed = application_scopes(app);
    let invalid: Vec<&str> = requested
        .iter()
        .filter(|scope| !allowed.contains(scope))
        .map(String::as_str)
        .collect();
    if !invalid.is_empty() {
        return Err(OAuthError::bad_request(
            "invalid_scope",
            format!("Unsupported scope(s): {}", invalid.join(", ")),
        ));
    }
    let mut unique: Vec<String> = Vec::new();
    for scope in requested {
        if !unique.contains(scope) {
            unique.push(scope.clone());
        }
    }
    Ok(unique)
}

/// base64url(sha256(verifier)) — the only supported PKCE derivation (S256).
pub fn pkce_challenge_for(verifier: &str) -> String {
    use base64::Engine;
    use sha2::{Digest, Sha256};
    let digest = Sha256::digest(verifier.as_bytes());
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
}

#[derive(Clone)]
pub struct BasicAuthorization {
    pub client_id: String,
    pub client_secret: String,
    pub raw_client_secret: String,
}

impl std::fmt::Debug for BasicAuthorization {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("BasicAuthorization")
            .field("client_id", &self.client_id)
            .field("client_secret", &"<redacted>")
            .field("raw_client_secret", &"<redacted>")
            .finish()
    }
}

/// RFC 6749 §2.3.1 Basic credentials. `client_secret` is the form-decoded
/// reading and `raw_client_secret` the verbatim one.
pub fn parse_basic_authorization(header: Option<&str>) -> Option<BasicAuthorization> {
    use base64::Engine;
    let header = header?;
    let encoded = header.strip_prefix("Basic ")?;
    let decoded = base64::engine::general_purpose::STANDARD
        .decode(encoded.trim())
        .ok()?;
    let decoded = String::from_utf8(decoded).ok()?;
    let idx = decoded.find(':')?;
    let (client_id, rest) = decoded.split_at(idx);
    let raw = &rest[1..];
    Some(BasicAuthorization {
        client_id: crate::web::form_decode(client_id),
        client_secret: crate::web::form_decode(raw),
        raw_client_secret: raw.to_string(),
    })
}

/// Every reading of a presented secret a client could have meant.
fn secret_candidates(presented: &str) -> Vec<String> {
    let mut values = vec![presented.to_string()];
    let decoded = crate::web::form_decode(presented);
    if !values.contains(&decoded) {
        values.push(decoded);
    }
    let plus_decoded = crate::web::form_decode(&presented.replace('+', " "));
    if !values.contains(&plus_decoded) {
        values.push(plus_decoded);
    }
    values
}

/// Client authentication for the token/revocation/introspection endpoints.
pub async fn authenticate_client(
    state: &AppState,
    authorization: Option<&str>,
    client_id: Option<&str>,
    client_secret: Option<&str>,
) -> std::result::Result<ApplicationRow, OAuthError> {
    let basic = parse_basic_authorization(authorization);
    let id = match (&basic, client_id) {
        (Some(basic), _) => Some(basic.client_id.clone()),
        (None, Some(id)) if !id.is_empty() => Some(id.to_string()),
        _ => None,
    };
    let Some(id) = id else {
        return Err(OAuthError::invalid_client("client_id is required"));
    };
    let app = get_application_by_client_id(state, &id)
        .await
        .map_err(|_| OAuthError::invalid_client("Client authentication failed"))?
        .ok_or_else(|| OAuthError::invalid_client("Unknown client"))?;
    let mut presented: Vec<String> = Vec::new();
    if let Some(basic) = &basic {
        presented.push(basic.client_secret.clone());
        presented.push(basic.raw_client_secret.clone());
    } else if let Some(secret) = client_secret.filter(|value| !value.is_empty()) {
        presented.push(secret.to_string());
    }
    if app.is_public {
        if presented.iter().any(|value| !value.is_empty()) {
            return Err(OAuthError::invalid_client(
                "Public clients must not send a client secret",
            ));
        }
        return Ok(app);
    }
    let Some(hash) = app.client_secret_hash.as_deref() else {
        return Err(OAuthError::invalid_client("Client authentication failed"));
    };
    if presented.is_empty() {
        return Err(OAuthError::invalid_client("Client authentication failed"));
    }
    for candidate in presented.iter().flat_map(|value| secret_candidates(value)) {
        if safe_equal(&sha256(&candidate), hash) {
            return Ok(app);
        }
    }
    Err(OAuthError::invalid_client("Client authentication failed"))
}

/// Rejects redirect URIs that are not registered verbatim (open-redirect
/// protection), with RFC 8252 §7.3 loopback-port tolerance.
pub fn assert_redirect_uri(
    app: &ApplicationRow,
    redirect_uri: Option<&str>,
) -> std::result::Result<String, OAuthError> {
    let Some(redirect_uri) = redirect_uri.filter(|value| !value.is_empty()) else {
        return Err(OAuthError::invalid_request("redirect_uri is required"));
    };
    let registered = &app.redirect_uris.0;
    if registered.iter().any(|uri| uri == redirect_uri)
        || registered
            .iter()
            .any(|uri| loopback_redirect_match(uri, redirect_uri))
    {
        return Ok(redirect_uri.to_string());
    }
    Err(OAuthError::invalid_request(
        "redirect_uri is not registered for this client",
    ))
}

pub fn assert_post_logout_redirect_uri(
    app: &ApplicationRow,
    redirect_uri: &str,
) -> std::result::Result<String, OAuthError> {
    let registered = &app.post_logout_redirect_uris.0;
    if registered.iter().any(|uri| uri == redirect_uri)
        || registered
            .iter()
            .any(|uri| loopback_redirect_match(uri, redirect_uri))
    {
        return Ok(redirect_uri.to_string());
    }
    Err(OAuthError::invalid_request(
        "post_logout_redirect_uri is not registered for this client",
    ))
}
