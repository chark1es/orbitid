//! OpenID Provider metadata (`/.well-known/openid-configuration` and RFC 8414
//! authorization-server metadata), ported from `services/oidc/discovery.ts`.
//!
//! The issuer is always the public origin, never the request's internal origin.

use serde_json::{json, Map, Value};

use orbitid_core::settings::types::AccessTokenFormat;
use orbitid_core::state::AppState;

use super::shared::{BASE_OIDC_SCOPES, DEVICE_CODE_GRANT_TYPE};

/// Claims the provider can emit from the scopes it supports.
const CLAIMS_SUPPORTED: [&str; 27] = [
    "sub",
    "iss",
    "aud",
    "exp",
    "iat",
    "auth_time",
    "nonce",
    "at_hash",
    "azp",
    "sid",
    "name",
    "given_name",
    "family_name",
    "preferred_username",
    "picture",
    "locale",
    "updated_at",
    "email",
    "email_verified",
    "phone_number",
    "phone_number_verified",
    "groups",
    "org_id",
    "org_slug",
    "org_role",
    "org_permissions",
    "organizations",
];

pub fn discovery_document(state: &AppState, issuer: &str) -> Value {
    let base = issuer.trim_end_matches('/').to_string();
    let settings = state.settings.get();
    let provider = &settings.oidc_provider;
    let mut doc = Map::new();
    doc.insert("issuer".into(), json!(base));
    doc.insert(
        "authorization_endpoint".into(),
        json!(format!("{base}/oauth/authorize")),
    );
    doc.insert(
        "token_endpoint".into(),
        json!(format!("{base}/oauth/token")),
    );
    doc.insert(
        "userinfo_endpoint".into(),
        json!(format!("{base}/oauth/userinfo")),
    );
    doc.insert("jwks_uri".into(), json!(format!("{base}/oauth/jwks")));
    doc.insert(
        "revocation_endpoint".into(),
        json!(format!("{base}/oauth/revoke")),
    );
    doc.insert(
        "introspection_endpoint".into(),
        json!(format!("{base}/oauth/introspect")),
    );
    doc.insert(
        "end_session_endpoint".into(),
        json!(format!("{base}/oauth/end_session")),
    );
    doc.insert("response_types_supported".into(), json!(["code"]));
    doc.insert(
        "response_modes_supported".into(),
        json!(["query", "form_post"]),
    );
    doc.insert(
        "grant_types_supported".into(),
        if provider.device_authorization_enabled {
            json!([
                "authorization_code",
                "refresh_token",
                DEVICE_CODE_GRANT_TYPE
            ])
        } else {
            json!(["authorization_code", "refresh_token"])
        },
    );
    doc.insert("subject_types_supported".into(), json!(["public"]));
    doc.insert(
        "id_token_signing_alg_values_supported".into(),
        json!(["RS256"]),
    );
    doc.insert("scopes_supported".into(), json!(BASE_OIDC_SCOPES));
    doc.insert("claims_supported".into(), json!(CLAIMS_SUPPORTED));
    doc.insert(
        "token_endpoint_auth_methods_supported".into(),
        json!(["client_secret_basic", "client_secret_post", "none"]),
    );
    doc.insert(
        "revocation_endpoint_auth_methods_supported".into(),
        json!(["client_secret_basic", "client_secret_post", "none"]),
    );
    doc.insert(
        "introspection_endpoint_auth_methods_supported".into(),
        json!(["client_secret_basic", "client_secret_post"]),
    );
    doc.insert("code_challenge_methods_supported".into(), json!(["S256"]));
    doc.insert(
        "prompt_values_supported".into(),
        json!(["none", "login", "consent", "select_account"]),
    );
    doc.insert("request_parameter_supported".into(), json!(false));
    doc.insert("request_uri_parameter_supported".into(), json!(false));
    doc.insert("claims_parameter_supported".into(), json!(false));
    doc.insert(
        "service_documentation".into(),
        json!(format!("{base}/docs")),
    );
    if provider.access_token_format == AccessTokenFormat::Jwt {
        doc.insert("access_token_format".into(), json!("jwt"));
        doc.insert(
            "access_token_signing_alg_values_supported".into(),
            json!(["RS256"]),
        );
        doc.insert(
            "access_token_claims_supported".into(),
            json!([
                "iss",
                "sub",
                "aud",
                "azp",
                "scope",
                "iat",
                "exp",
                "jti",
                "sid",
                "groups",
                "org_id",
                "org_slug",
                "org_role",
                "org_permissions"
            ]),
        );
    }
    if provider.device_authorization_enabled {
        doc.insert(
            "device_authorization_endpoint".into(),
            json!(format!("{base}/oauth/device_authorization")),
        );
    }
    Value::Object(doc)
}
