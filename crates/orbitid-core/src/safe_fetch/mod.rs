//! SSRF-safe outbound HTTP, ported from the retired TypeScript server.
//!
//! The danger is server-side request forgery: a user- or operator-controlled
//! URL points at loopback, a private network or the cloud metadata service. We
//! resolve the hostname ourselves, judge every address, connect to the judged
//! address (so a second DNS answer cannot redirect us), follow redirects by
//! hand re-validating each hop, and bound time and size.
//!
//! Split into address policy and the request/redirect transport.

mod policy;
mod request;

pub use policy::*;
pub use request::*;
