use axum::extract::FromRequestParts;
use axum::http::request::Parts;
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use axum::Json;
use orbitid_core::error::{error_codes, OrbitError, Result};
use serde_json::{json, Value};

pub const DEFAULT_LIMIT: i64 = 10;
/// `?limit` maximum, matching `listSchema`.
pub const MAX_LIMIT: i64 = 500;

/// Raw query pairs, preserving repetition. Hono exposes both the repeated list
/// and the single value; this type keeps the raw pairs so both can be derived.
#[derive(Debug, Clone, Default)]
pub struct QueryPairs(pub Vec<(String, String)>);

impl<S: Send + Sync> FromRequestParts<S> for QueryPairs {
    type Rejection = OrbitError;

    async fn from_request_parts(
        parts: &mut Parts,
        _state: &S,
    ) -> std::result::Result<Self, Self::Rejection> {
        let pairs = parts
            .uri
            .query()
            .map(|query| {
                url::form_urlencoded::parse(query.as_bytes())
                    .map(|(key, value)| (key.into_owned(), value.into_owned()))
                    .collect()
            })
            .unwrap_or_default();
        Ok(Self(pairs))
    }
}

impl QueryPairs {
    /// The first value of `name` (Hono's `c.req.query(name)`).
    pub fn raw(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// Every value of `name`, including comma-separated values inside one
    /// parameter. Trimmed, empty entries dropped, duplicates removed.
    pub fn values(&self, name: &str) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for (key, value) in &self.0 {
            if key != name {
                continue;
            }
            for part in value.split(',') {
                let part = part.trim();
                if !part.is_empty() && !out.iter().any(|existing| existing == part) {
                    out.push(part.to_string());
                }
            }
        }
        out
    }

    /// `?limit`, `?offset` and `?order_by`, rejecting out-of-range values the
    /// way `listSchema` does.
    pub fn list(&self) -> Result<ListQuery> {
        let number = |name: &str, default: i64| -> Result<i64> {
            match self.raw(name) {
                None => Ok(default),
                Some(raw) => raw.parse::<i64>().map_err(|_| {
                    OrbitError::unprocessable(
                        error_codes::FORM_PARAM_FORMAT_INVALID,
                        format!("{name}: expected an integer"),
                    )
                    .with_meta(json!({ "param_name": name }))
                }),
            }
        };
        let limit = number("limit", DEFAULT_LIMIT)?;
        let offset = number("offset", 0)?;
        if !(1..=MAX_LIMIT).contains(&limit) {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "limit: Too big: expected number to be <=500",
            )
            .with_meta(json!({ "param_name": "limit" })));
        }
        if offset < 0 {
            return Err(OrbitError::unprocessable(
                error_codes::FORM_PARAM_FORMAT_INVALID,
                "offset: Too small: expected number to be >=0",
            )
            .with_meta(json!({ "param_name": "offset" })));
        }
        Ok(ListQuery {
            limit,
            offset,
            order_by: self.raw("order_by").map(str::to_string),
        })
    }
}

/// Parsed list parameters.
#[derive(Debug, Clone)]
pub struct ListQuery {
    pub limit: i64,
    pub offset: i64,
    pub order_by: Option<String>,
}

/// `?order_by` over whitelisted columns. Unknown columns fall back to the
/// default spec; a leading `-` sorts descending.
pub fn order_clause(raw: Option<&str>, columns: &[(&str, &str)], fallback: &str) -> String {
    let requested = raw
        .map(|value| value.trim_start_matches(['+', '-']))
        .unwrap_or("");
    let spec = match raw {
        Some(value) if columns.iter().any(|(name, _)| *name == requested) => value,
        _ => fallback,
    };
    let descending = spec.starts_with('-');
    let field = spec.trim_start_matches(['+', '-']);
    let column = columns
        .iter()
        .find(|(name, _)| *name == field)
        .map(|(_, sql)| *sql)
        .unwrap_or("created_at");
    format!("{column} {}", if descending { "DESC" } else { "ASC" })
}

/// `{ data, total_count }`.
pub fn paginated(data: Value, total: i64) -> Value {
    json!({ "data": data, "total_count": total })
}

/// `{ object, id, deleted: true }`.
pub fn deleted_object(object: &str, id: &str) -> Value {
    json!({ "object": object, "id": id, "deleted": true })
}

/// A `Json` response.
pub fn json_response(value: Value) -> Response {
    Json(value).into_response()
}

/// A `Json` response with a non-200 status.
pub fn json_status(status: StatusCode, value: Value) -> Response {
    (status, Json(value)).into_response()
}

/// `serde_json::to_value` with the crate's internal-error mapping.
pub fn to_value<T: serde::Serialize>(value: T) -> Result<Value> {
    serde_json::to_value(value).map_err(|error| OrbitError::internal(error.to_string()))
}

/// Parses `?banned=true` style booleans.
pub use orbitid_identity::admin::parse_bool_query;

/// `email_address` / `phone_number` / `web3_wallet`, inferred from the shape.
pub fn identifier_type(identifier: &str) -> &'static str {
    if identifier.contains('@') {
        return "email_address";
    }
    let mut chars = identifier.chars();
    let phone_like = match chars.next() {
        Some('+') => matches!(chars.next(), Some(first) if first.is_ascii_digit()),
        Some(first) if first.is_ascii_digit() => true,
        _ => false,
    } && identifier
        .chars()
        .filter(|ch| !ch.is_whitespace() && !"()-".contains(*ch))
        .count()
        >= 7
        && identifier
            .chars()
            .all(|ch| ch.is_ascii_digit() || ch == '+' || ch.is_whitespace() || "()-".contains(ch));
    if phone_like {
        "phone_number"
    } else {
        "web3_wallet"
    }
}

// ───────────── metadata ─────────────
