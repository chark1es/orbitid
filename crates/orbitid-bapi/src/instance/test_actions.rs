use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::http::StatusCode;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::email_format::parse_email_from;
use orbitid_core::http::rate_limit::hit;
use orbitid_core::http::OrbitJson;
use orbitid_core::state::AppState;
use orbitid_federation::preview::{preview_provider, ProviderPreviewInput};
use orbitid_platform::audit::{audit, AuditInput};
use orbitid_platform::mail::{send_email, send_test_email, EmailTemplate, SendEmailInput};
use serde::Deserialize;
use serde_json::{json, Map};

use crate::shared::{json_response, request_ip, to_value, PeerAddr};

use super::settings::{instance_json, invalid_param};

#[derive(Debug, Deserialize)]
pub(super) struct TestEmailBody {
    to: Option<String>,
}

pub(super) async fn test_email(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<TestEmailBody>,
) -> Result<Response> {
    let settings = state.settings.get();
    let from = settings.email.from.trim();
    let fallback = if from.is_empty() {
        state.env.email_from.trim()
    } else {
        from
    };
    let fallback = parse_email_from(
        if fallback.is_empty() {
            "no-reply@localhost"
        } else {
            fallback
        },
        "email.from",
    )?
    .address;
    let to = body
        .to
        .clone()
        .or_else(|| settings.application.support_email.clone())
        .unwrap_or(fallback);
    let mut vars = Map::new();
    vars.insert("code".into(), json!("123456"));
    vars.insert("app_name".into(), json!(settings.application.name));
    let delivery = send_email(
        &state,
        SendEmailInput {
            to: to.clone(),
            template: EmailTemplate::VerificationCode,
            vars,
        },
    )
    .await;
    if !delivery.delivered {
        let error = delivery
            .error
            .unwrap_or_else(|| orbitid_platform::mail::EmailDeliveryError {
                code: "email_delivery_failed".into(),
                message: "Email delivery failed.".into(),
            });
        let status = if error.code == error_codes::FORM_PARAM_FORMAT_INVALID
            || error.code == error_codes::FORM_PARAM_MISSING
        {
            StatusCode::UNPROCESSABLE_ENTITY
        } else {
            StatusCode::SERVICE_UNAVAILABLE
        };
        return Err(OrbitError::new(status, error.code, error.message));
    }
    Ok(json_response(json!({ "status": "ok", "to": to })))
}

#[derive(Debug, Deserialize)]
pub(super) struct EmailTestBody {
    to: String,
}

pub(super) async fn email_test(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: PeerAddr,
    OrbitJson(body): OrbitJson<EmailTestBody>,
) -> Result<Response> {
    let ip = request_ip(&state, &headers, peer);
    hit(&state, &format!("instance:email_test:{ip}"), 10, 60_000).await?;
    hit(&state, "instance:email_test", 60, 60_000).await?;
    let provider = send_test_email(&state, &body.to).await?;
    let provider_value = to_value(provider)?;
    audit(
        &state,
        AuditInput::new("instance.email_test")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("instance")
            .target_id("default")
            .metadata(json!({ "provider": provider_value })),
    )
    .await;
    Ok(json_response(
        json!({ "provider": provider_value, "ok": true }),
    ))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(super) struct SocialTestBody {
    protocol: Option<orbitid_core::settings::types::SocialProtocol>,
    discovery_url: Option<String>,
    issuer: Option<String>,
    authorization_url: Option<String>,
    token_url: Option<String>,
    userinfo_url: Option<String>,
    jwks_url: Option<String>,
}

pub(super) async fn social_test(
    State(state): State<AppState>,
    headers: HeaderMap,
    peer: PeerAddr,
    OrbitJson(body): OrbitJson<SocialTestBody>,
) -> Result<Response> {
    let ip = request_ip(&state, &headers, peer);
    hit(&state, &format!("instance:social_test:{ip}"), 20, 60_000).await?;
    hit(&state, "instance:social_test", 120, 60_000).await?;
    let input = ProviderPreviewInput {
        protocol: body.protocol,
        discovery_url: body.discovery_url.clone(),
        issuer: body.issuer.clone(),
        authorization_url: body.authorization_url.clone(),
        token_url: body.token_url.clone(),
        userinfo_url: body.userinfo_url.clone(),
        jwks_url: body.jwks_url.clone(),
    };
    let preview = preview_provider(&state, &input).await;
    audit(
        &state,
        AuditInput::new("instance.social_tested")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("instance")
            .target_id("default")
            .metadata(json!({
                "ok": preview.ok,
                "discovery": body.discovery_url.is_some(),
                "protocol": preview.protocol,
            })),
    )
    .await;
    Ok(json_response(to_value(preview)?))
}

pub(super) async fn delete_social(
    State(state): State<AppState>,
    Path(provider): Path<String>,
) -> Result<Response> {
    if !provider.starts_with("custom_") {
        return Err(invalid_param(
            "provider",
            "Only custom providers can be deleted. Turn a built-in provider off instead.".into(),
        ));
    }
    if !state.settings.get().social.contains_key(&provider) {
        return Err(OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Social provider not found",
        ));
    }
    state
        .settings
        .remove_social_providers(std::slice::from_ref(&provider))
        .await?;
    audit(
        &state,
        AuditInput::new("instance.social_deleted")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("instance")
            .target_id("default")
            .metadata(json!({ "provider": provider })),
    )
    .await;
    Ok(json_response(instance_json(&state)?))
}
