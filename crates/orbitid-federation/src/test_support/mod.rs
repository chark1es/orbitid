//! Reusable federation test fixtures, exposed by the `test-util` feature so the
//! Frontend API and identity crates can drive real OIDC and SAML flows.

pub mod keys;
pub mod oidc;
pub mod saml;

pub use keys::{
    ec_jwk_parts, make_ec_key_pair, make_key_pair, public_key_pem, rsa_jwk_parts, TestKeyPair,
};
pub use oidc::{start_oidc_server, OidcServerOptions, OidcTestServer, TokenRequest};
pub use saml::{
    parse_authn_request, response_base64, response_xml, verify_fixture, AssertionOptions,
    CompletedAuthnRequest, ConfirmationSpec, SignScope,
};
