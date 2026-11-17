//! Sign-up requirement computation, serialization and completion. Ported from
//! `modules/auth/signup-core.ts`.
//!
//! Split by concern: wire serialization and requirements, version-checked
//! attempt writes, identifier restrictions and the completion transaction.
//! The public surface is re-exported unchanged.

pub mod attempts;
pub mod completion;
pub mod identifiers;
pub mod serialize;

pub use attempts::*;
pub use completion::*;
pub use identifiers::*;
pub use serialize::*;
