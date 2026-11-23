//! Environment loading, ported from the retired TypeScript server.
//!
//! The Rust server is Postgres-only. Everything else (names, defaults and
//! validation messages) is kept identical so an existing deployment's
//! `.env` keeps working. The only intentional removals are the SQLite,
//! PGlite and `:memory:` branches; a non-Postgres URL is refused up front.

mod database;
mod redact;

pub use database::{resolve_database, DatabaseConfig};
use std::path::{Component, Path, PathBuf};

/// Startup configuration. Cheap to clone and stored behind `Arc` in `AppState`.
#[derive(Clone)]
pub struct Env {
    pub port: u16,
    /// Public URL of this server (Frontend API / issuer), e.g. `http://localhost:4000`.
    pub base_url: String,
    /// True when `base_url` came from `ORBITID_BASE_URL` or an explicit override.
    pub base_url_explicit: bool,
    /// Number of trusted reverse proxies (`ORBITID_TRUST_PROXY`).
    pub trust_proxy: usize,
    /// Postgres connection (URL or separate parts), see [`database`].
    pub database: DatabaseConfig,
    /// Secret for AES-GCM at-rest encryption of private keys / OAuth tokens.
    pub encryption_key: String,
    /// True when the operator set the encryption key (required in production).
    pub encryption_key_provided: bool,
    /// Backend API secret (`sk_test_...`). When empty it is derived at boot.
    pub secret_key: String,
    pub data_dir: PathBuf,
    /// Built dashboard (`apps/dashboard/dist`), served at `/` when present.
    pub dashboard_dir: PathBuf,
    pub node_env: String,
    pub resend_api_key: String,
    pub smtp_url: String,
    pub email_from: String,
    /// `ORBITID_DB_MAX_CONNECTIONS`, default 20.
    pub db_max_connections: u32,
    /// `ORBITID_DB_ACQUIRE_TIMEOUT_MS`, default 30_000.
    pub db_acquire_timeout_ms: u64,
    /// `ORBITID_REQUEST_TIMEOUT_MS`, default 30_000. 0 disables the timeout.
    pub request_timeout_ms: u64,
    /// `ORBITID_DRAIN_TIMEOUT_MS`, default 10_000. In-flight requests get this
    /// long to finish after SIGTERM before the process exits.
    pub drain_timeout_ms: u64,
    /// `ORBITID_ALLOW_PRIVATE_NETWORKS=true`: permit SSRF-guarded calls to private hosts.
    pub allow_private_networks: bool,
    /// `ORBITID_WEBHOOK_RETENTION_DAYS`, default 30. Terminal deliveries and
    /// their events older than this are swept.
    pub webhook_retention_days: u64,
    /// `ORBITID_AUDIT_RETENTION_DAYS`, default 0 (keep forever). A positive
    /// value sweeps audit rows older than that many days.
    pub audit_retention_days: u64,
    /// `ORBITID_RETENTION_BATCH_SIZE`, default 500. Rows deleted per table per
    /// batch inside one retention tick.
    pub retention_batch_size: i64,
    /// `ORBITID_RETENTION_INTERVAL_MS`, default 3 600 000 (one hour).
    pub retention_interval_ms: u64,
    /// `ORBITID_RETENTION_BUDGET_MS`, default 30 000. Maximum time one
    /// retention tick spends draining batches; the next tick continues.
    pub retention_budget_ms: u64,
    /// `ORBITID_ENROLLMENT_INTERVAL_MS`, default 60 000. Interval of the
    /// domain-enrollment reconciliation worker (it is also woken immediately
    /// when a domain change commits); each tick uses the retention budget.
    pub enrollment_interval_ms: u64,
    /// `ORBITID_UPDATE_CHECK`, default true. Asks GitHub every few hours whether
    /// a newer OrbitID release exists; `false` turns the request off.
    pub update_check: bool,
}

/// Explicit overrides, mirroring the `Partial<Env>` argument of `loadEnv`.
#[derive(Clone, Default)]
pub struct EnvOverrides {
    pub port: Option<u16>,
    pub base_url: Option<String>,
    pub trust_proxy: Option<usize>,
    pub database_url: Option<String>,
    pub encryption_key: Option<String>,
    pub secret_key: Option<String>,
    pub data_dir: Option<PathBuf>,
    pub dashboard_dir: Option<PathBuf>,
    pub node_env: Option<String>,
    pub resend_api_key: Option<String>,
    pub smtp_url: Option<String>,
    pub email_from: Option<String>,
    pub db_max_connections: Option<u32>,
    pub db_acquire_timeout_ms: Option<u64>,
    pub request_timeout_ms: Option<u64>,
    pub drain_timeout_ms: Option<u64>,
    pub allow_private_networks: Option<bool>,
    pub webhook_retention_days: Option<u64>,
    pub audit_retention_days: Option<u64>,
    pub retention_batch_size: Option<i64>,
    pub retention_interval_ms: Option<u64>,
    pub retention_budget_ms: Option<u64>,
    pub enrollment_interval_ms: Option<u64>,
    pub update_check: Option<bool>,
}

#[derive(Debug, Clone, thiserror::Error)]
#[error("{0}")]
pub struct ConfigError(pub String);

impl ConfigError {
    fn new(message: impl Into<String>) -> Self {
        Self(message.into())
    }
}

fn env_var(name: &str) -> Option<String> {
    std::env::var(name).ok()
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty())
}

/// `ORBITID_UPDATE_CHECK`: unset means on. Anything other than a clear yes or
/// no is refused, so a typo can never leave the check on by accident.
pub fn parse_update_check(raw: Option<&str>) -> Result<bool, ConfigError> {
    let Some(raw) = raw.map(str::trim).filter(|raw| !raw.is_empty()) else {
        return Ok(true);
    };
    match raw.to_ascii_lowercase().as_str() {
        "true" | "1" | "yes" | "on" => Ok(true),
        "false" | "0" | "no" | "off" => Ok(false),
        _ => Err(ConfigError::new(
            "ORBITID_UPDATE_CHECK must be true or false.",
        )),
    }
}

/// `path.resolve`-like: absolute paths pass through, relative ones are joined
/// to the current directory and `.`/`..` components are normalised lexically.
fn resolve_path(path: &Path) -> PathBuf {
    let joined = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()
            .unwrap_or_else(|_| PathBuf::from("."))
            .join(path)
    };
    let mut out = PathBuf::new();
    for component in joined.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn default_dashboard_dir() -> PathBuf {
    // `env!("CARGO_MANIFEST_DIR")` is `<repo>/crates/orbitid-core`.
    resolve_path(&Path::new(env!("CARGO_MANIFEST_DIR")).join("../../apps/dashboard/dist"))
}

/// True when `base_url` points at localhost/127.0.0.1/[::1] (either scheme).
pub fn is_local_base_url(base_url: &str) -> bool {
    let rest = match base_url
        .strip_prefix("http://")
        .or_else(|| base_url.strip_prefix("https://"))
    {
        Some(rest) => rest,
        None => return false,
    };
    let host_port = rest.split('/').next().unwrap_or("");
    let host = if host_port.starts_with('[') {
        host_port
            .split(']')
            .next()
            .map(|h| format!("{h}]"))
            .unwrap_or_default()
    } else {
        host_port.split(':').next().unwrap_or("").to_string()
    };
    matches!(host.as_str(), "localhost" | "127.0.0.1" | "[::1]")
}

/// The TypeScript server could keep its data in a SQLite/PGlite file. This one
/// is Postgres-only, so a leftover `ORBITID_DATABASE_PATH` is refused loudly
/// instead of being silently ignored.
fn refuse_database_path(path: Option<String>) -> Result<(), ConfigError> {
    if let Some(path) = path.filter(|value| !value.is_empty()) {
        return Err(ConfigError::new(format!(
            "ORBITID_DATABASE_PATH is not supported: this server is Postgres-only. Remove it and set ORBITID_DATABASE_URL=postgres://user:pass@host:5432/orbitid (the configured path was {path})."
        )));
    }
    Ok(())
}

/// Loads and validates configuration. Every error message matches the
/// TypeScript server unless Postgres-only wording is needed.
pub fn load_env(overrides: EnvOverrides) -> Result<Env, ConfigError> {
    refuse_database_path(env_var("ORBITID_DATABASE_PATH"))?;

    let data_dir = resolve_path(
        &overrides
            .data_dir
            .clone()
            .or_else(|| env_var("ORBITID_DATA_DIR").map(PathBuf::from))
            .unwrap_or_else(|| PathBuf::from("./data")),
    );

    let port = match overrides.port {
        Some(port) => port,
        None => {
            let raw = env_var("PORT")
                .or_else(|| env_var("ORBITID_PORT"))
                .unwrap_or_else(|| "4000".to_string());
            raw.parse::<u16>()
                .map_err(|_| ConfigError::new("PORT must be an integer between 0 and 65535."))?
        }
    };

    let node_env = overrides
        .node_env
        .clone()
        .or_else(|| env_var("NODE_ENV"))
        .unwrap_or_else(|| "development".to_string());

    let encryption_key = non_empty(overrides.encryption_key.clone())
        .or_else(|| non_empty(env_var("ORBITID_ENCRYPTION_KEY")));
    let encryption_key_provided = encryption_key.is_some();
    if node_env == "production" && encryption_key.is_none() {
        return Err(ConfigError::new(
            "ORBITID_ENCRYPTION_KEY is required in production. Use a random string of at least 32 characters, for example `openssl rand -base64 32`.",
        ));
    }
    if let Some(key) = &encryption_key {
        if key.chars().count() < 32 {
            return Err(ConfigError::new(
                "ORBITID_ENCRYPTION_KEY must be at least 32 characters long, for example `openssl rand -base64 32`.",
            ));
        }
    }

    let database = resolve_database(overrides.database_url.clone(), &env_var)?;

    let base_url_explicit = overrides.base_url.is_some() || env_var("ORBITID_BASE_URL").is_some();
    let base_url = overrides
        .base_url
        .clone()
        .or_else(|| env_var("ORBITID_BASE_URL"))
        .unwrap_or_else(|| format!("http://localhost:{port}"));
    let base_url = base_url.strip_suffix('/').unwrap_or(&base_url).to_string();

    let trust_proxy = match overrides.trust_proxy {
        Some(value) => value,
        None => match env_var("ORBITID_TRUST_PROXY") {
            None => 0,
            Some(value) if value == "true" => 1,
            Some(value) => value.parse::<usize>().map_err(|_| {
                ConfigError::new("ORBITID_TRUST_PROXY must be a non-negative integer (or true).")
            })?,
        },
    };

    // The server is Postgres-only, so the key is always required.
    if encryption_key.is_none() {
        return Err(ConfigError::new(
            "ORBITID_ENCRYPTION_KEY is required with Postgres or a public ORBITID_BASE_URL. Without it the built-in development key would protect stored secrets. Use `openssl rand -base64 32`.",
        ));
    }

    let secret_key = overrides
        .secret_key
        .clone()
        .or_else(|| env_var("ORBITID_SECRET_KEY"))
        .unwrap_or_default();
    if node_env == "production" && !secret_key.is_empty() && secret_key.chars().count() < 32 {
        return Err(ConfigError::new(
            "ORBITID_SECRET_KEY must be at least 32 random characters in production. Omit it to derive a strong key from ORBITID_ENCRYPTION_KEY.",
        ));
    }

    let dashboard_dir = resolve_path(
        &overrides
            .dashboard_dir
            .clone()
            .or_else(|| env_var("ORBITID_DASHBOARD_DIR").map(PathBuf::from))
            .unwrap_or_else(default_dashboard_dir),
    );

    let db_max_connections = match overrides.db_max_connections {
        Some(value) => value,
        None => env_var("ORBITID_DB_MAX_CONNECTIONS")
            .map(|raw| {
                raw.parse::<u32>().map_err(|_| {
                    ConfigError::new("ORBITID_DB_MAX_CONNECTIONS must be a positive integer.")
                })
            })
            .transpose()?
            .unwrap_or(20),
    };
    if db_max_connections == 0 {
        return Err(ConfigError::new(
            "ORBITID_DB_MAX_CONNECTIONS must be a positive integer.",
        ));
    }
    let db_acquire_timeout_ms = match overrides.db_acquire_timeout_ms {
        Some(value) => value,
        None => env_var("ORBITID_DB_ACQUIRE_TIMEOUT_MS")
            .map(|raw| {
                raw.parse::<u64>().map_err(|_| {
                    ConfigError::new(
                        "ORBITID_DB_ACQUIRE_TIMEOUT_MS must be a non-negative integer.",
                    )
                })
            })
            .transpose()?
            .unwrap_or(30_000),
    };

    let allow_private_networks = overrides
        .allow_private_networks
        .or_else(|| env_var("ORBITID_ALLOW_PRIVATE_NETWORKS").map(|v| v == "true"))
        .unwrap_or(false);

    let webhook_retention_days = match overrides.webhook_retention_days {
        Some(value) => value,
        None => env_var("ORBITID_WEBHOOK_RETENTION_DAYS")
            .map(|raw| {
                raw.parse::<u64>().map_err(|_| {
                    ConfigError::new(
                        "ORBITID_WEBHOOK_RETENTION_DAYS must be a non-negative integer.",
                    )
                })
            })
            .transpose()?
            .unwrap_or(30),
    };
    let audit_retention_days = match overrides.audit_retention_days {
        Some(value) => value,
        None => env_var("ORBITID_AUDIT_RETENTION_DAYS")
            .map(|raw| {
                raw.parse::<u64>().map_err(|_| {
                    ConfigError::new("ORBITID_AUDIT_RETENTION_DAYS must be a non-negative integer.")
                })
            })
            .transpose()?
            .unwrap_or(0),
    };
    let retention_batch_size = match overrides.retention_batch_size {
        Some(value) => value,
        None => env_var("ORBITID_RETENTION_BATCH_SIZE")
            .map(|raw| {
                raw.parse::<i64>().map_err(|_| {
                    ConfigError::new("ORBITID_RETENTION_BATCH_SIZE must be a positive integer.")
                })
            })
            .transpose()?
            .unwrap_or(500),
    };
    if retention_batch_size < 1 {
        return Err(ConfigError::new(
            "ORBITID_RETENTION_BATCH_SIZE must be a positive integer.",
        ));
    }
    let retention_interval_ms = match overrides.retention_interval_ms {
        Some(value) => value,
        None => env_var("ORBITID_RETENTION_INTERVAL_MS")
            .map(|raw| {
                raw.parse::<u64>().map_err(|_| {
                    ConfigError::new("ORBITID_RETENTION_INTERVAL_MS must be a positive integer.")
                })
            })
            .transpose()?
            .unwrap_or(60 * 60 * 1000),
    };
    if retention_interval_ms == 0 {
        return Err(ConfigError::new(
            "ORBITID_RETENTION_INTERVAL_MS must be a positive integer.",
        ));
    }
    let retention_budget_ms = match overrides.retention_budget_ms {
        Some(value) => value,
        None => env_var("ORBITID_RETENTION_BUDGET_MS")
            .map(|raw| {
                raw.parse::<u64>().map_err(|_| {
                    ConfigError::new("ORBITID_RETENTION_BUDGET_MS must be a non-negative integer.")
                })
            })
            .transpose()?
            .unwrap_or(30_000),
    };
    let enrollment_interval_ms = match overrides.enrollment_interval_ms {
        Some(value) => value,
        None => env_var("ORBITID_ENROLLMENT_INTERVAL_MS")
            .map(|raw| {
                raw.parse::<u64>().map_err(|_| {
                    ConfigError::new("ORBITID_ENROLLMENT_INTERVAL_MS must be a positive integer.")
                })
            })
            .transpose()?
            .unwrap_or(60_000),
    };
    if enrollment_interval_ms == 0 {
        return Err(ConfigError::new(
            "ORBITID_ENROLLMENT_INTERVAL_MS must be a positive integer.",
        ));
    }

    let update_check = match overrides.update_check {
        Some(value) => value,
        None => parse_update_check(env_var("ORBITID_UPDATE_CHECK").as_deref())?,
    };

    let request_timeout_ms = match overrides.request_timeout_ms {
        Some(value) => value,
        None => env_var("ORBITID_REQUEST_TIMEOUT_MS")
            .map(|raw| {
                raw.parse::<u64>().map_err(|_| {
                    ConfigError::new("ORBITID_REQUEST_TIMEOUT_MS must be a non-negative integer.")
                })
            })
            .transpose()?
            .unwrap_or(30_000),
    };
    let drain_timeout_ms = match overrides.drain_timeout_ms {
        Some(value) => value,
        None => env_var("ORBITID_DRAIN_TIMEOUT_MS")
            .map(|raw| {
                raw.parse::<u64>().map_err(|_| {
                    ConfigError::new("ORBITID_DRAIN_TIMEOUT_MS must be a non-negative integer.")
                })
            })
            .transpose()?
            .unwrap_or(10_000),
    };

    Ok(Env {
        port,
        base_url,
        base_url_explicit,
        trust_proxy,
        database,
        encryption_key: encryption_key
            .unwrap_or_else(|| "dev-only-insecure-encryption-key-change-me!!".to_string()),
        encryption_key_provided,
        secret_key,
        data_dir,
        dashboard_dir,
        node_env,
        resend_api_key: overrides
            .resend_api_key
            .or_else(|| env_var("ORBITID_RESEND_API_KEY"))
            .unwrap_or_default(),
        smtp_url: overrides
            .smtp_url
            .or_else(|| env_var("ORBITID_SMTP_URL"))
            .unwrap_or_default(),
        email_from: overrides
            .email_from
            .or_else(|| env_var("ORBITID_EMAIL_FROM"))
            .unwrap_or_default(),
        db_max_connections,
        db_acquire_timeout_ms,
        request_timeout_ms,
        drain_timeout_ms,
        allow_private_networks,
        webhook_retention_days,
        audit_retention_days,
        retention_batch_size,
        retention_interval_ms,
        retention_budget_ms,
        enrollment_interval_ms,
        update_check,
    })
}

#[cfg(test)]
mod tests;
