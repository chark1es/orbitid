use serde_json::{Map, Value};

use crate::error::{error_codes, OrbitError, Result};
use crate::settings::types::InstanceSettings;
use sqlx::PgConnection;

pub const SETTINGS_VERSION_KEY: &str = "__settingsVersion";
pub const CURRENT_SETTINGS_VERSION: i64 = 3;
const OLD_DEFAULT_LIFETIME_SECONDS: i64 = 7 * 24 * 60 * 60;
const OLD_DEFAULT_GUEST_RETENTION_SECONDS: i64 = 30 * 24 * 60 * 60;
pub(super) const SETTINGS_CHANNEL: &str = "orbitid_settings";
pub(super) const REFRESH_INTERVAL_SECONDS: u64 = 30;

fn is_object(value: &Value) -> bool {
    value.is_object()
}

const PROTOTYPE_KEYS: [&str; 3] = ["__proto__", "constructor", "prototype"];

/// Deep merge that never copies prototype keys. Missing patch keys keep the
/// stored value; objects merge recursively, everything else replaces.
pub fn deep_merge(base: Value, patch: Value) -> Value {
    match (base, patch) {
        (Value::Object(mut base), Value::Object(patch)) => {
            for (key, value) in patch {
                if PROTOTYPE_KEYS.contains(&key.as_str()) {
                    continue;
                }
                let merged = match base.remove(&key) {
                    Some(existing) if is_object(&existing) && is_object(&value) => {
                        deep_merge(existing, value)
                    }
                    _ => value,
                };
                base.insert(key, merged);
            }
            Value::Object(base)
        }
        (_, patch) => patch,
    }
}

#[derive(Debug, Clone)]
pub struct MigratedSettings {
    pub settings: Value,
    pub changed: bool,
    pub lifetime_converted: bool,
}

/// Versioned settings migration. Only values equal to old defaults convert;
/// a custom value the operator chose is left alone.
pub fn migrate_stored_settings(raw: Value) -> MigratedSettings {
    let source = if is_object(&raw) {
        raw
    } else {
        Value::Object(Map::new())
    };
    let version = source
        .get(SETTINGS_VERSION_KEY)
        .and_then(Value::as_i64)
        .unwrap_or(1);
    let mut clean = source;
    if let Value::Object(map) = &mut clean {
        map.remove(SETTINGS_VERSION_KEY);
    }
    if version >= CURRENT_SETTINGS_VERSION {
        return MigratedSettings {
            settings: clean,
            changed: false,
            lifetime_converted: false,
        };
    }

    let mut migrated = clean;
    let mut lifetime_converted = false;
    // Version 1 → 2.
    if version < 2 {
        if let Some(Value::Object(session)) = migrated.get_mut("session") {
            if session.get("lifetimeSeconds").and_then(Value::as_i64)
                == Some(OLD_DEFAULT_LIFETIME_SECONDS)
            {
                session.insert("lifetimeSeconds".into(), Value::from(0));
                lifetime_converted = true;
            }
            if session.get("multiSession").and_then(Value::as_bool) == Some(false) {
                session.insert("multiSession".into(), Value::Bool(true));
            }
        }
        if let Some(Value::Object(password)) = migrated.get_mut("password") {
            if password
                .get("signOutOfOtherSessionsOnChange")
                .and_then(Value::as_bool)
                == Some(true)
            {
                password.insert("signOutOfOtherSessionsOnChange".into(), Value::Bool(false));
            }
        }
        if let Some(Value::Object(anonymous)) = migrated.get_mut("anonymous") {
            if anonymous.get("retentionSeconds").and_then(Value::as_i64)
                == Some(OLD_DEFAULT_GUEST_RETENTION_SECONDS)
            {
                anonymous.insert("retentionSeconds".into(), Value::from(0));
            }
        }
    }
    // Version 2 → 3: enumeration protection became the default. Off was the old default, so only an instance
    // still on it converts; turning it off again afterwards sticks.
    if version < 3 {
        if let Some(Value::Object(security)) = migrated.get_mut("security") {
            if security
                .get("enumerationProtection")
                .and_then(Value::as_bool)
                == Some(false)
            {
                security.insert("enumerationProtection".into(), Value::Bool(true));
            }
        }
    }
    if let Value::Object(map) = &mut migrated {
        map.insert(
            SETTINGS_VERSION_KEY.into(),
            Value::from(CURRENT_SETTINGS_VERSION),
        );
    }
    MigratedSettings {
        settings: migrated,
        changed: true,
        lifetime_converted,
    }
}

/// Rewrites sessions that the old 7-day default ended. Narrow and idempotent.
/// Runs on the caller's connection so it commits (or rolls back) with the
/// settings migration that triggered it.
pub(super) async fn rescue_sessions_from_legacy_default(conn: &mut PgConnection) -> Result<()> {
    let now = crate::http::now();
    let seven_days = OLD_DEFAULT_LIFETIME_SECONDS * 1000;
    sqlx::query(
        "UPDATE sessions SET expire_at = $1, updated_at = $2 \
         WHERE status IN ('active', 'pending') AND expire_at < $1 \
           AND abs(expire_at - (created_at + $3)) <= $4",
    )
    .bind(crate::keys::SESSION_NEVER_EXPIRES_AT)
    .bind(now)
    .bind(seven_days)
    .bind(5 * 60_000_i64)
    .execute(&mut *conn)
    .await?;
    Ok(())
}

pub(super) fn parse_settings(value: &Value) -> Result<InstanceSettings> {
    let deserializer = value.clone();
    match serde_path_to_error::deserialize::<_, InstanceSettings>(deserializer) {
        Ok(settings) => Ok(settings),
        Err(error) => {
            let path = error.path().to_string();
            let inner = error.inner().to_string();
            let (param, message) = if let Some(field) = inner
                .strip_prefix("missing field `")
                .and_then(|rest| rest.split('`').next())
            {
                let param = if path.is_empty() || path == "." {
                    field.to_string()
                } else {
                    format!("{path}.{field}")
                };
                (param.clone(), format!("{param} is missing"))
            } else {
                let param = if path.is_empty() || path == "." {
                    "body".to_string()
                } else {
                    path
                };
                (param.clone(), format!("{param}: {inner}"))
            };
            Err(
                OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message)
                    .with_meta(serde_json::json!({ "param_name": param })),
            )
        }
    }
}
