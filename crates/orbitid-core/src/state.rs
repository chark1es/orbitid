//! Application state and context creation, ported from `context.ts` and
//! `bootstrap.ts`.
//!
//! `AppState` is cheaply cloneable: the pool, environment, settings store and
//! HTTP client are shared `Arc`s. Higher layers attach their services through
//! [`Extensions`], so core never needs to know them.

use std::any::{Any, TypeId};
use std::collections::HashMap;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use serde_json::Value;
use sqlx::PgPool;

use crate::config::{load_env, Env, EnvOverrides};
use crate::crypto::{hmac_sha256, random_token};
use crate::db;
use crate::error::{OrbitError, Result};
use crate::http::middleware::OperatorSessionChecker;
use crate::keys::encode_publishable_key;
use crate::settings::store::{create_settings_store, SettingsStore, SettingsStoreOptions};
use crate::settings::DeliveryEnvironment;

#[derive(Default)]
struct TypeMap {
    values: RwLock<HashMap<TypeId, Arc<dyn Any + Send + Sync>>>,
}

/// A type-keyed bag of services. Higher crates insert their own service
/// objects (mailer, token signer, …) during composition and read them back in
/// handlers without core depending on them.
#[derive(Clone, Default)]
pub struct Extensions {
    inner: Arc<TypeMap>,
}

impl Extensions {
    pub fn set<T: Any + Send + Sync>(&self, value: T) {
        let mut values = self
            .inner
            .values
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        values.insert(TypeId::of::<T>(), Arc::new(value));
    }

    pub fn get<T: Any + Send + Sync>(&self) -> Option<Arc<T>> {
        let values = self
            .inner
            .values
            .read()
            .unwrap_or_else(|poison| poison.into_inner());
        values.get(&TypeId::of::<T>())?.clone().downcast::<T>().ok()
    }

    /// Returns the existing value of `T` or atomically inserts the one built by
    /// `create` and returns it. Concurrent first uses all observe the same
    /// instance, so per-state services (mailer, captcha) are never duplicated.
    pub fn get_or_insert<T: Any + Send + Sync>(&self, create: impl FnOnce() -> T) -> Arc<T> {
        let mut values = self
            .inner
            .values
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        if let Some(existing) = values.get(&TypeId::of::<T>()) {
            if let Ok(value) = existing.clone().downcast::<T>() {
                return value;
            }
        }
        let created = Arc::new(create());
        values.insert(TypeId::of::<T>(), created.clone());
        created
    }

    pub fn remove<T: Any + Send + Sync>(&self) -> bool {
        let mut values = self
            .inner
            .values
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        values.remove(&TypeId::of::<T>()).is_some()
    }
}

#[derive(Clone)]
pub struct AppState {
    pub pool: PgPool,
    pub env: Arc<Env>,
    pub settings: Arc<SettingsStore>,
    pub publishable_key: String,
    /// Shared client for ordinary outbound calls. SSRF-guarded calls must use
    /// `safe_fetch` instead (it resolves, judges and pins the address).
    pub http_client: reqwest::Client,
    pub extensions: Extensions,
    /// In-process negative cache for rate limits (Postgres is authoritative).
    pub rate_limit_fast_path:
        Arc<RwLock<std::collections::HashMap<String, crate::http::rate_limit::RateLimitBlock>>>,
    operator_sessions: Arc<RwLock<Option<Arc<dyn OperatorSessionChecker>>>>,
}

impl std::fmt::Debug for AppState {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AppState")
            .field("base_url", &self.env.base_url)
            .field("publishable_key", &self.publishable_key)
            .finish_non_exhaustive()
    }
}

impl AppState {
    pub fn set_operator_session_checker(&self, checker: Arc<dyn OperatorSessionChecker>) {
        let mut slot = self
            .operator_sessions
            .write()
            .unwrap_or_else(|poison| poison.into_inner());
        *slot = Some(checker);
    }

    pub fn operator_session_checker(&self) -> Option<Arc<dyn OperatorSessionChecker>> {
        self.operator_sessions
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone()
    }

    pub fn base_url(&self) -> &str {
        &self.env.base_url
    }

    pub fn is_production(&self) -> bool {
        self.env.node_env == "production"
    }
}

fn key_file_secret(contents: &str) -> Result<String> {
    let value: Value = serde_json::from_str(contents).map_err(|_| {
        OrbitError::internal("data/keys.json is not valid JSON; delete it or fix its secretKey")
    })?;
    value
        .get("secretKey")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .ok_or_else(|| OrbitError::internal("data/keys.json has no secretKey"))
}

fn write_key_file(path: &std::path::Path, secret: &str) -> Result<()> {
    use std::io::Write;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(path).map_err(|error| {
        OrbitError::internal(format!("Could not write {}: {error}", path.display()))
    })?;
    let body = serde_json::json!({ "secretKey": secret });
    writeln!(
        file,
        "{}",
        serde_json::to_string_pretty(&body).unwrap_or_default()
    )
    .map_err(|error| {
        OrbitError::internal(format!("Could not write {}: {error}", path.display()))
    })?;
    Ok(())
}

/// Creates the pool, runs migrations, loads settings and resolves the secret key.
/// Does not bind a socket and does not run feature-layer seeding (higher layers
/// do that once the context exists).
pub async fn create_context(overrides: EnvOverrides) -> Result<AppState> {
    let mut env = load_env(overrides).map_err(|error| OrbitError::internal(error.to_string()))?;
    let pool = db::connect(&env).await?;
    db::run_migrations(&pool).await?;

    let mode = if env.node_env == "production" {
        "live"
    } else {
        "test"
    };
    tokio::fs::create_dir_all(&env.data_dir)
        .await
        .map_err(|error| {
            OrbitError::internal(format!("Could not create data directory: {error}"))
        })?;

    let mut secret_key = env.secret_key.clone();
    if secret_key.is_empty() && env.encryption_key_provided {
        let digest = hmac_sha256(env.encryption_key.as_bytes(), b"orbitid/secret-key");
        use base64::Engine;
        secret_key = format!(
            "sk_{mode}_{}",
            base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(digest)
        );
    }
    if secret_key.is_empty() {
        let path = env.data_dir.join("keys.json");
        if path.exists() {
            let contents = tokio::fs::read_to_string(&path).await.map_err(|error| {
                OrbitError::internal(format!("Could not read {}: {error}", path.display()))
            })?;
            secret_key = key_file_secret(&contents)?;
        } else {
            secret_key = format!("sk_{mode}_{}", random_token(24));
            let path = path.clone();
            let secret = secret_key.clone();
            tokio::task::spawn_blocking(move || write_key_file(&path, &secret))
                .await
                .map_err(|error| {
                    OrbitError::internal(format!("Could not write the key file: {error}"))
                })??;
        }
    }
    env.secret_key = secret_key;

    let delivery_env = DeliveryEnvironment {
        resend_api_key: Some(env.resend_api_key.clone()),
        smtp_url: Some(env.smtp_url.clone()),
        email_from: Some(env.email_from.clone()),
    };
    let settings = create_settings_store(
        pool.clone(),
        SettingsStoreOptions {
            connect_options: env.database.connect_options(),
            encryption_key: env.encryption_key.clone(),
            node_env: env.node_env.clone(),
            production: env.node_env == "production",
            env: delivery_env,
            after_session_rewrite: None,
        },
    )
    .await?;

    let publishable_key = encode_publishable_key(&env.base_url, mode);
    let http_client = reqwest::Client::builder()
        .user_agent(concat!("orbitid/", env!("CARGO_PKG_VERSION")))
        .timeout(Duration::from_secs(30))
        .build()
        .map_err(|error| OrbitError::internal(format!("Could not build HTTP client: {error}")))?;

    Ok(AppState {
        pool,
        env: Arc::new(env),
        settings,
        publishable_key,
        http_client,
        extensions: Extensions::default(),
        rate_limit_fast_path: Arc::new(RwLock::new(std::collections::HashMap::new())),
        operator_sessions: Arc::new(RwLock::new(None)),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn key_file_requires_a_secret() {
        assert_eq!(
            key_file_secret(r#"{"secretKey":"sk_test_x"}"#).unwrap(),
            "sk_test_x"
        );
        assert!(key_file_secret("{}").is_err());
        assert!(key_file_secret("not json").is_err());
    }

    #[test]
    fn extensions_are_type_keyed() {
        #[derive(Debug, PartialEq)]
        struct Service(u32);
        let extensions = Extensions::default();
        assert!(extensions.get::<Service>().is_none());
        extensions.set(Service(7));
        assert_eq!(extensions.get::<Service>().unwrap().0, 7);
        assert!(extensions.remove::<Service>());
        assert!(extensions.get::<Service>().is_none());
    }
}
