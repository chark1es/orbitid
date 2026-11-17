//! Provider profile normalization and token-response parsing.
//!
//! Ported from the retired TypeScript server. Each
//! built-in provider publishes its own userinfo shape; this module turns all of
//! them into [`ExternalProfile`] without trusting anything beyond what the
//! provider actually asserted.

use serde_json::{Map, Value};

use crate::error::callback_error;
use crate::oauth::OAuthTokenSet;
use crate::profile::{build_profile, ExternalProfile};

/// `rec(v)` — the value when it is a JSON object, otherwise an empty map.
pub fn rec(value: &Value) -> &Map<String, Value> {
    static EMPTY: std::sync::OnceLock<Map<String, Value>> = std::sync::OnceLock::new();
    match value {
        Value::Object(map) => map,
        _ => EMPTY.get_or_init(Map::new),
    }
}

/// `str(v)` — non-empty strings only.
pub fn str_opt(value: &Value) -> Option<String> {
    match value {
        Value::String(text) if !text.is_empty() => Some(text.clone()),
        _ => None,
    }
}

/// `strOrEmpty(v)`.
pub fn str_or_empty(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        _ => String::new(),
    }
}

/// `String(v ?? "")` for ids that arrive as strings or numbers.
pub fn id_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Number(number) => number.to_string(),
        _ => String::new(),
    }
}

/// Providers send flags as booleans or as the strings `"true"`/`"false"`
/// (Apple does the latter). Anything else is unknown.
pub fn bool_or_undefined(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::String(text) if text == "true" => Some(true),
        Value::String(text) if text == "false" => Some(false),
        _ => None,
    }
}

fn at_ref<'a>(value: &'a Value, path: &str) -> Option<&'a Value> {
    let mut current = value;
    for part in path.split('.') {
        current = rec(current).get(part)?;
    }
    Some(current)
}

/// `at(obj, path)` for a dotted JSON path.
pub fn at(value: &Value, path: &str) -> Value {
    if path.is_empty() {
        return Value::Null;
    }
    at_ref(value, path).cloned().unwrap_or(Value::Null)
}

mod normalize;
pub use normalize::normalize_profile;

/// Profile from an ID token the adapter did not verify (matching the TypeScript
/// behaviour for providers that have no userinfo endpoint).
pub fn id_token_profile(
    key: &str,
    tokens: &OAuthTokenSet,
) -> Result<ExternalProfile, orbitid_core::OrbitError> {
    let Some(id_token) = tokens.id_token.as_deref() else {
        return Err(callback_error(
            "Identity provider did not return an ID token",
        ));
    };
    let claims = crate::jwt::decode_claims(id_token)?;
    let sub = str_opt(&claims.get("sub").cloned().unwrap_or(Value::Null)).ok_or_else(|| {
        callback_error("Identity provider returned an ID token without a subject")
    })?;
    let mut p = build_profile(key, sub, Some(tokens));
    p.email = str_opt(&claims["email"]);
    p.email_verified = Some(bool_or_undefined(&claims["email_verified"]).unwrap_or(false));
    p.first_name = str_opt(&claims["given_name"]);
    p.last_name = str_opt(&claims["family_name"]);
    p.username = str_opt(&claims["preferred_username"]);
    p.image_url = str_opt(&claims["picture"]);
    p.raw = Some(claims);
    Ok(p)
}

/// `{ Authorization: Bearer <access token> }` as header pairs.
pub fn bearer(tokens: &OAuthTokenSet) -> Vec<(&'static str, String)> {
    vec![("authorization", format!("Bearer {}", tokens.access_token))]
}

/// The same header as owned `(name, value)` pairs for [`crate::http::request_json`].
pub fn bearer_headers(tokens: &OAuthTokenSet) -> Vec<(String, String)> {
    vec![
        (
            "authorization".to_string(),
            format!("Bearer {}", tokens.access_token),
        ),
        ("accept".to_string(), "application/json".to_string()),
    ]
}

/// Turns an arctic-style token response into [`OAuthTokenSet`].
pub fn tokens_from_arctic(data: &Value) -> Result<OAuthTokenSet, orbitid_core::OrbitError> {
    let map = rec(data);
    let field = |name: &str| map.get(name).cloned().unwrap_or(Value::Null);
    let access_token = str_opt(&field("access_token"))
        .ok_or_else(|| callback_error("Missing or invalid 'access_token' field"))?;
    let expires_in = map.get("expires_in").and_then(Value::as_f64);
    Ok(OAuthTokenSet {
        access_token,
        refresh_token: str_opt(&field("refresh_token")),
        expires_at: expires_in.map(|seconds| crate::http::now_ms() + (seconds * 1000.0) as i64),
        scopes: str_opt(&field("scope")),
        id_token: str_opt(&field("id_token")),
        id_token_claims: None,
        raw: data.clone(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tokens() -> OAuthTokenSet {
        OAuthTokenSet {
            access_token: "at".into(),
            ..OAuthTokenSet::default()
        }
    }

    #[test]
    fn google_maps_the_oidc_shape() {
        let p = normalize_profile(
            "google",
            &json!({ "sub": "g-1", "email": "ada@example.com", "email_verified": true, "given_name": "Ada", "family_name": "Lovelace", "picture": "https://img/ada.png" }),
            &tokens(),
        );
        assert_eq!(p.provider, "google");
        assert_eq!(p.provider_user_id, "g-1");
        assert_eq!(p.email.as_deref(), Some("ada@example.com"));
        assert_eq!(p.email_verified, Some(true));
        assert_eq!(p.username.as_deref(), Some("ada"));
        assert_eq!(p.image_url.as_deref(), Some("https://img/ada.png"));
        assert_eq!(p.access_token.as_deref(), Some("at"));
    }

    #[test]
    fn github_public_email_is_unverified_and_names_split() {
        let p = normalize_profile(
            "github",
            &json!({ "id": 42, "login": "ada", "name": "Ada Lovelace", "email": "public@example.com", "avatar_url": "https://a" }),
            &tokens(),
        );
        assert_eq!(p.provider_user_id, "42");
        assert_eq!(p.email_verified, Some(false));
        assert_eq!(p.first_name.as_deref(), Some("Ada"));
        assert_eq!(p.last_name.as_deref(), Some("Lovelace"));
    }

    #[test]
    fn provider_shapes_with_wrappers_are_unwrapped() {
        let twitch = normalize_profile(
            "twitch",
            &json!({ "data": [{ "id": "t1", "display_name": "Ada", "email": "a@x" }] }),
            &tokens(),
        );
        assert_eq!(twitch.provider_user_id, "t1");
        let linear = normalize_profile(
            "linear",
            &json!({ "data": { "viewer": { "id": "l1", "email": "a@x", "displayName": "Ada" } } }),
            &tokens(),
        );
        assert_eq!(linear.provider_user_id, "l1");
        let tiktok = normalize_profile(
            "tiktok",
            &json!({ "data": { "user": { "open_id": "o1", "display_name": "Ada" } } }),
            &tokens(),
        );
        assert_eq!(tiktok.provider_user_id, "o1");
    }

    #[test]
    fn flags_accept_strings_booleans_and_nothing_else() {
        assert_eq!(bool_or_undefined(&json!(true)), Some(true));
        assert_eq!(bool_or_undefined(&json!("true")), Some(true));
        assert_eq!(bool_or_undefined(&json!("false")), Some(false));
        assert_eq!(bool_or_undefined(&json!(1)), None);
        assert_eq!(bool_or_undefined(&json!(null)), None);
    }

    #[test]
    fn id_token_profile_requires_a_subject() {
        let token = format!(
            "{}.{}.{}",
            base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                br#"{"alg":"RS256"}"#
            ),
            base64::Engine::encode(
                &base64::engine::general_purpose::URL_SAFE_NO_PAD,
                br#"{"email":"a@x"}"#
            ),
            ""
        );
        let mut set = tokens();
        set.id_token = Some(token);
        assert!(id_token_profile("xero", &set).is_err());
    }

    #[test]
    fn email_may_link_requires_explicit_verification() {
        let mut p = ExternalProfile {
            email: Some("a@x".into()),
            email_verified: Some(false),
            ..ExternalProfile::default()
        };
        assert!(!p.email_may_link());
        p.email_verified = Some(true);
        assert!(p.email_may_link());
        p.email = None;
        assert!(!p.email_may_link());
    }
}
