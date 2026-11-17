//! Instance settings schema, ported from `packages/shared/src/config.ts`.
//!
//! Settings are stored as camelCase JSON (that is the dashboard's contract) and
//! are intentionally *not* the same shape as API resources. Every default and
//! nullable/optional distinction below mirrors the zod schema.
//!
//! Split by settings area; the public surface is re-exported unchanged.

mod attributes;
mod common;
mod features;
mod general;
mod instance;
mod security;

pub use attributes::*;
pub use common::*;
pub use features::*;
pub use general::*;
pub use instance::*;
pub use security::*;
