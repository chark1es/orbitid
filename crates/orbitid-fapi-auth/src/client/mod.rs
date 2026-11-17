//! `/v1/client`: the client resource, its sessions, session tokens and
//! reverification. Ported from `modules/client.ts`.
//!
//! Split into request bodies, session routes and the two reverification
//! factors; the router re-exports the handlers it mounts.

mod bodies;
mod first_factor;
mod second_factor;
mod sessions;

pub use bodies::*;
pub use first_factor::*;
pub use second_factor::*;
pub use sessions::*;
