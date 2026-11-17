//! Sign-in state machine helpers shared by the Frontend API and the OAuth /
//! enterprise callbacks. Ported from `modules/auth/signin-core.ts`.
//!
//! Split by concern: attempt transitions, factor discovery, the `SignInJSON`
//! projection and the OAuth transfer profile. Public names are re-exported
//! unchanged.

pub mod attempts;
pub mod factors;
pub mod json;
pub mod on_tx;
pub mod transfer;

pub use orbitid_identity::verifications::purposes;

pub use attempts::*;
pub use factors::*;
pub use json::*;
pub use on_tx::*;
pub use transfer::*;
