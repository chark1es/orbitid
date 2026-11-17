//! Role and permission routes (`/v1/roles`, `/v1/permissions`).
//!
//! Split into role CRUD, permission CRUD and the router.

mod permissions;
mod role;
mod router;

pub use router::*;
