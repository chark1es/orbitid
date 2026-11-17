//! L1 federation adapters: social/custom OAuth & OIDC providers and a SAML 2.0
//! service provider.
//!
//! This crate implements the protocol level only. Session/account creation and
//! linking an [`ExternalProfile`] to a local user belong to `orbitid-identity`
//! and the Frontend API crates; they call the functions here.
//!
//! - [`config`] — provider configuration, defaults and the Frontend API listing
//! - [`oauth`] — adapter contract, token set, persisted OAuth state and browser binding
//! - [`adapters`] — built-in social providers (arctic's behaviour) and the generic client
//! - [`custom`] — discovered/manual custom OIDC and OAuth 2.0 providers
//! - [`profiles`] / [`fetch`] — provider profile normalization and userinfo fetching
//! - [`apple`] — Apple's ES256 client secret, ID-token verification and form_post adapter
//! - [`jwt`] — small RS256/ES256/PS256/EdDSA verifier with a JWKS cache
//! - [`preview`] — the dashboard's "Test connection" check
//! - [`saml`] — SAML 2.0 SP: metadata import, AuthnRequest, assertion validation,
//!   replay/InResponseTo stores in Postgres, and enterprise OIDC connections

pub mod adapters;
pub mod apple;
pub mod config;
pub mod custom;
pub mod error;
pub mod fetch;
pub mod http;
pub mod jwt;
pub mod oauth;
pub mod preview;
pub mod profile;
pub mod profiles;
pub mod saml;
#[cfg(any(test, feature = "test-util"))]
pub mod test_support;

pub use config::{
    default_scopes, has_apple_key, is_provider_enabled, list_enabled_social_providers,
    provider_config, provider_display_name, provider_key_from_strategy, provider_logo_url,
    provider_redirect_uri, OAuthProviderConfig, SocialProviderListing,
};
pub use error::{callback_error, callback_invalid, provider_not_enabled, verification_failed};
pub use oauth::{
    bind_browser, browser_matches, browser_mismatch_message, create_oauth_authorization,
    get_oauth_adapter, take_oauth_state, AuthorizationInput, CreatedAuthorization, ExchangeInput,
    OAuthAdapter, OAuthFlow, OAuthTokenSet, StoredOAuthFlow, BROWSER_COOKIE, BROWSER_COOKIE_PATH,
    BROWSER_COOKIE_TTL_SECONDS, OAUTH_STATE_TTL_MS,
};
pub use profile::ExternalProfile;
