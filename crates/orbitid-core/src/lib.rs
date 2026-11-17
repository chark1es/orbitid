//! Workspace crate map.
//!
//! `orbitid-core` is the bottom layer (L0): configuration, database access, models,
//! errors, ids, crypto, settings, HTTP plumbing, SSRF-safe outbound HTTP and the
//! integration-test harness. Higher layers depend on it, never the other way round.
//! See `crates/README.md` for conventions.

pub mod claims;
pub mod config;
pub mod crypto;
pub mod db;
pub mod error;
pub mod events;
pub mod http;
pub mod ids;
pub mod keys;
pub mod models;
pub mod resources;
pub mod safe_fetch;
pub mod secrets;
pub mod settings;
pub mod state;

#[cfg(feature = "test-util")]
pub mod testing;

pub use config::{load_env, ConfigError, Env, EnvOverrides};
pub use error::{error_codes, ApiErrorBody, ApiErrorItem, OrbitError, Result};
pub use state::AppState;
