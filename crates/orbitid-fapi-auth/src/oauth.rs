//! Social OAuth callback: `GET|POST /v1/oauth_callback/:provider`.
//! Ported from `modules/oauth.ts`.

use axum::body::Body;
use axum::extract::{Path, RawQuery, State};
use axum::http::HeaderMap;
use orbitid_core::error::{error_codes, Result};
use orbitid_core::state::AppState;
use orbitid_federation::{
    browser_matches, browser_mismatch_message, get_oauth_adapter, take_oauth_state, ExchangeInput,
};
use orbitid_identity::client_auth::regenerate_client_token;
use orbitid_identity::external_identity::ExternalProfile;
use orbitid_identity::trusted_devices::{
    apply_trusted_device_cookie, read_trusted_device_token, TrustedDeviceCookie,
};
use serde_json::Value;

use crate::external::{handle_external_identity, ExternalIdentityFlow};
use crate::util::{clear_oauth_browser_cookie, query_map, with_query, Reply};

struct CallbackParams {
    state: String,
    code: Option<String>,
    error: Option<String>,
    user_json: Option<String>,
}

fn text_field(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
}

async fn read_callback(
    headers: &HeaderMap,
    query: &std::collections::HashMap<String, String>,
    method: &str,
    body: Option<Vec<u8>>,
) -> CallbackParams {
    if method.eq_ignore_ascii_case("POST") {
        let content_type = headers
            .get("content-type")
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_ascii_lowercase();
        let bytes = body.unwrap_or_default();
        if content_type.contains("application/json") {
            let parsed: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            return CallbackParams {
                state: text_field(parsed.get("state")).unwrap_or_default(),
                code: text_field(parsed.get("code")),
                error: text_field(parsed.get("error")),
                user_json: text_field(parsed.get("user")),
            };
        }
        let mut map = std::collections::HashMap::new();
        for (key, value) in url::form_urlencoded::parse(&bytes) {
            map.insert(key.into_owned(), value.into_owned());
        }
        return CallbackParams {
            state: map.get("state").cloned().unwrap_or_default(),
            code: map.get("code").cloned(),
            error: map.get("error").cloned(),
            user_json: map.get("user").cloned(),
        };
    }
    CallbackParams {
        state: query.get("state").cloned().unwrap_or_default(),
        code: query.get("code").cloned(),
        error: query.get("error").cloned(),
        user_json: None,
    }
}

fn error_redirect(target: &str, code: &str, message: Option<&str>) -> Reply {
    Reply::redirect(with_query(
        target,
        &[
            ("__orbit_error", Some(code)),
            ("__orbit_error_message", message),
        ],
    ))
}

pub async fn callback(
    State(state): State<AppState>,
    headers: HeaderMap,
    Path(provider): Path<String>,
    RawQuery(raw_query): RawQuery,
    method: axum::http::Method,
    body: Body,
) -> Result<Reply> {
    let query = query_map(raw_query.as_deref());
    let method = method.as_str().to_string();
    let bytes = axum::body::to_bytes(body, 1024 * 1024)
        .await
        .ok()
        .map(|bytes| bytes.to_vec());
    let params = read_callback(&headers, &query, &method, bytes).await;
    let settings = state.settings.get();
    let home = settings.application.home_url.clone();
    // Parity with the TypeScript server (`modules/oauth.ts`): the state is
    // consumed before the browser-binding check, so a callback opened in the
    // wrong browser burns the pending flow. Keep that order deliberately; the
    // binding cookie is still the gate on the actual exchange.
    let flow = match take_oauth_state(&state.pool, &params.state, &provider).await {
        Ok(flow) => flow,
        Err(error) => {
            let message = if error.code == error_codes::OAUTH_CALLBACK_ERROR {
                error.message.clone()
            } else {
                "The OAuth state is invalid or has expired".to_string()
            };
            return Ok(error_redirect(
                &home,
                error_codes::OAUTH_CALLBACK_ERROR,
                Some(&message),
            ));
        }
    };
    let target = flow
        .flow
        .action_complete_redirect_url
        .clone()
        .unwrap_or_else(|| flow.flow.redirect_url.clone());
    let presented =
        orbitid_core::http::cookies::get_cookie(&headers, orbitid_federation::BROWSER_COOKIE);
    // The binding cookie is single-use: every outcome of a flow consumes it.
    let clear = clear_oauth_browser_cookie();
    if !browser_matches(presented, &flow.flow.browser_hash) {
        let message = browser_mismatch_message(&state.env.base_url, &method);
        return Ok(
            error_redirect(&target, error_codes::OAUTH_CALLBACK_ERROR, Some(&message))
                .cookie(Some(clear)),
        );
    }
    if let Some(error) = &params.error {
        return Ok(
            error_redirect(&target, error_codes::OAUTH_CALLBACK_ERROR, Some(error))
                .cookie(Some(clear)),
        );
    }
    let Some(code) = &params.code else {
        return Ok(error_redirect(
            &target,
            error_codes::OAUTH_CALLBACK_ERROR,
            Some("Missing authorization code"),
        )
        .cookie(Some(clear)));
    };
    let Some(adapter) = get_oauth_adapter(&state, &provider).await? else {
        return Ok(
            error_redirect(&target, error_codes::OAUTH_PROVIDER_NOT_ENABLED, None)
                .cookie(Some(clear)),
        );
    };
    let tokens = match adapter
        .exchange_code(ExchangeInput {
            code,
            code_verifier: &flow.code_verifier,
            nonce: flow.nonce.as_deref(),
        })
        .await
    {
        Ok(tokens) => tokens,
        Err(error) => {
            return Ok(
                error_redirect(&target, &error.code, Some(&error.message)).cookie(Some(clear))
            );
        }
    };
    let mut profile = match adapter.fetch_profile(&tokens).await {
        Ok(profile) => profile,
        Err(error) => {
            return Ok(
                error_redirect(&target, &error.code, Some(&error.message)).cookie(Some(clear))
            );
        }
    };
    if provider == "apple" {
        let (first_name, last_name) =
            orbitid_federation::apple::apple_profile_name(params.user_json.as_deref());
        if profile.first_name.is_none() {
            profile.first_name = first_name;
        }
        if profile.last_name.is_none() {
            profile.last_name = last_name;
        }
    }
    let profile = ExternalProfile {
        provider: profile.provider,
        provider_user_id: profile.provider_user_id,
        email: profile.email,
        email_verified: profile.email_verified,
        first_name: profile.first_name,
        last_name: profile.last_name,
        username: profile.username,
        image_url: profile.image_url,
        access_token: profile.access_token,
        refresh_token: profile.refresh_token,
        expires_at: profile.expires_at,
        scopes: profile.scopes,
    };
    let client: Option<orbitid_core::models::ClientRow> =
        sqlx::query_as("SELECT * FROM clients WHERE id = $1")
            .bind(&flow.flow.client_id)
            .fetch_optional(&state.pool)
            .await?;
    let Some(client) = client else {
        return Ok(
            error_redirect(&target, error_codes::CLIENT_STATE_INVALID, None).cookie(Some(clear)),
        );
    };
    let (_, cookie) = regenerate_client_token(&state, &headers, &client.id).await?;
    let mut cookies = vec![cookie, clear];
    let identity_flow = ExternalIdentityFlow {
        client_id: flow.flow.client_id.clone(),
        kind: flow.flow.kind.clone(),
        owner_id: flow.flow.owner_id.clone(),
        user_id: flow.flow.user_id.clone(),
        redirect_url: flow.flow.redirect_url.clone(),
        action_complete_redirect_url: flow.flow.action_complete_redirect_url.clone(),
        trusted_device_token: read_trusted_device_token(&headers),
    };
    let result = handle_external_identity(&state, &identity_flow, &profile).await?;
    let mut trusted = HeaderMap::new();
    apply_trusted_device_cookie(
        &mut trusted,
        &state,
        &TrustedDeviceCookie {
            token: result.trusted_device_token.clone(),
            expires_at: result.trusted_device_expires_at,
            clear: result.clear_trusted_device,
        },
    );
    for value in trusted.get_all(axum::http::header::SET_COOKIE) {
        if let Ok(value) = value.to_str() {
            cookies.push(value.to_string());
        }
    }
    Ok(Reply::redirect(result.redirect_to).cookies(cookies))
}
