use axum::extract::{Path, RawQuery, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::state::AppState;
use orbitid_federation::adapters::pkce_challenge;
use orbitid_federation::saml::SamlCache;
use orbitid_federation::saml::{
    enterprise_oidc_authorize_url, enterprise_oidc_profile, exchange_enterprise_oidc_code,
    fetch_enterprise_user_info, get_oidc_discovery, saml_authorize_url, verify_enterprise_id_token,
    EnterpriseAuthorizeParams,
};
use orbitid_identity::client_auth::regenerate_client_token;
use serde_json::Value;

use crate::external::handle_external_identity;
use crate::util::{clear_oauth_browser_cookie, oauth_browser_cookie, query_map, Reply};

use super::common::*;
use super::flow::*;
use super::saml::to_identity_profile;

/// `GET /v1/client/enterprise/start`.
pub async fn start(
    State(state): State<AppState>,
    headers: HeaderMap,
    RawQuery(raw_query): RawQuery,
) -> Result<Reply> {
    let query = query_map(raw_query.as_deref());
    let connection = match query.get("connection_id") {
        Some(id) => match find_active_connection(&state, id).await? {
            Some(connection) => connection,
            None => {
                return Err(OrbitError::not_found(
                    error_codes::RESOURCE_NOT_FOUND,
                    "Enterprise connection not found",
                ))
            }
        },
        None => {
            let identifier = query
                .get("identifier")
                .or_else(|| query.get("domain"))
                .or_else(|| query.get("email_address"))
                .map(String::as_str)
                .unwrap_or("");
            match find_connection_for_identifier(&state, identifier).await? {
                Some(connection) => connection,
                None => {
                    return Err(OrbitError::not_found(
                        error_codes::RESOURCE_NOT_FOUND,
                        "No enterprise connection matches this identifier",
                    ))
                }
            }
        }
    };
    let (flow, nonce) = flow_from_query(&state, &headers, &query, &connection).await?;
    let cookie = oauth_browser_cookie(&state, &headers, &nonce);
    let provider = provider_for(&connection.protocol, &connection.id);
    if connection.protocol == "saml" {
        let value = create_enterprise_state(&state, &provider, &flow, None, None).await?;
        let cache = SamlCache::new(state.pool.clone());
        let request = saml_authorize_url(&cache, &state.env.base_url, &connection, &value).await?;
        return Ok(Reply::redirect(request.url).cookie(Some(cookie)));
    }
    let discovery = get_oidc_discovery(&state, &connection).await?;
    let nonce = orbitid_core::crypto::random_token(16);
    let code_verifier = orbitid_core::crypto::random_token(32);
    let value =
        create_enterprise_state(&state, &provider, &flow, Some(&code_verifier), Some(&nonce))
            .await?;
    let url = enterprise_oidc_authorize_url(
        &connection,
        &discovery,
        &EnterpriseAuthorizeParams {
            redirect_uri: format!(
                "{}/v1/client/enterprise/oidc_callback/{}",
                state.env.base_url.trim_end_matches('/'),
                connection.id
            ),
            state: value,
            nonce,
            code_challenge: pkce_challenge(&code_verifier),
            scope: None,
        },
    )?;
    Ok(Reply::redirect(url).cookie(Some(cookie)))
}

/// `GET /v1/client/enterprise/oidc_callback/:id`.
pub async fn oidc_callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(id): Path<String>,
    RawQuery(raw_query): RawQuery,
) -> Result<Reply> {
    let connection = require_connection(&state, &id).await?;
    if connection.protocol != "oidc" {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Enterprise OIDC connection not found",
        ));
    }
    if !connection.active {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Enterprise connection is inactive",
        ));
    }
    let query = query_map(raw_query.as_deref());
    if let Some(error) = query.get("error") {
        let description = query.get("error_description").unwrap_or(error);
        return Err(enterprise_error(
            error_codes::OAUTH_CALLBACK_ERROR,
            &format!("The identity provider returned an error: {description}"),
        ));
    }
    let (Some(code), Some(value)) = (query.get("code"), query.get("state")) else {
        return Err(OrbitError::bad_request(
            error_codes::FORM_PARAM_MISSING,
            "code and state are required",
        ));
    };
    let provider = provider_for("oidc", &connection.id);
    let Some(taken) = take_enterprise_state(&state, value, &provider).await? else {
        return Err(OrbitError::bad_request(
            error_codes::VERIFICATION_FAILED,
            "Enterprise SSO state is invalid or expired",
        ));
    };
    let presented =
        orbitid_core::http::cookies::get_cookie(&headers, orbitid_federation::BROWSER_COOKIE);
    if !orbitid_federation::browser_matches(
        presented,
        taken.flow.browser_hash.as_deref().unwrap_or_default(),
    ) {
        return Err(OrbitError::bad_request(
            error_codes::VERIFICATION_FAILED,
            orbitid_federation::browser_mismatch_message(&state.env.base_url, "GET"),
        ));
    }
    let discovery = get_oidc_discovery(&state, &connection).await?;
    let redirect_uri = format!(
        "{}/v1/client/enterprise/oidc_callback/{}",
        state.env.base_url.trim_end_matches('/'),
        connection.id
    );
    let tokens = exchange_enterprise_oidc_code(
        &state,
        &connection,
        &discovery,
        code,
        &redirect_uri,
        taken.code_verifier.as_deref(),
    )
    .await?;
    let mut claims = Value::Object(serde_json::Map::new());
    if let Some(id_token) = &tokens.id_token {
        claims = verify_enterprise_id_token(
            &state,
            &connection,
            &discovery,
            id_token,
            taken.nonce.as_deref(),
        )
        .await?;
    }
    let user_info = match fetch_enterprise_user_info(&state, &discovery, &tokens.access_token).await
    {
        Ok(info) => info,
        Err(_) if tokens.id_token.is_some() => Value::Object(serde_json::Map::new()),
        Err(error) => return Err(error),
    };
    let merged = match (&user_info, &claims) {
        (Value::Object(user), Value::Object(id)) => {
            let mut merged = user.clone();
            for (key, value) in id {
                merged.insert(key.clone(), value.clone());
            }
            Value::Object(merged)
        }
        (_, other) => other.clone(),
    };
    let profile = to_identity_profile(&enterprise_oidc_profile(&connection, &merged, &tokens)?);
    let (_, cookie) = regenerate_client_token(&state, &headers, &taken.flow.client_id).await?;
    // The binding cookie is single-use.
    let mut cookies = vec![cookie, clear_oauth_browser_cookie()];
    let flow = identity_flow(&taken.flow, &headers);
    let result = handle_external_identity(&state, &flow, &profile).await?;
    apply_trusted(&state, &mut cookies, &result);
    Ok(Reply::redirect(result.redirect_to).cookies(cookies))
}
