//! OpenID discovery, JWKS and authorize routes, ported from
//! `modules/oidc/discovery.ts`.

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode, Uri};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use serde_json::json;

use orbitid_core::state::AppState;
use orbitid_identity::machine_auth::resolve_caller;
use orbitid_identity::users::get_user_by_identifier;

use crate::services::oidc::applications::{
    assert_redirect_uri, assert_scopes_allowed, get_application_by_client_id,
};
use crate::services::oidc::claims::session_auth_time;
use crate::services::oidc::issuer::issuer_for;
use crate::services::oidc::shared::{parse_scopes, HandlerResult};
use crate::services::oidc::tokens::{has_consent, issue_authorization_code};
use crate::web::query_map;

use super::{
    authorize_response, consent_url, current_url, json_response, sign_in_return_url, sign_in_url,
    ResponseMode,
};

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/oauth/authorize", get(authorize))
        .route("/oauth/consent_info", get(super::consent::consent_info))
        .route(
            "/oauth/consent",
            axum::routing::post(super::consent::consent),
        )
}

pub(crate) fn query_value(
    query: &std::collections::HashMap<String, String>,
    key: &str,
) -> Option<String> {
    query.get(key).cloned()
}

/// Builds the sign-in URL for this authorize request, optionally adding
/// `login_hint` / `prompt=select_account` (`set`, never append).
fn sign_in_target(
    state: &AppState,
    headers: &HeaderMap,
    uri: &Uri,
    login_hint: Option<&str>,
    select_account: bool,
) -> String {
    let base = sign_in_url(state, &sign_in_return_url(state, headers, uri));
    let Ok(mut url) = url::Url::parse(&base) else {
        return base;
    };
    if let Some(hint) = login_hint.filter(|value| !value.is_empty()) {
        url.query_pairs_mut().append_pair("login_hint", hint);
        // `set` semantics: drop an earlier duplicate.
        let retained: Vec<(String, String)> = url
            .query_pairs()
            .filter(|(key, _)| key != "login_hint")
            .map(|(key, value)| (key.into_owned(), value.into_owned()))
            .collect();
        url.set_query(None);
        {
            let mut pairs = url.query_pairs_mut();
            for (key, value) in retained {
                pairs.append_pair(&key, &value);
            }
            pairs.append_pair("login_hint", hint);
        }
    }
    if select_account {
        url.query_pairs_mut()
            .append_pair("prompt", "select_account");
    }
    url.to_string()
}

fn authorize_failure(
    redirect_uri: &str,
    error: &str,
    description: &str,
    state: Option<&str>,
    mode: ResponseMode,
) -> Response {
    authorize_response(
        redirect_uri,
        &[
            ("error", Some(error)),
            ("error_description", Some(description)),
            ("state", state),
        ],
        mode,
    )
}

fn invalid_request_response(description: &str) -> Response {
    json_response(
        StatusCode::BAD_REQUEST,
        json!({ "error": "invalid_request", "error_description": description }),
    )
}

async fn authorize(
    State(state): State<AppState>,
    headers: HeaderMap,
    uri: Uri,
) -> HandlerResult<Response> {
    let query = query_map(uri.query());
    let get = |key: &str| query_value(&query, key);
    let issuer = issuer_for(&state, &headers);
    let app_row =
        match get_application_by_client_id(&state, &get("client_id").unwrap_or_default()).await? {
            Some(row) => row,
            None => return Ok(invalid_request_response("Unknown client_id")),
        };

    let redirect_uri = match assert_redirect_uri(&app_row, get("redirect_uri").as_deref()) {
        Ok(uri) => uri,
        // Never redirect to an unregistered URI: the error is returned to the caller.
        Err(error) => return Ok(json_response(StatusCode::BAD_REQUEST, error_body(&error))),
    };

    let mut response_mode = ResponseMode::Query;
    if let Some(requested) = get("response_mode").filter(|value| !value.is_empty()) {
        match requested.as_str() {
            "query" => response_mode = ResponseMode::Query,
            "form_post" => response_mode = ResponseMode::FormPost,
            _ => {
                return Ok(json_response(
                    StatusCode::BAD_REQUEST,
                    json!({
                        "error": "unsupported_response_mode",
                        "error_description": "response_mode must be query or form_post",
                    }),
                ))
            }
        }
    }

    let state_param = get("state");
    let fail = |error: &str, description: &str| {
        authorize_failure(
            &redirect_uri,
            error,
            description,
            state_param.as_deref(),
            response_mode,
        )
    };

    // A signed-in non-member of an organization's application is refused before
    // any further validation, so the answer never reveals the application's
    // scopes or PKCE policy. Requests that may still switch accounts
    // (`prompt=login`/`select_account`, a `login_hint`) are checked after
    // sign-in instead, below.
    let caller = resolve_caller(&state, &headers).await?;
    let may_switch_account = get("prompt").is_some_and(|prompt| {
        prompt
            .split_whitespace()
            .any(|value| value == "login" || value == "select_account")
    }) || get("login_hint").is_some_and(|hint| !hint.is_empty());
    if let Some(user_id) = caller
        .as_ref()
        .and_then(|caller| caller.user_id.as_deref())
        .filter(|_| !may_switch_account)
    {
        if !orbitid_identity::app_access::user_may_use_application(
            &state.pool,
            &app_row.id,
            app_row.organization_id.as_deref(),
            user_id,
        )
        .await?
        {
            return Ok(fail(
                "access_denied",
                "The user is not allowed to use this application",
            ));
        }
    }

    if get("response_type").unwrap_or_default() != "code" {
        return Ok(fail(
            "unsupported_response_type",
            "Only response_type=code is supported",
        ));
    }

    let prompts: Vec<String> = get("prompt")
        .unwrap_or_default()
        .split_whitespace()
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect();
    let has_prompt = |name: &str| prompts.iter().any(|prompt| prompt == name);
    if has_prompt("none") && prompts.len() > 1 {
        return Ok(fail(
            "invalid_request",
            "prompt=none cannot be combined with other prompt values",
        ));
    }
    let max_age = match get("max_age").filter(|value| !value.is_empty()) {
        Some(raw) => match raw.parse::<i64>() {
            Ok(value) if value >= 0 => Some(value),
            _ => {
                return Ok(fail(
                    "invalid_request",
                    "max_age must be a non-negative integer",
                ))
            }
        },
        None => None,
    };

    let scopes = parse_scopes(&get("scope").unwrap_or_else(|| "openid".into()));
    if let Err(error) = assert_scopes_allowed(&app_row, &scopes) {
        return Ok(fail("invalid_scope", &error.description));
    }

    let pkce_required = app_row.is_public || app_row.pkce_required;
    let code_challenge = get("code_challenge").filter(|value| !value.is_empty());
    let code_challenge_method = get("code_challenge_method")
        .filter(|value| !value.is_empty())
        .or_else(|| code_challenge.as_ref().map(|_| "S256".to_string()));
    if pkce_required && code_challenge.is_none() {
        return Ok(fail(
            "invalid_request",
            "code_challenge is required (PKCE, S256)",
        ));
    }
    if let Some(method) = &code_challenge_method {
        if method != "S256" {
            return Ok(fail(
                "invalid_request",
                "Only code_challenge_method=S256 is supported",
            ));
        }
    }

    let login_hint = get("login_hint");

    let reauthenticate = has_prompt("login") || has_prompt("select_account");
    if caller
        .as_ref()
        .and_then(|caller| caller.user_id.as_deref())
        .is_none()
        || reauthenticate
    {
        if has_prompt("none") {
            return Ok(fail("login_required", "The user is not signed in"));
        }
        return Ok(crate::web::redirect(&sign_in_target(
            &state,
            &headers,
            &uri,
            login_hint.as_deref(),
            has_prompt("select_account"),
        )));
    }
    let Some(caller) = caller else {
        return Ok(fail("login_required", "The user is not signed in"));
    };
    let user_id = caller.user_id.clone().unwrap_or_default();
    let session_id = caller.session_id.clone();

    // A hint that names a different account means the current session is not
    // the one the client wants.
    if let Some(hint) = login_hint.as_deref().filter(|value| !value.is_empty()) {
        if let Some((hinted, _)) = get_user_by_identifier(&state, hint).await? {
            if hinted.id != user_id {
                if has_prompt("none") {
                    return Ok(fail(
                        "login_required",
                        "The requested account is not signed in",
                    ));
                }
                return Ok(crate::web::redirect(&sign_in_target(
                    &state,
                    &headers,
                    &uri,
                    Some(hint),
                    has_prompt("select_account"),
                )));
            }
        }
    }

    if let Some(max_age) = max_age {
        let auth_time = session_auth_time(&state, session_id.as_deref().unwrap_or("")).await?;
        let now = orbitid_core::http::now() / 1000;
        if auth_time.is_none_or(|auth_time| now - auth_time > max_age) {
            if has_prompt("none") {
                return Ok(fail(
                    "login_required",
                    "The user must sign in again (max_age)",
                ));
            }
            return Ok(crate::web::redirect(&sign_in_target(
                &state,
                &headers,
                &uri,
                login_hint.as_deref(),
                has_prompt("select_account"),
            )));
        }
    }

    // Organization-owned applications: only members of the owning organization
    // and users an operator granted access may continue. The client already
    // proved it is registered (client_id + redirect_uri), so `access_denied` to
    // its redirect URI reveals nothing new. The token endpoint re-checks under
    // locks; this is the early refusal.
    if !orbitid_identity::app_access::user_may_use_application(
        &state.pool,
        &app_row.id,
        app_row.organization_id.as_deref(),
        &user_id,
    )
    .await?
    {
        return Ok(fail(
            "access_denied",
            "The user is not allowed to use this application",
        ));
    }

    let needs_consent = app_row.consent_screen_enabled
        && (has_prompt("consent") || !has_consent(&state, &app_row.id, &user_id, &scopes).await?);
    if needs_consent && has_prompt("none") {
        return Ok(fail(
            "consent_required",
            "The user has not consented to this request",
        ));
    }
    if needs_consent {
        return Ok(crate::web::redirect(&consent_url(
            &state,
            &app_row.name,
            &app_row.client_id,
            &scopes.join(" "),
            &current_url(&state, &headers, &uri),
        )));
    }

    let code = issue_authorization_code(
        &state,
        crate::services::oidc::tokens::IssueCodeInput {
            application: &app_row,
            user_id: &user_id,
            scopes: &scopes,
            redirect_uri: &redirect_uri,
            code_challenge: code_challenge.as_deref(),
            code_challenge_method: code_challenge_method.as_deref(),
            nonce: get("nonce").as_deref(),
            session_id: session_id.as_deref(),
        },
    )
    .await?;
    Ok(authorize_response(
        &redirect_uri,
        &[
            ("code", Some(&code)),
            ("state", state_param.as_deref()),
            ("iss", Some(&issuer)),
        ],
        response_mode,
    ))
}

fn error_body(error: &crate::services::oidc::shared::OAuthError) -> serde_json::Value {
    json!({ "error": error.error, "error_description": error.description })
}
