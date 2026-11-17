//! Wire (JSON) resource shapes, ported from `packages/shared/src/resources.ts`.
//!
//! These are the bytes the frontend and SDKs consume, so field names are
//! snake_case and timestamps are unix epoch **milliseconds** (`i64`). Required
//! nullable fields serialize as `null`; TypeScript-optional fields
//! (`field?: T | null`) are skipped when absent, exactly like `JSON.stringify`.
//!
//! Split by domain; the public surface is re-exported unchanged.

mod api;
mod attempts;
mod common;
mod organization;
mod session;
mod user;

pub use api::*;
pub use attempts::*;
pub use common::*;
pub use organization::*;
pub use session::*;
pub use user::*;
