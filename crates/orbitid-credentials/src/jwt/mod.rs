//! JWS/JWT primitives used by the credential services.
//!
//! The TypeScript server uses `jose`; this module reproduces the parts the
//! server and its tests rely on: HS256, RS256, ES256 signing/verification,
//! JWK import/export, a local JWK set and a remote JWKS fetcher with a TTL
//! cache. Extra RSA/EdDSA verification algorithms are accepted so keys served
//! by third-party OIDC providers keep working.

mod algorithm;
mod hmac;
mod jwk;
mod jwk_parse;
mod jwks;
mod jws;
mod remote;
mod rsa;

pub use algorithm::JwsAlgorithm;
pub use jwk::{Jwk, JwkError};
pub use jwks::JwkSet;
pub use jws::{decode_jwt_payload, sign_jws, verify_jws, JwsHeader, VerifyOptions};
pub use remote::{fetch_remote_jwks, invalidate_remote_jwks, RemoteJwksOptions, DEFAULT_TTL_MS};
