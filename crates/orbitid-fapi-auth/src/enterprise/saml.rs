use axum::body::Body;
use axum::extract::{Path, RawQuery, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::state::AppState;
use orbitid_federation::saml::SamlCache;
use orbitid_federation::saml::{
    profile_to_external_profile, saml_authorize_url, service_provider_metadata,
    validate_saml_response,
};
use orbitid_identity::client_auth::{client_cookie, create_client};
use orbitid_identity::external_identity::ExternalProfile;

use crate::external::handle_external_identity;
use crate::util::{clear_oauth_browser_cookie, client_ip, oauth_browser_cookie, query_map, Reply};

use super::common::*;
use super::flow::*;

/// `GET /v1/saml/:id/metadata`.
pub async fn saml_metadata(State(state): State<AppState>, Path(id): Path<String>) -> Result<Reply> {
    let connection = require_connection(&state, &id).await?;
    if connection.protocol != "saml" {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "SAML connection not found",
        ));
    }
    let metadata = service_provider_metadata(&state.env.base_url, &connection.id);
    Ok(Reply::text(metadata, SAML_METADATA_CONTENT_TYPE))
}

/// `GET /v1/saml/:id/sso`.
pub async fn saml_sso(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw_query): RawQuery,
) -> Result<Reply> {
    let connection = require_connection(&state, &id).await?;
    if connection.protocol != "saml" {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "SAML connection not found",
        ));
    }
    if !connection.active {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Enterprise connection is inactive",
        ));
    }
    let provider = provider_for("saml", &connection.id);
    let query = query_map(raw_query.as_deref());
    let cache = SamlCache::new(state.pool.clone());
    if let Some(value) = query.get("flow") {
        if !peek_enterprise_state(&state, value, &provider).await? {
            return Err(OrbitError::bad_request(
                error_codes::VERIFICATION_FAILED,
                "Enterprise SSO state is invalid or expired",
            ));
        }
        let request = saml_authorize_url(&cache, &state.env.base_url, &connection, value).await?;
        return Ok(Reply::redirect(request.url));
    }
    let (flow, nonce) = flow_from_query(&state, &headers, &query, &connection).await?;
    let value = create_enterprise_state(&state, &provider, &flow, None, None).await?;
    let request = saml_authorize_url(&cache, &state.env.base_url, &connection, &value).await?;
    Ok(Reply::redirect(request.url).cookie(Some(oauth_browser_cookie(&state, &headers, &nonce))))
}

/// `POST /v1/saml/:id/acs`.
pub async fn saml_acs(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    body: Body,
) -> Result<Reply> {
    let connection = require_connection(&state, &id).await?;
    if connection.protocol != "saml" {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "SAML connection not found",
        ));
    }
    if !connection.active {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Enterprise connection is inactive",
        ));
    }
    let bytes = axum::body::to_bytes(body, 1024 * 1024).await.map_err(|_| {
        OrbitError::bad_request(
            error_codes::REQUEST_BODY_INVALID,
            "Request body is not valid",
        )
    })?;
    let mut form = std::collections::HashMap::new();
    for (key, value) in url::form_urlencoded::parse(&bytes) {
        form.insert(key.into_owned(), value.into_owned());
    }
    let saml_response = form.get("SAMLResponse").cloned();
    let relay_state = form.get("RelayState").cloned();
    let cache = SamlCache::new(state.pool.clone());
    let profile = validate_saml_response(
        &cache,
        &state.env.base_url,
        &connection,
        saml_response.as_deref().unwrap_or_default(),
    )
    .await?;
    let mut cookies: Vec<String> = vec![clear_oauth_browser_cookie()];
    let flow = match &relay_state {
        Some(value) => {
            let provider = provider_for("saml", &connection.id);
            let Some(taken) = take_enterprise_state(&state, value, &provider).await? else {
                return Err(OrbitError::bad_request(
                    error_codes::VERIFICATION_FAILED,
                    "Enterprise SSO state is invalid or expired",
                ));
            };
            let presented = orbitid_core::http::cookies::get_cookie(
                &headers,
                orbitid_federation::BROWSER_COOKIE,
            );
            if !orbitid_federation::browser_matches(
                presented,
                taken.flow.browser_hash.as_deref().unwrap_or_default(),
            ) {
                return Err(OrbitError::bad_request(
                    error_codes::VERIFICATION_FAILED,
                    orbitid_federation::browser_mismatch_message(&state.env.base_url, "POST"),
                ));
            }
            taken.flow
        }
        None if connection.allow_idp_initiated => {
            let (client, token) = create_client(
                &state,
                Some(&client_ip(&state, &headers)),
                headers
                    .get("user-agent")
                    .and_then(|value| value.to_str().ok()),
            )
            .await?;
            cookies.push(client_cookie(&headers, &state, &token));
            EnterpriseFlow {
                kind: "sign_in".into(),
                client_id: client.id,
                owner_id: None,
                user_id: None,
                redirect_url: state.settings.get().application.home_url.clone(),
                action_complete_redirect_url: None,
                connection_id: connection.id.clone(),
                browser_hash: None,
            }
        }
        None => {
            return Err(OrbitError::bad_request(
                error_codes::VERIFICATION_FAILED,
                "Unsolicited SAML responses are not allowed for this connection",
            ))
        }
    };
    let external = to_identity_profile(&profile_to_external_profile(&connection, &profile)?);
    let identity = identity_flow(&flow, &headers);
    let result = handle_external_identity(&state, &identity, &external).await?;
    apply_trusted(&state, &mut cookies, &result);
    Ok(Reply::redirect(result.redirect_to).cookies(cookies))
}

/// Converts a federation profile into the identity layer's profile shape.
pub(super) fn to_identity_profile(
    profile: &orbitid_federation::ExternalProfile,
) -> ExternalProfile {
    ExternalProfile {
        provider: profile.provider.clone(),
        provider_user_id: profile.provider_user_id.clone(),
        email: profile.email.clone(),
        email_verified: profile.email_verified,
        first_name: profile.first_name.clone(),
        last_name: profile.last_name.clone(),
        username: profile.username.clone(),
        image_url: profile.image_url.clone(),
        access_token: profile.access_token.clone(),
        refresh_token: profile.refresh_token.clone(),
        expires_at: profile.expires_at,
        scopes: profile.scopes.clone(),
    }
}

/// Content-Type of the SAML metadata document.
pub const SAML_METADATA_CONTENT_TYPE: &str = "application/xml; charset=utf-8";
