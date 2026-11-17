use axum::extract::State;
use axum::response::Response;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::email_format::{parse_email_from, parse_smtp_url};
use orbitid_core::http::OrbitJson;
use orbitid_core::secrets::{mask_secrets, unmask_settings_patch};
use orbitid_core::state::AppState;
use orbitid_platform::audit::{audit, AuditInput};
use serde_json::{json, Map, Value};

use crate::shared::json_response;

pub(super) const TESTING_TOKEN_TTL_MS: i64 = 3_600_000;
const INSTANCE_URL_FIELDS: [&str; 4] = ["homeUrl", "logoUrl", "termsUrl", "privacyUrl"];
const INSTANCE_URL_LIST_FIELDS: [&str; 2] = ["allowedOrigins", "allowedRedirectOrigins"];

pub(super) fn instance_json(state: &AppState) -> Result<Value> {
    let settings = state.settings.get();
    let masked = mask_secrets(&settings);
    let mut out = json!({
        "object": "instance",
        "id": "default",
        "environment_type": if state.env.node_env == "production" { "production" } else { "development" },
        "publishable_key": state.publishable_key,
        "database": {
            "dialect": "postgres",
            "driver": "postgres",
            "label": state.env.database.label(),
        },
    });
    if let (Some(target), Some(source)) = (out.as_object_mut(), masked.as_object()) {
        for (key, value) in source {
            target.insert(key.clone(), value.clone());
        }
    }
    Ok(out)
}

pub(super) async fn read(State(state): State<AppState>) -> Result<Response> {
    Ok(json_response(instance_json(&state)?))
}

pub(super) fn invalid_param(param: &str, message: String) -> OrbitError {
    OrbitError::unprocessable(error_codes::FORM_PARAM_FORMAT_INVALID, message)
        .with_meta(json!({ "param_name": param }))
}

fn assert_instance_urls(patch: &Map<String, Value>) -> Result<()> {
    let Some(application) = patch.get("application").and_then(Value::as_object) else {
        return Ok(());
    };
    for field in INSTANCE_URL_FIELDS {
        let Some(value) = application.get(field) else {
            continue;
        };
        if value.is_null() {
            continue;
        }
        let valid = value
            .as_str()
            .map(|text| {
                let lower = text.to_ascii_lowercase();
                (lower.starts_with("http://") || lower.starts_with("https://"))
                    && !text.chars().any(char::is_whitespace)
            })
            .unwrap_or(false);
        if !valid {
            return Err(invalid_param(
                &format!("application.{field}"),
                format!("application.{field} must be an absolute http(s) URL."),
            ));
        }
    }
    for field in INSTANCE_URL_LIST_FIELDS {
        let Some(value) = application.get(field) else {
            continue;
        };
        let Some(items) = value.as_array() else {
            return Err(invalid_param(
                &format!("application.{field}"),
                format!("application.{field} must be an array of URLs."),
            ));
        };
        for (index, origin) in items.iter().enumerate() {
            let valid = origin
                .as_str()
                .map(|text| {
                    let lower = text.to_ascii_lowercase();
                    (lower.starts_with("http://") || lower.starts_with("https://"))
                        && !text.chars().any(char::is_whitespace)
                        && !text
                            .split_once("://")
                            .map(|(_, rest)| rest.contains('/'))
                            .unwrap_or(false)
                })
                .unwrap_or(false);
            if !valid {
                return Err(invalid_param(
                    &format!("application.{field}"),
                    format!("application.{field}[{index}] must be an absolute http(s) origin."),
                ));
            }
        }
    }
    Ok(())
}

fn assert_email_settings(patch: &Map<String, Value>) -> Result<()> {
    let Some(email) = patch.get("email").and_then(Value::as_object) else {
        return Ok(());
    };
    if let Some(from) = email.get("from") {
        let Some(from) = from.as_str() else {
            return Err(invalid_param(
                "email.from",
                "email.from must be a string".into(),
            ));
        };
        parse_email_from(from, "email.from")?;
    }
    if let Some(smtp_url) = email.get("smtpUrl") {
        let Some(smtp_url) = smtp_url.as_str() else {
            return Err(invalid_param(
                "email.smtpUrl",
                "email.smtpUrl must be a string".into(),
            ));
        };
        if !smtp_url.trim().is_empty() {
            parse_smtp_url(smtp_url, "email.smtpUrl")?;
        }
    }
    for field in ["resendApiKey"] {
        let Some(value) = email.get(field) else {
            continue;
        };
        let Some(value) = value.as_str() else {
            return Err(invalid_param(
                &format!("email.{field}"),
                format!("email.{field} must be a string"),
            ));
        };
        if value.contains('\r') || value.contains('\n') {
            return Err(invalid_param(
                &format!("email.{field}"),
                format!("email.{field} must not contain line breaks"),
            ));
        }
    }
    Ok(())
}

async fn assert_organization_roles(state: &AppState, patch: &Map<String, Value>) -> Result<()> {
    let Some(organizations) = patch.get("organizations").and_then(Value::as_object) else {
        return Ok(());
    };
    for field in ["creatorRole", "defaultRole"] {
        let Some(value) = organizations.get(field) else {
            continue;
        };
        let Some(key) = value.as_str().filter(|key| !key.is_empty()) else {
            return Err(invalid_param(
                &format!("organizations.{field}"),
                format!("organizations.{field} must be a role key"),
            ));
        };
        // Scope is a pure policy check; do it here as well because this handler
        // queries the database before `settings.update` runs the policy.
        if !key.starts_with("org:") {
            return Err(invalid_param(
                &format!("organizations.{field}"),
                format!(
                    "organizations.{field} must be an organization role key (\"org:...\"), not \"{key}\"."
                ),
            ));
        }
        let exists: Option<String> = sqlx::query_scalar("SELECT id FROM roles WHERE key = $1")
            .bind(key)
            .fetch_optional(&state.pool)
            .await?;
        if exists.is_none() {
            return Err(OrbitError::unprocessable(
                error_codes::ORG_ROLE_NOT_FOUND,
                format!(
                    "organizations.{field} names \"{key}\", which does not exist. Create the role first."
                ),
            )
            .with_meta(json!({ "param_name": format!("organizations.{field}") })));
        }
    }
    Ok(())
}

pub(super) async fn update(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<Value>,
) -> Result<Response> {
    let patch = unmask_settings_patch(&state.settings.get(), body);
    let Some(patch_object) = patch.as_object() else {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "body must be an object",
        ));
    };
    assert_instance_urls(patch_object)?;
    assert_email_settings(patch_object)?;
    assert_organization_roles(&state, patch_object).await?;
    state.settings.update(patch.clone()).await?;
    audit(
        &state,
        AuditInput::new("instance.updated")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("instance")
            .target_id("default")
            .metadata(json!({ "fields": patch_object.keys().collect::<Vec<_>>() })),
    )
    .await;
    Ok(json_response(instance_json(&state)?))
}
