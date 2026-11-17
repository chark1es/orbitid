//! The `orbitid` binary's composition root: build state, compose routers and
//! middleware exactly like the retired TypeScript server, and serve it.

pub mod app;
pub mod cli;
pub mod dashboard;
pub mod docs;
pub mod guard;
pub mod import_uploads;
pub mod retry;
pub mod transfer;

#[cfg(test)]
mod startup_tests;

pub use app::{build_app, build_app_without_retry};
