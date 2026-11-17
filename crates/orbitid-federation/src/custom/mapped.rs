//! Claim mapping for custom providers (`claimMapping` dotted paths).

use serde_json::{Map, Value};

use crate::config::OAuthProviderConfig;
use crate::error::callback_error;
use crate::oauth::OAuthTokenSet;
use crate::profile::{build_profile, ExternalProfile};

fn first_string(data: &Value, paths: &[String]) -> Option<String> {
    for path in paths {
        if path.is_empty() {
            continue;
        }
        let value = crate::profiles::at(data, path);
        match value {
            Value::String(text) if !text.is_empty() => return Some(text),
            Value::Number(number) => return Some(number.to_string()),
            _ => {}
        }
    }
    None
}

fn split_name(name: Option<&str>) -> (Option<String>, Option<String>) {
    let Some(name) = name else {
        return (None, None);
    };
    let mut parts = name.split_whitespace();
    let first = parts.next().unwrap_or("").to_string();
    let rest = parts.collect::<Vec<_>>().join(" ");
    (
        (!first.is_empty()).then_some(first),
        (!rest.is_empty()).then_some(rest),
    )
}

/// Reads an `email_verified`-style claim without ever turning an explicit
/// negative into true. Booleans, `"true"`/`"false"`, `"1"`/`"0"` and 1/0 are
/// preserved; only an absent claim falls back to the operator's promise.
pub(crate) fn verified_claim(value: &Value) -> Option<bool> {
    match value {
        Value::Bool(flag) => Some(*flag),
        Value::Number(number) => match number.as_i64() {
            Some(1) => Some(true),
            Some(0) => Some(false),
            _ => None,
        },
        Value::String(text) => match text.trim().to_lowercase().as_str() {
            "true" | "1" => Some(true),
            "false" | "0" => Some(false),
            _ => None,
        },
        _ => None,
    }
}

fn claim_path(cfg: &OAuthProviderConfig, field: &str) -> String {
    cfg.claim_mapping
        .as_ref()
        .map(|mapping| match field {
            "sub" => mapping.sub.clone(),
            "email" => mapping.email.clone(),
            "emailVerified" => mapping.email_verified.clone(),
            "name" => mapping.name.clone(),
            "firstName" => mapping.first_name.clone(),
            "lastName" => mapping.last_name.clone(),
            "username" => mapping.username.clone(),
            "picture" => mapping.picture.clone(),
            _ => String::new(),
        })
        .unwrap_or_default()
        .trim()
        .to_string()
}

fn paths(mapped: &str, conventional: &[&str]) -> Vec<String> {
    let mut out = Vec::with_capacity(conventional.len() + 1);
    if !mapped.is_empty() {
        out.push(mapped.to_string());
    }
    out.extend(conventional.iter().map(|path| (*path).to_string()));
    out
}

/// Turns a claim set (ID token or userinfo) into an [`ExternalProfile`].
pub fn mapped_profile(
    cfg: &OAuthProviderConfig,
    data: &Value,
    tokens: &OAuthTokenSet,
) -> Result<ExternalProfile, orbitid_core::OrbitError> {
    let subject = first_string(
        data,
        &paths(
            &claim_path(cfg, "sub"),
            &["sub", "id", "user_id", "userId", "open_id", "account_id"],
        ),
    )
    .ok_or_else(|| callback_error("The identity provider returned a profile without a subject"))?;
    let email = first_string(
        data,
        &paths(
            &claim_path(cfg, "email"),
            &["email", "mail", "email_address"],
        ),
    );
    let mapped_verified = claim_path(cfg, "emailVerified");
    let verified_raw = if !mapped_verified.is_empty() {
        crate::profiles::at(data, &mapped_verified)
    } else {
        let first = crate::profiles::at(data, "email_verified");
        if first.is_null() {
            let second = crate::profiles::at(data, "verified");
            if second.is_null() {
                crate::profiles::at(data, "email_verified_flag")
            } else {
                second
            }
        } else {
            first
        }
    };
    let explicit = verified_claim(&verified_raw);
    let email_verified = match explicit {
        Some(value) => value,
        None => cfg.trust_email_verified.unwrap_or(false) && email.is_some(),
    };
    let name = first_string(
        data,
        &paths(
            &claim_path(cfg, "name"),
            &[
                "name",
                "display_name",
                "displayName",
                "fullname",
                "full_name",
            ],
        ),
    );
    let (from_first, from_last) = split_name(name.as_deref());
    let mut profile = build_profile(&cfg.key, subject, Some(tokens));
    profile.email = email;
    profile.email_verified = Some(email_verified);
    profile.first_name = first_string(
        data,
        &paths(
            &claim_path(cfg, "firstName"),
            &["given_name", "first_name", "firstName"],
        ),
    )
    .or(from_first);
    profile.last_name = first_string(
        data,
        &paths(
            &claim_path(cfg, "lastName"),
            &["family_name", "last_name", "lastName"],
        ),
    )
    .or(from_last);
    profile.username = first_string(
        data,
        &paths(
            &claim_path(cfg, "username"),
            &["preferred_username", "username", "login", "screen_name"],
        ),
    );
    profile.image_url = first_string(
        data,
        &paths(
            &claim_path(cfg, "picture"),
            &[
                "picture",
                "avatar_url",
                "avatarUrl",
                "image",
                "profile_image_url",
            ],
        ),
    );
    profile.raw = Some(Value::Object(match data {
        Value::Object(map) => map.clone(),
        _ => Map::new(),
    }));
    Ok(profile)
}

/// Whether an absent `email_verified` becomes verified: only the operator's
/// explicit promise, never an explicit false.
pub fn trust_applies(cfg: &OAuthProviderConfig, claim: &Value) -> bool {
    match verified_claim(claim) {
        Some(value) => value,
        None => cfg.trust_email_verified.unwrap_or(false),
    }
}
