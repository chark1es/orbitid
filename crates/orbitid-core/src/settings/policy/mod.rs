//! Server-side policy for instance settings, ported from
//! the retired TypeScript server.
//!
//! Two forms are kept apart: the **stored** tree is exactly what the operator
//! saved; the **served** tree (`settings.get()`) is the stored tree with
//! disabled features forced off. Every request reads the served tree.
//!
//! Split by validation, delivery resolution and served-tree policy.

mod delivery;
mod rules;
mod validation;

pub use delivery::*;
pub use rules::*;
pub use validation::*;
