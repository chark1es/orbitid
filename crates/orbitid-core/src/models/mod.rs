//! Row models: one `#[derive(FromRow)]` struct per database table, mirroring
//! the retired TypeScript server.
//!
//! - `bigint` columns are `i64`. Timestamps are unix epoch **milliseconds**.
//! - `jsonb` columns are `sqlx::types::Json<T>`; use the aliases below.
//! - `boolean` is `bool`, `text` is `String`, nullable columns are `Option<T>`.
//!
//! These are database rows, not wire resources: use `resources` for JSON shapes.

pub mod api;
pub mod devices;
pub mod identity;
pub mod organizations;
pub mod sessions;
pub mod tokens;
pub mod webhooks;

pub use api::*;
pub use devices::*;
pub use identity::*;
pub use organizations::*;
pub use sessions::*;
pub use tokens::*;
pub use webhooks::*;

/// `jsonb` holding an arbitrary document.
pub type Jsonb = sqlx::types::Json<serde_json::Value>;
/// `jsonb` holding a metadata object (`Record<string, unknown>`).
pub type JsonMetadata = sqlx::types::Json<serde_json::Map<String, serde_json::Value>>;
/// `jsonb` holding a string array.
pub type JsonList = sqlx::types::Json<Vec<String>>;
