//! The dashboard's account-based sign-in: boot status, first-run owner setup
//! and opening the console from a signed-in account. Mounted on the public
//! operator-session router (see [`crate::operator_sessions`]).

use axum::extract::State;
use axum::http::{HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::cookies::append_cookie;
use orbitid_core::http::rate_limit::hit;
use orbitid_core::http::OrbitJson;
use orbitid_core::models::{OperatorSessionRow, UserRow};
use orbitid_core::AppState;
use orbitid_credentials::passwords::{assert_password_policy, hash_password};
use orbitid_identity::caller::try_resolve_caller;
use orbitid_identity::client_auth::{client_cookie, create_client, find_client};
use orbitid_identity::console::{console_unclaimed, create_owner, setup_required, OwnerInput};
use orbitid_identity::operator_session::{
    find_operator_session, has_console_access, issue_user_operator_session,
    operator_cookie_origin_allowed, revoke_operator_session, set_operator_cookie, ConsoleUser,
};
use orbitid_identity::sessions::{create_session, CreateSessionInput};
use orbitid_identity::users::{is_valid_email, normalize_email, primary_email};
use orbitid_platform::audit::{audit, AuditInput};
use serde::Deserialize;
use serde_json::{json, Value};

use crate::operator_sessions::{assert_exchange_origin, header_str};
use crate::shared::{json_status, request_ip, PeerAddr};

/// A per-address request budget for one console route.
#[derive(Debug, Clone, Copy)]
pub struct Budget {
    pub name: &'static str,
    pub max: i64,
    pub window_ms: i64,
}

/// The boot check and `current`: every page load and focus refresh asks.
pub const STATUS_BUDGET: Budget = Budget {
    name: "console_status",
    max: 120,
    window_ms: 60_000,
};
/// Owner setup hashes a password per attempt and is open only on a fresh instance.
pub const SETUP_BUDGET: Budget = Budget {
    name: "console_setup",
    max: 10,
    window_ms: 10 * 60_000,
};
/// Opening the console from a signed-in account.
pub const OPEN_BUDGET: Budget = Budget {
    name: "console_open",
    max: 20,
    window_ms: 60_000,
};
pub const SIGN_OUT_BUDGET: Budget = Budget {
    name: "console_sign_out",
    max: 30,
    window_ms: 60_000,
};

/// Spends one request of `budget` for the caller's address and returns that
/// address. Over budget, the request fails with `429 rate_limit_exceeded` and a
/// `Retry-After` header. The instance's "Rate limiting" setting turns it off,
/// like every other limit. Call it after the origin check, so a cross-site page
/// cannot spend a visitor's budget for them.
pub async fn limit(
    state: &AppState,
    headers: &HeaderMap,
    peer: PeerAddr,
    budget: Budget,
) -> Result<String> {
    let ip = request_ip(state, headers, peer);
    hit(
        state,
        &format!("{}:{ip}", budget.name),
        budget.max,
        budget.window_ms,
    )
    .await?;
    Ok(ip)
}

/// `{ object, id, expires_at, user_id }` for a live console session.
pub fn operator_session_json(row: &OperatorSessionRow) -> Value {
    json!({
        "object": "operator_session",
        "id": row.id,
        "expires_at": row.expires_at,
        "user_id": row.user_id,
    })
}

async fn account_json(state: &AppState, user: &UserRow) -> Result<Value> {
    let email = primary_email(state, user).await?.map(|row| row.email);
    Ok(json!({
        "id": user.id,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "username": user.username,
        "email_address": email,
        "image_url": user.image_url,
        "console_access": has_console_access(state, &user.id).await?,
    }))
}

/// Everything the dashboard needs to decide its first screen, in one request.
async fn status_json(state: &AppState, headers: &HeaderMap) -> Result<Value> {
    let operator = find_operator_session(state, headers).await?;
    let caller = try_resolve_caller(state, headers, None).await?;
    let user = match caller.as_ref() {
        Some(caller) if !caller.user.banned => Some(account_json(state, &caller.user).await?),
        _ => None,
    };
    let setup = setup_required(state).await?;
    Ok(json!({
        "object": "operator_status",
        "operator_session": operator.as_ref().map(operator_session_json),
        "user": user,
        "setup_required": setup,
        // Accounts exist but none can open the console: an instance from
        // before owners. The sign-in screen explains `orbitid owner <email>`.
        "console_unclaimed": !setup && console_unclaimed(state).await?,
    }))
}

/// `GET /v1/operator_sessions/status`. Never 401: signed out is a valid answer.
pub async fn status(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: PeerAddr,
) -> Result<Response> {
    if !operator_cookie_origin_allowed(&state, &headers) {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Cross-origin requests cannot read the dashboard session.",
        ));
    }
    limit(&state, &headers, peer, STATUS_BUDGET).await?;
    let body = status_json(&state, &headers).await?;
    let mut response = Json(body).into_response();
    response.headers_mut().insert(
        axum::http::header::CACHE_CONTROL,
        axum::http::HeaderValue::from_static("no-store"),
    );
    Ok(response)
}

#[derive(Deserialize)]
pub struct SetupBody {
    email_address: String,
    password: String,
    #[serde(default)]
    first_name: Option<String>,
    #[serde(default)]
    last_name: Option<String>,
}

fn trimmed(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn setup_closed() -> OrbitError {
    OrbitError::forbidden(
        error_codes::NOT_ALLOWED_ACCESS,
        "This instance already has accounts. Sign in with an account that holds the Owner or Administrator role.",
    )
}

/// `POST /v1/operator_sessions/setup`: create the owner on a fresh instance,
/// sign it in on this browser and open the console, in one step.
pub async fn setup(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: PeerAddr,
    OrbitJson(body): OrbitJson<SetupBody>,
) -> Result<Response> {
    assert_exchange_origin(&state, &headers)?;
    let ip = limit(&state, &headers, peer, SETUP_BUDGET).await?;
    // Cheap early answer; `create_owner` re-checks under its lock.
    if !setup_required(&state).await? {
        return Err(setup_closed());
    }
    let email = normalize_email(&body.email_address);
    if !is_valid_email(&email) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "Enter a valid email address.",
        )
        .with_meta(json!({ "param_name": "email_address" })));
    }
    assert_password_policy(&state.settings.get(), &body.password, "password")?;
    let input = OwnerInput {
        email,
        password_hash: hash_password(&body.password).await?,
        first_name: trimmed(body.first_name),
        last_name: trimmed(body.last_name),
    };
    let Some(user) = create_owner(&state, &input).await? else {
        return Err(setup_closed());
    };

    let user_agent = header_str(&headers, "user-agent");
    // Sign the owner in on this browser, the same way a completed sign-up does:
    // reuse the browser's client when it has one, rotate its token.
    let client = match find_client(&state, &headers).await? {
        Some(client) => client,
        None => {
            create_client(&state, Some(&ip), user_agent.as_deref())
                .await?
                .0
        }
    };
    let created = create_session(
        &state,
        CreateSessionInput {
            ip: Some(ip.clone()),
            user_agent: user_agent.clone(),
            method: Some("password".into()),
            rotate_client_token: true,
            ..CreateSessionInput::new(client.id.clone(), user.id.clone())
        },
    )
    .await?;
    let (row, token) = issue_user_operator_session(
        &state,
        ConsoleUser {
            user_id: &user.id,
            session_id: &created.id,
        },
        user_agent.as_deref(),
        Some(&ip),
    )
    .await?;
    audit(
        &state,
        AuditInput::new("instance.owner_created")
            .actor(user.id.clone())
            .target_type("user")
            .target_id(user.id.clone())
            .ip(ip.clone()),
    )
    .await;
    audit(
        &state,
        AuditInput::new("operator_session.created")
            .actor(user.id.clone())
            .target_type("operator_session")
            .target_id(row.id.clone())
            .ip(ip),
    )
    .await;

    let body = json!({
        "object": "operator_status",
        "operator_session": operator_session_json(&row),
        "user": account_json(&state, &user).await?,
        "setup_required": false,
        "console_unclaimed": false,
    });
    let mut response = json_status(StatusCode::CREATED, body);
    if let Some(client_token) = created.client_token.as_deref() {
        append_cookie(
            response.headers_mut(),
            client_cookie(&headers, &state, client_token),
        );
    }
    set_operator_cookie(response.headers_mut(), &state, &token);
    Ok(response)
}

/// `POST /v1/operator_sessions/from_user`: open the console for the account
/// signed in on this browser.
pub async fn from_user(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: PeerAddr,
) -> Result<Response> {
    assert_exchange_origin(&state, &headers)?;
    let ip = limit(&state, &headers, peer, OPEN_BUDGET).await?;
    let Some(caller) = try_resolve_caller(&state, &headers, None).await? else {
        return Err(OrbitError::unauthorized(
            error_codes::AUTHENTICATION_INVALID,
            "Sign in with your account first.",
        ));
    };
    if caller.user.banned {
        return Err(OrbitError::forbidden(
            error_codes::USER_BANNED,
            "This account has been banned.",
        ));
    }
    if !has_console_access(&state, &caller.user_id).await? {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "This account has no access to the admin console. Ask an owner to give it the Administrator role.",
        ));
    }
    let user_agent = header_str(&headers, "user-agent");
    // One console session per browser: opening it again replaces the cookie.
    let _ = revoke_operator_session(&state, &headers).await;
    let (row, token) = issue_user_operator_session(
        &state,
        ConsoleUser {
            user_id: &caller.user_id,
            session_id: &caller.session_id,
        },
        user_agent.as_deref(),
        Some(&ip),
    )
    .await?;
    audit(
        &state,
        AuditInput::new("operator_session.created")
            .actor(caller.user_id.clone())
            .target_type("operator_session")
            .target_id(row.id.clone())
            .ip(ip),
    )
    .await;
    let mut response = json_status(StatusCode::CREATED, operator_session_json(&row));
    set_operator_cookie(response.headers_mut(), &state, &token);
    Ok(response)
}
