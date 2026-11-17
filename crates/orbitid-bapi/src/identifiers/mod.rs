//! Backend API identifiers: email addresses, phone numbers, allowlist and
//! blocklist. Every write to a user's identifiers is refused.
//!
//! Split into email/phone reads and the allow/block lists.

mod emails;
mod lists;
mod router;

pub use router::*;
