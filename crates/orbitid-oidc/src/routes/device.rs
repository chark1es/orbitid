//! Device authorization grant, verification page and its Frontend API, ported
//! from `modules/oidc/device.ts`.

use axum::extract::State;
use axum::http::{header, HeaderMap, HeaderValue, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::Router;
use serde::Deserialize;
use serde_json::json;

use orbitid_core::error::{error_codes, OrbitError};
use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;

use orbitid_core::http::hit;

use orbitid_identity::machine_auth::resolve_caller;

use crate::device_page::{
    device_page_html, device_result_html, DevicePageInput, DevicePageState, DeviceResultState,
    DEVICE_PAGE_CSP,
};
use crate::services::oidc::applications::{assert_scopes_allowed, authenticate_client};
use crate::services::oidc::device::{
    burn_device_code, create_device_authorization, decide_device_code, device_application,
    find_device_by_user_code, format_user_code, normalize_user_code, DeviceAuthorizationInput,
    DeviceDecision, DeviceDecisionInput,
};
use crate::services::oidc::issuer::issuer_for;
use crate::services::oidc::shared::{parse_scopes, scope_description, HandlerResult};
use crate::web::{query_map, url_with};

use super::{device_verification_url, json_response, sign_in_link};
use super::{ip_of, Peer};

/// Attempts a single user code gets (per IP and per code) before it is burned.
pub const DEVICE_CODE_ATTEMPTS: i64 = 10;
pub const DEVICE_CODE_WINDOW_MS: i64 = 10 * 60 * 1000;
/// Limits for the unauthenticated device endpoints.
pub const DEVICE_LOOKUP_PER_IP: i64 = 20;

const DEVICE_JS: &str = include_str!("../assets/oidc-device.js");
const DEVICE_CSS: &str = include_str!("../assets/oidc-device.css");

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/oauth/device_authorization", post(device_authorization))
        .route("/oauth/device", get(device_page).post(device_decision))
        .route("/oauth/device.js", get(device_js))
        .route("/oauth/device.css", get(device_css))
}

pub(super) fn device_enabled(state: &AppState) -> bool {
    state
        .settings
        .get()
        .oidc_provider
        .device_authorization_enabled
}

fn product_name(state: &AppState) -> String {
    state.settings.get().application.name.clone()
}

fn route_missing() -> Response {
    super::route_not_found()
}

#[derive(Debug, Default, Deserialize)]
struct DeviceAuthorizationBody {
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    scope: Option<String>,
    #[serde(default)]
    client_secret: Option<String>,
}

async fn device_authorization(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    OrbitJson(body): OrbitJson<DeviceAuthorizationBody>,
) -> HandlerResult<Response> {
    if !device_enabled(&state) {
        return Err(
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "Route not found").into(),
        );
    }
    hit(
        &state,
        &format!(
            "oauth-device-authorization:{}",
            ip_of(&state, &headers, peer)
        ),
        30,
        60 * 60 * 1000,
    )
    .await?;
    let app_row = authenticate_client(
        &state,
        headers
            .get(header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok()),
        body.client_id.as_deref(),
        body.client_secret.as_deref(),
    )
    .await?;
    let scopes = assert_scopes_allowed(
        &app_row,
        &parse_scopes(body.scope.as_deref().unwrap_or("openid")),
    )?;
    let created = create_device_authorization(
        &state,
        DeviceAuthorizationInput {
            application: &app_row,
            scopes: &scopes,
        },
    )
    .await?;
    let verification_uri = device_verification_url(&state, Some(&issuer_for(&state, &headers)));
    let user_code = format_user_code(&created.row.user_code);
    Ok(json_response(
        StatusCode::OK,
        json!({
            "device_code": created.device_code,
            "user_code": user_code,
            "verification_uri": verification_uri,
            "verification_uri_complete": url_with(&verification_uri, &[("user_code", Some(&user_code))]),
            "expires_in": created.expires_in_seconds,
            "interval": created.interval_seconds,
        }),
    ))
}

/// Counts one user-code attempt per IP and per submitted code; burning the code
/// once its own budget runs out.
pub(super) async fn count_device_attempt(
    state: &AppState,
    headers: &HeaderMap,
    peer: Peer,
    raw_user_code: &str,
) -> orbitid_core::Result<()> {
    hit(
        state,
        &format!("oauth-device:ip:{}", ip_of(state, headers, peer)),
        DEVICE_LOOKUP_PER_IP,
        DEVICE_CODE_WINDOW_MS,
    )
    .await?;
    // Only a well-formed code gets a per-code counter: an arbitrary string must
    // not become a rate-limit key.
    let Some(user_code) = normalize_user_code(raw_user_code) else {
        return Ok(());
    };
    match hit(
        state,
        &format!("oauth-device:code:{user_code}"),
        DEVICE_CODE_ATTEMPTS,
        DEVICE_CODE_WINDOW_MS,
    )
    .await
    {
        Ok(()) => Ok(()),
        Err(error) => {
            // Only the per-code budget burns the code: a noisy IP must not be
            // able to cancel someone's approval.
            if let Some(row) = find_device_by_user_code(state, &user_code).await? {
                burn_device_code(state, &row).await?;
            }
            Err(error)
        }
    }
}

fn render_page(state: &AppState, input: &DevicePageInput) -> Response {
    let html = device_page_html(input, &product_name(state));
    super::html_with_headers(
        html,
        StatusCode::OK,
        &[
            ("content-security-policy", DEVICE_PAGE_CSP),
            ("cache-control", "no-store"),
            ("referrer-policy", "no-referrer"),
        ],
    )
}

async fn device_state(
    state: &AppState,
    headers: &HeaderMap,
    raw_code: Option<&str>,
) -> orbitid_core::Result<DevicePageInput> {
    let caller = resolve_caller(state, headers).await?;
    let signed_in = caller
        .as_ref()
        .and_then(|caller| caller.user_id.as_deref())
        .is_some();
    let code = raw_code.and_then(normalize_user_code);
    let page_url = url_with(
        &device_verification_url(state, Some(&issuer_for(state, headers))),
        &[(
            "user_code",
            code.as_deref().map(format_user_code).as_deref(),
        )],
    );
    let sign_in_href = sign_in_link(state, &page_url);
    let Some(code) = code else {
        return Ok(DevicePageInput {
            signed_in,
            sign_in_href,
            code: None,
            app_name: None,
            scopes: Vec::new(),
            scopes_with_descriptions: None,
            state: DevicePageState::EnterCode,
        });
    };
    let Some(row) = find_device_by_user_code(state, &code).await? else {
        return Ok(DevicePageInput {
            signed_in,
            sign_in_href,
            code: Some(code),
            app_name: None,
            scopes: Vec::new(),
            scopes_with_descriptions: None,
            state: DevicePageState::NotFound,
        });
    };
    if row.expires_at <= orbitid_core::http::now() {
        return Ok(DevicePageInput {
            signed_in,
            sign_in_href,
            code: Some(code),
            app_name: None,
            scopes: Vec::new(),
            scopes_with_descriptions: None,
            state: DevicePageState::Expired,
        });
    }
    let application = device_application(state, &row).await?;
    let scopes = parse_scopes(&row.scopes);
    let app_name = application.as_ref().map(|app| app.name.clone());
    if row.status != "pending" {
        return Ok(DevicePageInput {
            signed_in,
            sign_in_href,
            code: Some(code),
            app_name,
            scopes,
            scopes_with_descriptions: None,
            state: DevicePageState::AlreadyDecided,
        });
    }
    if !signed_in {
        return Ok(DevicePageInput {
            signed_in,
            sign_in_href,
            code: Some(code),
            app_name,
            scopes,
            scopes_with_descriptions: None,
            state: DevicePageState::SignInRequired,
        });
    }
    let described = scopes
        .iter()
        .map(|scope| (scope.clone(), scope_description(scope)))
        .collect();
    Ok(DevicePageInput {
        signed_in,
        sign_in_href,
        code: Some(code),
        app_name,
        scopes,
        scopes_with_descriptions: Some(described),
        state: DevicePageState::Consent,
    })
}

async fn device_page(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    uri: Uri,
) -> HandlerResult<Response> {
    if !device_enabled(&state) {
        return Ok(route_missing());
    }
    let query = query_map(uri.query());
    let raw = query.get("user_code").cloned().unwrap_or_default();
    if !raw.is_empty() {
        if let Err(error) = count_device_attempt(&state, &headers, peer, &raw).await {
            if error.status == StatusCode::TOO_MANY_REQUESTS {
                return Ok(super::html_with_headers(
                    device_result_html(
                        DeviceResultState::TooManyAttempts,
                        None,
                        &product_name(&state),
                    ),
                    StatusCode::TOO_MANY_REQUESTS,
                    &[
                        ("content-security-policy", DEVICE_PAGE_CSP),
                        ("cache-control", "no-store"),
                    ],
                ));
            }
            return Err(error.into());
        }
    }
    let input = device_state(&state, &headers, Some(&raw)).await?;
    Ok(render_page(&state, &input))
}

#[derive(Debug, Default, Deserialize)]
struct DeviceForm {
    #[serde(default)]
    user_code: String,
    #[serde(default)]
    action: Option<String>,
}

async fn device_decision(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: Peer,
    OrbitJson(form): OrbitJson<DeviceForm>,
) -> HandlerResult<Response> {
    if !device_enabled(&state) {
        return Ok(route_missing());
    }
    // Same-origin only: a cross-site form post must not approve a code its
    // author created.
    let fetch_site = headers
        .get("sec-fetch-site")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let origin = headers
        .get(header::ORIGIN)
        .and_then(|value| value.to_str().ok());
    let issuer_origin = url::Url::parse(&issuer_for(&state, &headers))
        .map(|url| url.origin().ascii_serialization())
        .unwrap_or_default();
    if fetch_site == "cross-site" || origin.is_some_and(|origin| origin != issuer_origin) {
        return Ok(super::html_with_headers(
            device_result_html(DeviceResultState::CrossSite, None, &product_name(&state)),
            StatusCode::FORBIDDEN,
            &[
                ("content-security-policy", DEVICE_PAGE_CSP),
                ("cache-control", "no-store"),
                ("referrer-policy", "no-referrer"),
            ],
        ));
    }

    let raw_code = form.user_code.clone();
    let action = match form.action.as_deref() {
        Some("deny") => Some(false),
        Some("approve") => Some(true),
        _ => None,
    };
    let caller = resolve_caller(&state, &headers).await?;
    let Some(approve) = action else {
        let input = device_state(&state, &headers, Some(&raw_code)).await?;
        return Ok(render_page(&state, &input));
    };
    let Some(user_id) = caller.and_then(|caller| caller.user_id) else {
        let input = device_state(&state, &headers, Some(&raw_code)).await?;
        return Ok(render_page(&state, &input));
    };
    let Some(code) = normalize_user_code(&raw_code) else {
        let input = device_state(&state, &headers, Some(&raw_code)).await?;
        return Ok(render_page(&state, &input));
    };
    if let Err(error) = count_device_attempt(&state, &headers, peer, &code).await {
        if error.status == StatusCode::TOO_MANY_REQUESTS {
            return Ok(super::html_with_headers(
                device_result_html(
                    DeviceResultState::TooManyAttempts,
                    None,
                    &product_name(&state),
                ),
                StatusCode::TOO_MANY_REQUESTS,
                &[
                    ("content-security-policy", DEVICE_PAGE_CSP),
                    ("cache-control", "no-store"),
                ],
            ));
        }
        return Err(error.into());
    }
    let decision = decide_device_code(
        &state,
        DeviceDecisionInput {
            user_code: &code,
            user_id: &user_id,
            approve,
        },
    )
    .await?;
    match decision {
        DeviceDecision::Ok { application, .. } => Ok(super::html_with_headers(
            device_result_html(
                if approve {
                    DeviceResultState::Approved
                } else {
                    DeviceResultState::Denied
                },
                Some(&application.name),
                &product_name(&state),
            ),
            StatusCode::OK,
            &[
                ("content-security-policy", DEVICE_PAGE_CSP),
                ("cache-control", "no-store"),
                ("referrer-policy", "no-referrer"),
            ],
        )),
        DeviceDecision::Rejected { .. } => {
            let input = device_state(&state, &headers, Some(&raw_code)).await?;
            Ok(render_page(&state, &input))
        }
    }
}

async fn device_js(State(state): State<AppState>) -> Response {
    if !device_enabled(&state) {
        return route_missing();
    }
    asset(DEVICE_JS, "text/javascript; charset=utf-8")
}

async fn device_css(State(state): State<AppState>) -> Response {
    if !device_enabled(&state) {
        return route_missing();
    }
    asset(DEVICE_CSS, "text/css; charset=utf-8")
}

fn asset(body: &str, content_type: &'static str) -> Response {
    let mut response = (StatusCode::OK, body.to_string()).into_response();
    let headers = response.headers_mut();
    headers.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    headers.insert(
        header::CACHE_CONTROL,
        HeaderValue::from_static("public, max-age=3600"),
    );
    headers.insert(
        header::HeaderName::from_static("x-content-type-options"),
        HeaderValue::from_static("nosniff"),
    );
    response
}
