//! The settings store, ported from the retired TypeScript server.
//!
//! A process keeps a cheap synchronous [`SettingsStore::get`] backed by
//! `arc-swap`. Unlike the TypeScript server's per-process cache, writes are
//! broadcast to every replica through Postgres `LISTEN/NOTIFY`, with a periodic
//! refresh as the fallback if a notification is missed.
//!
//! Split into migration, the live store, its publication path and the
//! `LISTEN/NOTIFY` listener.

mod core;
mod listener;
mod migration;
mod publish;

pub use core::*;
pub use migration::*;
