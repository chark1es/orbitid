//! Enterprise connection CRUD (`/v1/enterprise_connections`), ported from
//! `modules/enterprise.ts` (backend routes) and `machine/enterprise-config.ts`.
//!
//! Split into wire serialization, reads and writes; the router is re-exported
//! unchanged.

mod domains;
mod read;
mod router;
mod serialization;
mod write;

pub use router::*;
