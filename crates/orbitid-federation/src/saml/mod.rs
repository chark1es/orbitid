//! SAML 2.0 service provider and enterprise OIDC connections.
//!
//! - [`config`] — connection config parsing, URLs, certificates, domains, enterprise OIDC
//! - [`metadata`] — IdP metadata import (pasted XML or SSRF-guarded URL)
//! - [`sp`] — AuthnRequest generation (HTTP-Redirect) and SP metadata
//! - [`store`] — Postgres-backed AuthnRequest / replay cache
//! - [`response`] — XML-DSig validation with wrapping, audience, time, recipient,
//!   InResponseTo and replay checks
//! - [`xml`] — structural XML scanning used by the validator

pub mod checks;
pub mod config;
pub mod enterprise;
pub mod metadata;
pub mod profile;
pub mod response;
pub mod sp;
pub mod store;
pub mod xml;

pub use config::{
    acs_url_for, assert_valid_certificate, assert_valid_domains, connection_matches_domain,
    merge_metadata, metadata_url_for, normalize_domains, saml_config, sp_entity_id_for,
    AttributeMapping, SamlConfig,
};
pub use enterprise::{
    decrypt_client_secret, encrypt_client_secret, enterprise_oidc_authorize_url,
    enterprise_oidc_profile, exchange_enterprise_oidc_code, fetch_enterprise_user_info,
    get_oidc_discovery, oidc_config, verify_enterprise_id_token, EnterpriseAuthorizeParams,
    EnterpriseDiscovery, EnterpriseTokenResponse, OidcConfig,
};
pub use metadata::{fetch_idp_metadata, parse_idp_metadata, resolve_saml_metadata, IdpMetadata};
pub use profile::{profile_to_external_profile, SamlProfile};
pub use response::validate_saml_response;
pub use sp::{
    authn_request_xml, encode_redirect_request, saml_authorize_url, service_provider_metadata,
    validate_in_response_to, GeneratedAuthnRequest, ValidateInResponseTo,
};
pub use store::SamlCache;
