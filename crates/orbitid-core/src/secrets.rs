//! Secret handling for instance settings, ported from
//! the retired TypeScript server.
//!
//! Every response masks secret values; every write drops echoed masks instead
//! of storing them. Stored values are sealed with the instance encryption key.
//! Values written by older versions are plaintext: they read as-is and are
//! sealed on the next write.

use serde_json::{Map, Value};

use crate::crypto::{decrypt, encrypt};
use crate::settings::InstanceSettings;

/// Wire mask for every secret field.
pub const MASK: &str = "••••";

fn is_sealed_pattern(value: &str) -> bool {
    let mut parts = value.split('.');
    let version = parts.next();
    let iv = parts.next();
    let tag = parts.next();
    let ciphertext = parts.next();
    if parts.next().is_some() {
        return false;
    }
    let valid = |part: Option<&str>| {
        part.is_some_and(|p| {
            !p.is_empty()
                && p.bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        })
    };
    version == Some("v1") && valid(iv) && valid(tag) && valid(ciphertext)
}

/// `lib/crypto.encrypt` output: `v1.<iv>.<tag>.<ciphertext>` (base64url).
pub fn is_sealed_secret(value: &Value) -> bool {
    value.as_str().is_some_and(is_sealed_pattern)
}

/// Reads a stored secret: sealed values are decrypted, plaintext passes through.
pub fn open_secret(encryption_key: &str, value: &str) -> String {
    if !is_sealed_pattern(value) {
        return value.to_string();
    }
    decrypt(encryption_key, value).unwrap_or_default()
}

/// Seals a plaintext secret. Already-sealed values are returned unchanged.
pub fn seal_secret(encryption_key: &str, value: &str) -> String {
    if value.is_empty() || is_sealed_pattern(value) {
        return value.to_string();
    }
    // Encryption never fails for a valid key; fall back to the plaintext rather
    // than panicking, matching the "never crash the instance" rule.
    encrypt(encryption_key, value).unwrap_or_else(|_| value.to_string())
}

pub fn is_masked_secret(value: &Value) -> bool {
    value.as_str() == Some(MASK)
}

fn slot_paths(root: &Value) -> Vec<Vec<String>> {
    let mut slots = vec![
        vec!["email".into(), "smtpUrl".into()],
        vec!["email".into(), "resendApiKey".into()],
        vec!["sms".into(), "twilioAuthToken".into()],
        vec!["security".into(), "captchaSecret".into()],
    ];
    if let Some(social) = root.get("social").and_then(Value::as_object) {
        for provider in social.keys() {
            slots.push(vec![
                "social".into(),
                provider.clone(),
                "clientSecret".into(),
            ]);
            slots.push(vec![
                "social".into(),
                provider.clone(),
                "applePrivateKey".into(),
            ]);
        }
    }
    slots
}

fn at<'a>(root: &'a Value, path: &[String]) -> Option<&'a Value> {
    let mut node = root;
    for segment in path {
        node = node.as_object()?.get(segment)?;
    }
    Some(node)
}

fn put(root: &mut Value, path: &[String], value: Value) -> bool {
    let Some((last, parents)) = path.split_last() else {
        return false;
    };
    let mut node = root;
    for segment in parents {
        let Some(next) = node.as_object_mut().and_then(|map| map.get_mut(segment)) else {
            return false;
        };
        node = next;
    }
    let Some(map) = node.as_object_mut() else {
        return false;
    };
    map.insert(last.clone(), value);
    true
}

/// Settings tree with every secret replaced by its mask, plus a `<field>Set`
/// marker for the editor.
pub fn mask_secrets(settings: &InstanceSettings) -> Value {
    let mut copy = serde_json::to_value(settings).unwrap_or(Value::Object(Map::new()));
    let slots = slot_paths(&copy);
    for path in slots {
        let Some((field, parent)) = path.split_last() else {
            continue;
        };
        let value = at(&copy, &path).cloned();
        let is_set = value
            .as_ref()
            .and_then(Value::as_str)
            .is_some_and(|v| !v.is_empty());
        if let Some(Value::Object(parent_map)) = get_mut(&mut copy, parent) {
            parent_map.insert(format!("{field}Set"), Value::Bool(is_set));
        }
        if is_set {
            put(&mut copy, &path, Value::String(MASK.to_string()));
        }
    }
    copy
}

fn get_mut<'a>(root: &'a mut Value, path: &[String]) -> Option<&'a mut Value> {
    let mut node = root;
    for segment in path {
        node = node.as_object_mut()?.get_mut(segment)?;
    }
    Some(node)
}

/// Drops `*Set` helpers and echoed secrets from a PATCH body: a mask, or the
/// stored plaintext sent back unchanged, means "keep what is stored".
pub fn unmask_settings_patch(current: &InstanceSettings, patch: Value) -> Value {
    let current = serde_json::to_value(current).unwrap_or(Value::Object(Map::new()));
    let slots = slot_paths(&current);
    strip_echoes(&current, &slots, &patch, &[])
}

fn strip_echoes(current: &Value, slots: &[Vec<String>], value: &Value, path: &[String]) -> Value {
    match value {
        Value::Array(items) => Value::Array(
            items
                .iter()
                .enumerate()
                .map(|(index, item)| {
                    let mut child = path.to_vec();
                    child.push(index.to_string());
                    strip_echoes(current, slots, item, &child)
                })
                .collect(),
        ),
        Value::Object(map) => {
            let mut out = Map::new();
            for (key, item) in map {
                if key.ends_with("Set") {
                    continue;
                }
                let mut child = path.to_vec();
                child.push(key.clone());
                let is_slot = slots.iter().any(|slot| slot == &child);
                if is_slot
                    && item.is_string()
                    && (is_masked_secret(item) || at(current, &child) == Some(item))
                {
                    continue;
                }
                out.insert(key.clone(), strip_echoes(current, slots, item, &child));
            }
            Value::Object(out)
        }
        other => other.clone(),
    }
}

/// Seals every plaintext secret before the tree is written.
pub fn seal_secrets(encryption_key: &str, settings: &InstanceSettings) -> Value {
    let mut copy = serde_json::to_value(settings).unwrap_or(Value::Object(Map::new()));
    let slots = slot_paths(&copy);
    for path in slots {
        if let Some(Value::String(value)) = at(&copy, &path) {
            if !value.is_empty() {
                let sealed = seal_secret(encryption_key, value);
                put(&mut copy, &path, Value::String(sealed));
            }
        }
    }
    copy
}

/// Opens every sealed secret after reading the instance table.
pub fn open_secrets_tree(encryption_key: &str, settings: Value) -> Value {
    let mut copy = settings;
    let slots = slot_paths(&copy);
    for path in slots {
        if let Some(Value::String(value)) = at(&copy, &path) {
            if is_sealed_pattern(value) {
                let opened = open_secret(encryption_key, value);
                put(&mut copy, &path, Value::String(opened));
            }
        }
    }
    copy
}

#[cfg(test)]
mod tests {
    use super::*;

    fn settings() -> InstanceSettings {
        let mut settings = InstanceSettings::default();
        settings.email.smtp_url = "smtp://mailer:hunter2@smtp.example.com:587".into();
        settings.email.from = "OrbitID <no-reply@example.com>".into();
        settings.security.captcha_secret = "captcha".into();
        settings
    }

    #[test]
    fn masks_every_secret_and_marks_it_set() {
        let masked = mask_secrets(&settings());
        assert_eq!(masked["email"]["smtpUrl"], MASK);
        assert_eq!(masked["email"]["smtpUrlSet"], true);
        assert_eq!(masked["email"]["from"], "OrbitID <no-reply@example.com>");
        assert_eq!(masked["email"]["resendApiKeySet"], false);
        assert_eq!(masked["security"]["captchaSecret"], MASK);
    }

    #[test]
    fn drops_masks_and_echoed_plaintext_from_a_patch() {
        let current = settings();
        let patch = serde_json::json!({
            "email": { "smtpUrl": MASK, "from": "New <no-reply@example.com>" },
            "security": { "captchaSecret": "captcha" }
        });
        let cleaned = unmask_settings_patch(&current, patch);
        assert!(cleaned["email"].get("smtpUrl").is_none());
        assert_eq!(cleaned["email"]["from"], "New <no-reply@example.com>");
        assert!(cleaned["security"].get("captchaSecret").is_none());
    }

    #[test]
    fn seals_and_opens_round_trip() {
        let key = "secrets-test-key-0123456789abcdef";
        let sealed = seal_secrets(key, &settings());
        assert!(is_sealed_secret(&sealed["email"]["smtpUrl"]));
        assert!(!sealed.to_string().contains("hunter2"));
        let opened = open_secrets_tree(key, sealed);
        assert_eq!(
            opened["email"]["smtpUrl"],
            "smtp://mailer:hunter2@smtp.example.com:587"
        );
    }

    #[test]
    fn unreadable_ciphertext_opens_empty() {
        assert_eq!(
            open_secret("wrong-key-0123456789abcdef0123456", "v1.AAAA.BBBB.CCCC"),
            ""
        );
    }
}
