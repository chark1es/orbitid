//! OAuth application storage and helpers, ported from
//! `services/oidc/applications.ts`.
//!
//! Split into creation/serialization, updates and client authentication; the
//! public surface is re-exported unchanged.

mod auth;
mod serialize;
mod update;

pub use auth::*;
pub use serialize::*;
pub use update::*;
