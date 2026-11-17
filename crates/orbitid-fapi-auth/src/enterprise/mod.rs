//! Enterprise SSO: Frontend API `/v1/client/enterprise/*` (start + OIDC
//! callback) and the SAML service provider at `/v1/saml/:id/*`.
//! Ported from the frontend/SAML halves of `modules/enterprise.ts` and
//! `modules/machine/enterprise-flow.ts`.
//!
//! Split into connection lookup, the shared flow state, OIDC and SAML.

mod common;
mod flow;
mod oidc;
mod saml;

pub use common::*;
pub use oidc::*;
pub use saml::*;
