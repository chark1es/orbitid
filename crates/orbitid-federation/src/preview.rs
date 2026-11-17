//! The dashboard "Test connection" preview for custom providers.
//!
//! Ported from `previewProvider()` in `oauth-providers/custom.ts`. Errors are
//! returned, never thrown, so the dashboard can show all of them at once.

use orbitid_core::safe_fetch::{assert_public_url, safe_fetch, SafeFetchOptions};
use orbitid_core::settings::types::SocialProtocol;
use orbitid_core::AppState;
use serde::{Deserialize, Serialize};

use crate::custom::{load_discovery, OidcDiscovery};
use crate::http::headers;

/// Inputs from the dashboard's test-connection form.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct ProviderPreviewInput {
    pub protocol: Option<SocialProtocol>,
    pub discovery_url: Option<String>,
    pub issuer: Option<String>,
    pub authorization_url: Option<String>,
    pub token_url: Option<String>,
    pub userinfo_url: Option<String>,
    pub jwks_url: Option<String>,
}

/// The outcome of probing one endpoint.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct EndpointCheck {
    pub name: String,
    pub url: String,
    pub reachable: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub status: Option<u16>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

/// Endpoints as the dashboard displays them (empty when unresolved).
#[derive(Debug, Clone, Serialize, PartialEq, Eq, Default)]
pub struct PreviewEndpoints {
    pub authorization: String,
    pub token: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub userinfo: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jwks: Option<String>,
}

/// The dashboard-facing result of a test-connection request.
#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct ProviderPreview {
    pub ok: bool,
    pub protocol: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub issuer: Option<String>,
    pub endpoints: PreviewEndpoints,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scopes_supported: Option<Vec<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pkce_supported: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub client_auth_methods: Option<Vec<String>>,
    pub checks: Vec<EndpointCheck>,
    pub warnings: Vec<String>,
    pub errors: Vec<String>,
}

/// A bounded GET: any HTTP answer proves the endpoint exists; only a transport
/// failure is an error.
async fn probe(state: &AppState, name: &str, url: &str) -> EndpointCheck {
    let result = safe_fetch(
        Some(state),
        url,
        SafeFetchOptions {
            timeout_ms: Some(5_000),
            max_bytes: Some(256 * 1024),
            headers: headers(&[(
                "accept",
                "application/json, application/xml;q=0.9, */*;q=0.8",
            )]),
            ..SafeFetchOptions::default()
        },
    )
    .await;
    match result {
        Ok(response) => EndpointCheck {
            name: name.to_string(),
            url: url.to_string(),
            reachable: true,
            status: Some(response.status),
            error: None,
        },
        Err(error) => EndpointCheck {
            name: name.to_string(),
            url: url.to_string(),
            reachable: false,
            status: None,
            error: Some(error.message),
        },
    }
}

fn protocol_name(protocol: Option<SocialProtocol>) -> String {
    match protocol {
        Some(SocialProtocol::Oauth2) => "oauth2".to_string(),
        _ => "oidc".to_string(),
    }
}

/// Resolves and probes a custom provider's URLs without saving anything.
pub async fn preview_provider(state: &AppState, input: &ProviderPreviewInput) -> ProviderPreview {
    let protocol = protocol_name(input.protocol);
    let mut errors = Vec::new();
    let mut warnings = Vec::new();
    let mut endpoints: Option<OidcDiscovery> = None;

    if let Some(url) = input
        .discovery_url
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
    {
        match load_discovery(state, url).await {
            Ok(discovery) => endpoints = Some(discovery),
            Err(error) => errors.push(error.message),
        }
    } else {
        let authorization = input
            .authorization_url
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty());
        let token = input
            .token_url
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty());
        match (authorization, token) {
            (Some(authorization), Some(token)) => {
                let checks = [
                    assert_public_url(Some(state), authorization, "authorizationUrl").await,
                    assert_public_url(Some(state), token, "tokenUrl").await,
                ];
                match checks.into_iter().find_map(Result::err) {
                    Some(error) => errors.push(error.message),
                    None => {
                        endpoints = Some(OidcDiscovery {
                            issuer: input
                                .issuer
                                .as_deref()
                                .map(str::trim)
                                .filter(|v| !v.is_empty())
                                .map(str::to_string),
                            authorization_endpoint: authorization.to_string(),
                            token_endpoint: token.to_string(),
                            userinfo_endpoint: input
                                .userinfo_url
                                .as_deref()
                                .map(str::trim)
                                .filter(|v| !v.is_empty())
                                .map(str::to_string),
                            jwks_uri: input
                                .jwks_url
                                .as_deref()
                                .map(str::trim)
                                .filter(|v| !v.is_empty())
                                .map(str::to_string),
                            scopes_supported: None,
                            code_challenge_methods_supported: None,
                            token_endpoint_auth_methods_supported: None,
                        });
                    }
                }
            }
            _ => errors.push(
                "Add a discovery URL, or the manual authorization and token endpoints.".to_string(),
            ),
        }
    }

    let mut checks = Vec::new();
    if let Some(endpoints) = &endpoints {
        let candidates: [(&str, Option<&str>); 4] = [
            (
                "Authorization endpoint",
                Some(endpoints.authorization_endpoint.as_str()),
            ),
            ("Token endpoint", Some(endpoints.token_endpoint.as_str())),
            ("Userinfo endpoint", endpoints.userinfo_endpoint.as_deref()),
            ("JWKS", endpoints.jwks_uri.as_deref()),
        ];
        for (name, url) in candidates {
            let Some(url) = url.filter(|value| !value.is_empty()) else {
                if name == "Authorization endpoint" || name == "Token endpoint" {
                    errors.push(format!("{name} is missing."));
                }
                continue;
            };
            checks.push(probe(state, name, url).await);
        }
        if endpoints.jwks_uri.is_none() {
            if protocol == "oidc" {
                warnings.push("No JWKS: an ID token cannot be verified, so the profile is read from userinfo.".to_string());
            }
            if endpoints.userinfo_endpoint.is_none() {
                errors
                    .push("An OIDC provider without a JWKS needs a userinfo endpoint.".to_string());
            }
        }
        if endpoints.userinfo_endpoint.is_none() && endpoints.jwks_uri.is_none() {
            warnings.push(
                "The provider has no userinfo endpoint; only ID-token claims can identify a user."
                    .to_string(),
            );
        }
        if let Some(scopes) = &endpoints.scopes_supported {
            if protocol == "oidc" && !scopes.iter().any(|scope| scope == "openid") {
                warnings.push("The discovery document does not advertise the `openid` scope; check that this is an OpenID Connect provider.".to_string());
            }
        }
        if let Some(methods) = &endpoints.code_challenge_methods_supported {
            if !methods.iter().any(|method| method == "S256") {
                warnings.push("The provider does not advertise PKCE S256; turn PKCE off only if it rejects the request.".to_string());
            }
        }
        if let Some(methods) = &endpoints.token_endpoint_auth_methods_supported {
            if !methods.is_empty() {
                warnings.push(format!(
                    "Token endpoint authentication methods: {}.",
                    methods.join(", ")
                ));
            }
        }
        if protocol == "oidc" && endpoints.issuer.is_none() {
            warnings.push("No issuer: ID-token issuer checks are skipped, so the profile is read from userinfo.".to_string());
        }
    }

    let failed = checks
        .iter()
        .filter(|check| !check.reachable)
        .map(|check| {
            format!(
                "{} is unreachable: {}",
                check.name,
                check.error.clone().unwrap_or_default()
            )
        })
        .collect::<Vec<_>>();
    let ok = errors.is_empty() && failed.is_empty();
    warnings.extend(failed);
    ProviderPreview {
        ok,
        protocol,
        issuer: endpoints.as_ref().and_then(|value| value.issuer.clone()),
        endpoints: PreviewEndpoints {
            authorization: endpoints
                .as_ref()
                .map(|value| value.authorization_endpoint.clone())
                .unwrap_or_default(),
            token: endpoints
                .as_ref()
                .map(|value| value.token_endpoint.clone())
                .unwrap_or_default(),
            userinfo: endpoints
                .as_ref()
                .and_then(|value| value.userinfo_endpoint.clone()),
            jwks: endpoints.as_ref().and_then(|value| value.jwks_uri.clone()),
        },
        scopes_supported: endpoints
            .as_ref()
            .and_then(|value| value.scopes_supported.clone()),
        pkce_supported: endpoints.as_ref().and_then(|value| {
            value
                .code_challenge_methods_supported
                .as_ref()
                .map(|methods| methods.iter().any(|method| method == "S256"))
        }),
        client_auth_methods: endpoints
            .as_ref()
            .and_then(|value| value.token_endpoint_auth_methods_supported.clone()),
        checks,
        warnings,
        errors,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protocol_names_default_to_oidc() {
        assert_eq!(protocol_name(None), "oidc");
        assert_eq!(protocol_name(Some(SocialProtocol::Oidc)), "oidc");
        assert_eq!(protocol_name(Some(SocialProtocol::Oauth2)), "oauth2");
    }
}
