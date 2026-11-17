//! External (social) account routes (`modules/me/external.ts`).

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::cookies::{set_cookie, CookieOptions, SameSite};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::models::ExternalAccountRow;
use orbitid_core::state::AppState;
use orbitid_federation::{
    bind_browser, create_oauth_authorization, get_oauth_adapter, is_provider_enabled,
    provider_key_from_strategy, OAuthFlow, BROWSER_COOKIE, BROWSER_COOKIE_PATH,
    BROWSER_COOKIE_TTL_SECONDS,
};
use orbitid_identity::enterprise_access::assert_additional_identifications_allowed;
use orbitid_identity::external_identity::delete_external_account_on;
use orbitid_identity::serializers::serialize_external_account;
use serde_json::json;

use crate::reply::json_reply;
use crate::util::{require_reverification, validate_redirect_url};

use super::shared::{assert_max_chars, ExternalAccountCreateBody};
use super::{authenticate, HttpMeta};

pub async fn list_external_accounts(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
) -> Result<Response> {
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let rows = sqlx::query_as::<_, ExternalAccountRow>(
        "SELECT * FROM external_accounts WHERE user_id = $1 ORDER BY created_at ASC",
    )
    .bind(&me.user.id)
    .fetch_all(&state.pool)
    .await?;
    let response: Vec<_> = rows.iter().map(serialize_external_account).collect();
    Ok(json_reply(json!({ "response": response }), cookies))
}

fn browser_cookie(state: &AppState, _headers: &HeaderMap, nonce: &str) -> String {
    // `bindBrowser` in the TS server keys `secure` on the base URL alone.
    let secure = state.env.base_url.starts_with("https://");
    set_cookie(
        BROWSER_COOKIE,
        nonce,
        &CookieOptions {
            path: BROWSER_COOKIE_PATH.into(),
            http_only: true,
            secure,
            same_site: if secure {
                SameSite::None
            } else {
                SameSite::Lax
            },
            max_age: Some(BROWSER_COOKIE_TTL_SECONDS),
            domain: None,
        },
    )
}

pub async fn create_external_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    OrbitJson(body): OrbitJson<ExternalAccountCreateBody>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, mut cookies) = authenticate(&state, &headers, &meta).await?;
    assert_additional_identifications_allowed(&state, &me.user.id).await?;
    assert_max_chars(&body.strategy, 64, "strategy")?;
    if !body.strategy.starts_with("oauth_") {
        return Err(OrbitError::unprocessable(
            error_codes::OAUTH_PROVIDER_NOT_ENABLED,
            "strategy must be an oauth_* strategy",
        )
        .with_meta(json!({ "param_name": "strategy" })));
    }
    let provider = provider_key_from_strategy(&body.strategy).to_string();
    if !is_provider_enabled(&state, &provider) {
        return Err(OrbitError::bad_request(
            error_codes::OAUTH_PROVIDER_NOT_ENABLED,
            format!("Social provider \"{provider}\" is not enabled"),
        )
        .with_meta(json!({ "param_name": "strategy" })));
    }
    if get_oauth_adapter(&state, &provider).await?.is_none() {
        return Err(OrbitError::bad_request(
            error_codes::OAUTH_PROVIDER_NOT_ENABLED,
            "Unsupported provider",
        )
        .with_meta(json!({ "param_name": "strategy" })));
    }
    if let Some(redirect) = &body.redirect_url {
        assert_max_chars(redirect, 2048, "redirect_url")?;
    }
    if let Some(scopes) = &body.additional_scopes {
        if scopes.len() > 50 {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "additional_scopes: at most 50 entries",
            )
            .with_meta(json!({ "param_name": "additional_scopes" })));
        }
        for scope in scopes {
            assert_max_chars(scope, 256, "additional_scopes")?;
        }
    }
    let redirect_url = validate_redirect_url(&state, body.redirect_url.as_deref(), "redirect_url")?
        .unwrap_or_else(|| state.settings.get().application.home_url.clone());
    let (nonce, browser_hash) = bind_browser();
    let auth_start = create_oauth_authorization(
        &state,
        &provider,
        OAuthFlow {
            client_id: me.client.id.clone(),
            kind: "connect".into(),
            owner_id: None,
            user_id: Some(me.user.id.clone()),
            redirect_url,
            action_complete_redirect_url: None,
            additional_scopes: body.additional_scopes.clone().unwrap_or_default(),
            browser_hash: browser_hash.clone(),
        },
        browser_hash,
    )
    .await?;
    cookies.push(browser_cookie(&state, &headers, &nonce));
    let timestamp = now();
    Ok(json_reply(
        json!({
            "response": {
                "object": "external_account",
                "id": auth_start.state,
                "provider": provider,
                "provider_user_id": "",
                "identification_id": auth_start.state,
                "email_address": "",
                "first_name": "",
                "last_name": "",
                "username": null,
                "image_url": null,
                "avatar_url": null,
                "approved_scopes": "",
                "public_metadata": {},
                "label": null,
                "verification": {
                    "status": "unverified",
                    "strategy": format!("oauth_{provider}"),
                    "attempts": null,
                    "expire_at": null,
                    "external_verification_redirect_url": auth_start.url,
                },
                "external_verification_redirect_url": auth_start.url,
                "created_at": timestamp,
                "updated_at": timestamp,
            }
        }),
        cookies,
    ))
}

pub async fn delete_external_account(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    // The last-identification guard and the delete run under the same user-row
    // lock; the event commits with the delete. Two concurrent deletes of the
    // last two identifications therefore cannot both succeed.
    let mut tx = state.pool.begin().await?;
    delete_external_account_on(&mut tx, &me.user.id, &id).await?;
    crate::util::emit_user_updated_on(&mut tx, &state, &me.user.id).await?;
    tx.commit().await?;
    Ok(json_reply(
        json!({ "response": { "object": "external_account", "id": id, "deleted": true } }),
        cookies,
    ))
}

pub async fn external_account_access_token(
    State(state): State<AppState>,
    headers: HeaderMap,
    meta: HttpMeta,
    Path(id): Path<String>,
) -> Result<Response> {
    require_reverification(&state, &headers, "first_factor", 10).await?;
    let (me, cookies) = authenticate(&state, &headers, &meta).await?;
    let row = sqlx::query_as::<_, ExternalAccountRow>(
        "SELECT * FROM external_accounts WHERE id = $1 AND user_id = $2",
    )
    .bind(&id)
    .bind(&me.user.id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(
            error_codes::EXTERNAL_ACCOUNT_NOT_FOUND,
            "External account not found",
        )
    })?;
    let token = match row.access_token_enc.as_deref() {
        Some(encrypted) => Some(
            orbitid_core::crypto::decrypt(&state.env.encryption_key, encrypted).map_err(|_| {
                OrbitError::internal("Could not decrypt the external account token")
            })?,
        ),
        None => None,
    };
    Ok(json_reply(
        json!({
            "response": {
                "object": "external_account_access_token",
                "token": token,
                "expires_at": row.token_expires_at,
                "scopes": row.approved_scopes,
            }
        }),
        cookies,
    ))
}
