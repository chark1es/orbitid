//! Shortcode resolution for `session.customClaims` (the simpler engine from
//! `services/tokens.ts`, without quoted literals).

use regex::Regex;
use serde_json::{Map, Value};

use orbitid_core::models::SessionRow;
use orbitid_core::resources::{UserJson, VerificationStatus};

use super::TokenOrg;

const PROTOTYPE_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

fn lookup_path(source: &Value, path: &str) -> Option<Value> {
    let mut current = source;
    for part in path.split('.') {
        if PROTOTYPE_KEYS.contains(&part) {
            return None;
        }
        match current {
            Value::Array(items) => {
                let index: usize = part.parse().ok()?;
                current = items.get(index)?;
            }
            Value::Object(map) => {
                if !map.contains_key(part) {
                    return None;
                }
                current = map.get(part)?;
            }
            _ => return None,
        }
    }
    Some(current.clone())
}

fn is_empty(value: &Value) -> bool {
    matches!(value, Value::Null) || value.as_str() == Some("")
}

fn stringify(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        Value::Null => String::new(),
        other => other.to_string(),
    }
}

/// Resolves `{{user.first_name}}`-style shortcodes, including `||` fallbacks.
/// A value that is exactly one shortcode keeps its JSON type.
pub fn resolve_shortcode_value(value: &Value, source: &Value) -> Option<Value> {
    let Value::String(text) = value else {
        return Some(value.clone());
    };
    let whole = Regex::new(r"^\s*\{\{\s*([^{}]+?)\s*\}\}\s*$").ok()?;
    if let Some(captures) = whole.captures(text) {
        let expression = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
        for candidate in expression.split("||") {
            if let Some(resolved) = lookup_path(source, candidate.trim()) {
                if !is_empty(&resolved) {
                    return Some(resolved);
                }
            }
        }
        return None;
    }
    let interpolation = Regex::new(r"\{\{\s*([^{}]+?)\s*\}\}").ok()?;
    Some(Value::String(
        interpolation
            .replace_all(text, |captures: &regex::Captures<'_>| {
                let expression = captures.get(1).map(|m| m.as_str()).unwrap_or_default();
                for candidate in expression.split("||") {
                    if let Some(resolved) = lookup_path(source, candidate.trim()) {
                        if !is_empty(&resolved) {
                            return match &resolved {
                                Value::Object(_) | Value::Array(_) => resolved.to_string(),
                                other => stringify(other),
                            };
                        }
                    }
                }
                String::new()
            })
            .into_owned(),
    ))
}

pub(crate) fn resolve_claim_map(claims: &Map<String, Value>, source: &Value) -> Map<String, Value> {
    let mut out = Map::new();
    for (key, value) in claims {
        if let Some(resolved) = resolve_shortcode_value(value, source) {
            out.insert(key.clone(), resolved);
        }
    }
    out
}

pub(crate) fn shortcode_source(
    user: &UserJson,
    org: Option<&TokenOrg>,
    session: &SessionRow,
) -> Value {
    let emails = &user.email_addresses;
    let primary_email = emails
        .iter()
        .find(|email| Some(&email.id) == user.primary_email_address_id.as_ref())
        .or_else(|| emails.first());
    let phones = &user.phone_numbers;
    let primary_phone = phones
        .iter()
        .find(|phone| Some(&phone.id) == user.primary_phone_number_id.as_ref())
        .or_else(|| phones.first());
    let mut user_value = serde_json::to_value(user).unwrap_or(Value::Object(Map::new()));
    if let Value::Object(map) = &mut user_value {
        let full_name = [user.first_name.as_deref(), user.last_name.as_deref()]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" ");
        map.insert(
            "full_name".into(),
            if full_name.is_empty() {
                Value::Null
            } else {
                Value::String(full_name)
            },
        );
        map.insert(
            "primary_email_address".into(),
            primary_email
                .map(|email| Value::String(email.email_address.clone()))
                .unwrap_or(Value::Null),
        );
        map.insert(
            "primary_phone_number".into(),
            primary_phone
                .map(|phone| Value::String(phone.phone_number.clone()))
                .unwrap_or(Value::Null),
        );
        map.insert(
            "email_verified".into(),
            Value::Bool(primary_email.is_some_and(|email| {
                email
                    .verification
                    .as_ref()
                    .is_some_and(|verification| verification.status == VerificationStatus::Verified)
            })),
        );
        map.insert(
            "phone_number_verified".into(),
            Value::Bool(primary_phone.is_some_and(|phone| {
                phone
                    .verification
                    .as_ref()
                    .is_some_and(|verification| verification.status == VerificationStatus::Verified)
            })),
        );
    }
    let org_value = match org {
        Some(org) => serde_json::json!({
            "id": org.id,
            "slug": org.slug,
            "name": org.name,
            "role": org.role,
            "permissions": org.permissions,
        }),
        None => Value::Null,
    };
    let membership = match org {
        Some(org) => serde_json::json!({
            "permissions": org.permissions,
            "role": org.role,
        }),
        None => Value::Null,
    };
    serde_json::json!({
        "user": user_value,
        "org": org_value,
        "session": { "id": session.id, "actor": session.actor.as_ref().map(|actor| actor.0.clone()) },
        "org_membership": membership,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_shortcodes_and_fallbacks() {
        let source = serde_json::json!({
            "user": {"id": "user_1", "first_name": "Ada", "tags": ["a"], "meta": {"tier": "pro"}}
        });
        assert_eq!(
            resolve_shortcode_value(&Value::String("{{user.id}}".into()), &source),
            Some(Value::String("user_1".into()))
        );
        assert_eq!(
            resolve_shortcode_value(&Value::String("{{user.nope || user.id}}".into()), &source),
            Some(Value::String("user_1".into()))
        );
        assert_eq!(
            resolve_shortcode_value(&Value::String("x {{user.meta}}".into()), &source),
            Some(Value::String("x {\"tier\":\"pro\"}".into()))
        );
        assert_eq!(
            resolve_shortcode_value(&Value::String("{{user.nope}}".into()), &source),
            None
        );
    }
}
