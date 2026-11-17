//! Helpers shared by the Backend API routes, ported from
//! `modules/admin/shared.ts`, `modules/admin/users/shared.ts` and
//! `modules/org-backend/shared.ts`.
//!
//! Split into query building, metadata validation, SQL binding, request context
//! and JSON deserialisers; the public surface is re-exported unchanged.

mod db;
mod deserialize;
mod metadata;
mod query;
mod request;

pub use db::*;
pub use deserialize::*;
pub use metadata::*;
pub use query::*;
pub use request::*;
