//! Backend API JWT templates (`/v1/jwt_templates`).

use axum::extract::{Path, State};
use axum::response::Response;
use axum::routing::get;
use axum::Router;
use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::http::{now, OrbitJson};
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::JwtTemplateRow;
use orbitid_core::resources::{JwtTemplateJson, Metadata};
use orbitid_core::state::AppState;
use orbitid_credentials::templates::{
    assert_allowed_claims, generate_template_signing_key, template_verification_key,
};
use orbitid_platform::audit::{audit, AuditInput};
use serde::Deserialize;
use serde_json::json;
use sqlx::QueryBuilder;

use crate::shared::{
    deleted_object, deserialize_bool, deserialize_opt_bool, deserialize_opt_int, fetch_all,
    fetch_count, json_response, paginated, to_value, validate_metadata, Bind, QueryPairs,
};

const SIGNING_ALGORITHMS: [&str; 3] = ["RS256", "ES256", "HS256"];

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/v1/jwt_templates", get(list).post(create))
        .route(
            "/v1/jwt_templates/{id}",
            get(read).patch(update).delete(remove),
        )
}

fn serialize_template(state: &AppState, row: &JwtTemplateRow) -> Result<JwtTemplateJson> {
    Ok(JwtTemplateJson {
        object: "jwt_template".into(),
        id: row.id.clone(),
        name: row.name.clone(),
        claims: row.claims.0.clone(),
        lifetime: row.lifetime,
        allowed_clock_skew: row.allowed_clock_skew,
        custom_signing_key: row.custom_signing_key,
        signing_algorithm: row.signing_algorithm.clone(),
        signing_key: template_verification_key(state, row)?,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

async fn template_or_throw(state: &AppState, id: &str) -> Result<JwtTemplateRow> {
    sqlx::query_as::<_, JwtTemplateRow>("SELECT * FROM jwt_templates WHERE id = $1")
        .bind(id)
        .fetch_optional(&state.pool)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "JWT template not found.")
        })
}

fn validate_name(name: &str) -> Result<()> {
    if name.is_empty()
        || name.chars().count() > 64
        || !name
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '-' || ch == '_')
    {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "name may only contain letters, digits, '-' and '_'",
        )
        .with_meta(json!({ "param_name": "name" })));
    }
    Ok(())
}

fn validate_lifetime(lifetime: i64) -> Result<()> {
    if !(30..=315_360_000).contains(&lifetime) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "lifetime must be between 30 and 315360000",
        )
        .with_meta(json!({ "param_name": "lifetime" })));
    }
    Ok(())
}

fn validate_skew(skew: i64) -> Result<()> {
    if !(0..=300).contains(&skew) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "allowed_clock_skew must be between 0 and 300",
        )
        .with_meta(json!({ "param_name": "allowed_clock_skew" })));
    }
    Ok(())
}

fn validate_algorithm(algorithm: &str) -> Result<()> {
    if !SIGNING_ALGORITHMS.contains(&algorithm) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "signing_algorithm must be RS256, ES256 or HS256",
        )
        .with_meta(json!({ "param_name": "signing_algorithm" })));
    }
    Ok(())
}

async fn list(State(state): State<AppState>, query: QueryPairs) -> Result<Response> {
    let list = query.list()?;
    let rows: Vec<JwtTemplateRow> = fetch_all(
        &state.pool,
        "SELECT * FROM jwt_templates ORDER BY created_at ASC LIMIT $1 OFFSET $2",
        &[Bind::Int(list.limit), Bind::Int(list.offset)],
    )
    .await?;
    let total = fetch_count(&state.pool, "SELECT count(*) FROM jwt_templates", &[]).await?;
    let data = rows
        .iter()
        .map(|row| serialize_template(&state, row))
        .map(|result| result.and_then(to_value))
        .collect::<Result<Vec<_>>>()?;
    Ok(json_response(paginated(
        serde_json::Value::Array(data),
        total,
    )))
}

async fn read(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let row = template_or_throw(&state, &id).await?;
    Ok(json_response(to_value(serialize_template(&state, &row)?)?))
}

#[derive(Debug, Deserialize)]
struct CreateBody {
    name: String,
    #[serde(default)]
    claims: Option<Metadata>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    lifetime: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    allowed_clock_skew: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_bool")]
    custom_signing_key: bool,
    signing_algorithm: Option<String>,
}

async fn create(
    State(state): State<AppState>,
    OrbitJson(body): OrbitJson<CreateBody>,
) -> Result<Response> {
    let claims = body.claims.unwrap_or_default();
    if !claims.is_empty() {
        validate_metadata(&claims)?;
    }
    validate_name(&body.name)?;
    let lifetime = body.lifetime.unwrap_or(60);
    validate_lifetime(lifetime)?;
    let skew = body.allowed_clock_skew.unwrap_or(5);
    validate_skew(skew)?;
    let algorithm = body
        .signing_algorithm
        .clone()
        .unwrap_or_else(|| "RS256".to_string());
    validate_algorithm(&algorithm)?;
    assert_allowed_claims(&claims)?;
    let now_ms = now();
    let signing_key_enc = if body.custom_signing_key {
        Some(generate_template_signing_key(&state, &algorithm).await?)
    } else {
        None
    };
    let row = {
        // Name uniqueness: the table has a unique constraint, and the advisory
        // lock makes the pre-check and the insert one atomic decision.
        let mut tx = state.pool.begin().await?;
        orbitid_identity::lookups_bapi::lock_jwt_template_name_on(&mut tx, &body.name).await?;
        let taken: Option<String> =
            sqlx::query_scalar("SELECT id FROM jwt_templates WHERE name = $1")
                .bind(&body.name)
                .fetch_optional(&mut *tx)
                .await?;
        if taken.is_some() {
            return Err(OrbitError::unprocessable(
                error_codes::DUPLICATE_RECORD,
                "A JWT template with this name already exists.",
            )
            .with_meta(json!({ "param_name": "name" })));
        }
        let row: JwtTemplateRow = sqlx::query_as(
            "INSERT INTO jwt_templates (id, name, claims, lifetime, allowed_clock_skew, \
             custom_signing_key, signing_algorithm, signing_key_enc, created_at, updated_at) \
             VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$9) RETURNING *",
        )
        .bind(new_id(id_prefix::JWT_TEMPLATE))
        .bind(&body.name)
        .bind(sqlx::types::Json(claims))
        .bind(lifetime)
        .bind(skew)
        .bind(body.custom_signing_key)
        .bind(&algorithm)
        .bind(&signing_key_enc)
        .bind(now_ms)
        .fetch_one(&mut *tx)
        .await?;
        tx.commit().await?;
        row
    };
    audit(
        &state,
        AuditInput::new("jwt_template.created")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("jwt_template")
            .target_id(row.id.clone())
            .metadata(json!({ "name": row.name })),
    )
    .await;
    Ok(json_response(to_value(serialize_template(&state, &row)?)?))
}

#[derive(Debug, Deserialize)]
struct UpdateBody {
    name: Option<String>,
    claims: Option<Metadata>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    lifetime: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_int")]
    allowed_clock_skew: Option<i64>,
    #[serde(default, deserialize_with = "deserialize_opt_bool")]
    custom_signing_key: Option<bool>,
    signing_algorithm: Option<String>,
}

async fn update(
    State(state): State<AppState>,
    Path(id): Path<String>,
    OrbitJson(body): OrbitJson<UpdateBody>,
) -> Result<Response> {
    let existing = template_or_throw(&state, &id).await?;
    if let Some(claims) = &body.claims {
        validate_metadata(claims)?;
        assert_allowed_claims(claims)?;
    }
    if let Some(name) = &body.name {
        validate_name(name)?;
    }
    if let Some(lifetime) = body.lifetime {
        validate_lifetime(lifetime)?;
    }
    if let Some(skew) = body.allowed_clock_skew {
        validate_skew(skew)?;
    }
    if let Some(algorithm) = &body.signing_algorithm {
        validate_algorithm(algorithm)?;
    }

    let algorithm = body
        .signing_algorithm
        .clone()
        .unwrap_or_else(|| existing.signing_algorithm.clone());
    let custom_key = body
        .custom_signing_key
        .unwrap_or(existing.custom_signing_key);
    let needs_key =
        custom_key && (existing.signing_key_enc.is_none() || body.signing_algorithm.is_some());
    let new_key_enc = if needs_key {
        Some(generate_template_signing_key(&state, &algorithm).await?)
    } else if !custom_key {
        None
    } else {
        existing.signing_key_enc.clone()
    };

    let updated = {
        let mut tx = state.pool.begin().await?;
        let current = sqlx::query_as::<_, JwtTemplateRow>(
            "SELECT * FROM jwt_templates WHERE id = $1 FOR UPDATE",
        )
        .bind(&existing.id)
        .fetch_optional(&mut *tx)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(error_codes::RESOURCE_NOT_FOUND, "JWT template not found.")
        })?;
        if let Some(name) = &body.name {
            orbitid_identity::lookups_bapi::lock_jwt_template_name_on(&mut tx, name).await?;
            if name != &current.name {
                let taken: Option<String> =
                    sqlx::query_scalar("SELECT id FROM jwt_templates WHERE name = $1")
                        .bind(name)
                        .fetch_optional(&mut *tx)
                        .await?;
                if taken.is_some() {
                    return Err(OrbitError::unprocessable(
                        error_codes::DUPLICATE_RECORD,
                        "A JWT template with this name already exists.",
                    )
                    .with_meta(json!({ "param_name": "name" })));
                }
            }
        }
        let mut builder: QueryBuilder<sqlx::Postgres> =
            QueryBuilder::new("UPDATE jwt_templates SET updated_at = ");
        builder.push_bind(now());
        if let Some(name) = &body.name {
            builder.push(", name = ");
            builder.push_bind(name.clone());
        }
        if let Some(claims) = &body.claims {
            builder.push(", claims = ");
            builder.push_bind(sqlx::types::Json(claims.clone()));
        }
        if let Some(lifetime) = body.lifetime {
            builder.push(", lifetime = ");
            builder.push_bind(lifetime);
        }
        if let Some(skew) = body.allowed_clock_skew {
            builder.push(", allowed_clock_skew = ");
            builder.push_bind(skew);
        }
        if let Some(algorithm) = &body.signing_algorithm {
            builder.push(", signing_algorithm = ");
            builder.push_bind(algorithm.clone());
        }
        if let Some(custom) = body.custom_signing_key {
            builder.push(", custom_signing_key = ");
            builder.push_bind(custom);
        }
        if body.custom_signing_key.is_some() || needs_key {
            builder.push(", signing_key_enc = ");
            builder.push_bind(new_key_enc.clone());
        }
        builder.push(" WHERE id = ");
        builder.push_bind(&current.id);
        builder.build().execute(&mut *tx).await?;
        let updated =
            sqlx::query_as::<_, JwtTemplateRow>("SELECT * FROM jwt_templates WHERE id = $1")
                .bind(&current.id)
                .fetch_one(&mut *tx)
                .await?;
        tx.commit().await?;
        updated
    };

    audit(
        &state,
        AuditInput::new("jwt_template.updated")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("jwt_template")
            .target_id(updated.id.clone())
            .metadata(json!({ "name": updated.name })),
    )
    .await;
    Ok(json_response(to_value(serialize_template(
        &state, &updated,
    )?)?))
}

async fn remove(State(state): State<AppState>, Path(id): Path<String>) -> Result<Response> {
    let existing = template_or_throw(&state, &id).await?;
    sqlx::query("DELETE FROM jwt_templates WHERE id = $1")
        .bind(&existing.id)
        .execute(&state.pool)
        .await?;
    audit(
        &state,
        AuditInput::new("jwt_template.deleted")
            .actor(orbitid_identity::admin::AUDIT_ACTOR)
            .target_type("jwt_template")
            .target_id(existing.id.clone())
            .metadata(json!({ "name": existing.name })),
    )
    .await;
    Ok(json_response(deleted_object("jwt_template", &existing.id)))
}
