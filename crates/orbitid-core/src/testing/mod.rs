//! Integration-test harness (`test-util` feature).
//!
//! Mirrors the retired TypeScript test suite and `core/helpers.ts`:
//! one migrated template database per process, one `CREATE DATABASE … TEMPLATE`
//! per test, an `AppState` with fixed keys, and an in-process `TestClient` that
//! drives an `axum::Router` with `tower::ServiceExt::oneshot` while persisting
//! cookies exactly like the TypeScript client.
//!
//! Split into the disposable database, the test state and the HTTP client.

mod client;
mod db;
mod state;

pub use client::*;
pub use db::*;
pub use state::*;
