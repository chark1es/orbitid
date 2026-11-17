//! OIDC/OAuth2 provider service, ported from `services/oidc.ts` and the
//! cohesive modules under `services/oidc/`.

pub mod applications;
pub mod claims;
pub mod consent;
pub mod device;
pub mod discovery;
pub mod grants;
pub mod issuer;
pub mod logout;
pub mod refresh;
pub mod revocation;
pub mod shared;
pub mod token_set;
pub mod tokens;

pub use applications::*;
pub use claims::*;
pub use device::*;
pub use discovery::*;
pub use grants::*;
pub use issuer::*;
pub use logout::*;
pub use refresh::*;
pub use revocation::*;
pub use shared::*;
pub use token_set::*;
pub use tokens::*;
