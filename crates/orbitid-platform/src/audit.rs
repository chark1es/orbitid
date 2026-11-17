//! Audit log persistence for Backend API mutations (`GET /v1/audit_logs`).
//!
//! Ported from the retired TypeScript server. Auditing must never break
//! the mutation it describes, so [`audit`] never fails and never logs metadata.

use orbitid_core::db::helpers::starts_with_pattern;
use orbitid_core::error::Result;
use orbitid_core::ids::{id_prefix, new_id};
use orbitid_core::models::AuditLogRow;
use orbitid_core::resources::{AuditLogJson, Metadata, PaginatedList};
use orbitid_core::state::AppState;
use serde_json::Value;

/// Who performed the action and what happened. `actor` is the secret-key holder
/// (`sk_...`), a user id, or `system`.
#[derive(Debug, Clone, Default)]
pub struct AuditInput {
    pub actor: Option<String>,
    pub action: String,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub metadata: Metadata,
    pub ip: Option<String>,
}

impl AuditInput {
    pub fn new(action: impl Into<String>) -> Self {
        Self {
            action: action.into(),
            ..Self::default()
        }
    }

    pub fn actor(mut self, actor: impl Into<String>) -> Self {
        self.actor = Some(actor.into());
        self
    }

    pub fn target_type(mut self, target_type: impl Into<String>) -> Self {
        self.target_type = Some(target_type.into());
        self
    }

    pub fn target_id(mut self, target_id: impl Into<String>) -> Self {
        self.target_id = Some(target_id.into());
        self
    }

    pub fn ip(mut self, ip: impl Into<String>) -> Self {
        self.ip = Some(ip.into());
        self
    }

    /// Metadata supplied as a JSON object (non-objects are ignored).
    pub fn metadata(mut self, metadata: Value) -> Self {
        self.metadata = metadata.as_object().cloned().unwrap_or_default();
        self
    }
}

/// Appends an audit log entry. Never fails: auditing must not break the mutation.
pub async fn audit(state: &AppState, input: AuditInput) {
    let result = sqlx::query(
        "INSERT INTO audit_logs (id, actor, action, target_type, target_id, metadata, ip, created_at) \
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
    )
    .bind(new_id(id_prefix::AUDIT))
    .bind(input.actor)
    .bind(input.action.clone())
    .bind(input.target_type)
    .bind(input.target_id)
    .bind(sqlx::types::Json(input.metadata))
    .bind(input.ip)
    .bind(orbitid_core::http::now())
    .execute(&state.pool)
    .await;
    if let Err(error) = result {
        // Action only: metadata can carry user data and must not reach the log.
        tracing::error!("[audit] failed to record entry {}: {error}", input.action);
    }
}

pub fn serialize_audit_log(row: &AuditLogRow) -> AuditLogJson {
    AuditLogJson {
        object: "audit_log".to_string(),
        id: row.id.clone(),
        actor: row.actor.clone(),
        action: row.action.clone(),
        target_type: row.target_type.clone(),
        target_id: row.target_id.clone(),
        metadata: row.metadata.0.clone(),
        ip: row.ip.clone(),
        created_at: row.created_at,
    }
}

/// Filters for `GET /v1/audit_logs`.
#[derive(Debug, Clone, Default)]
pub struct AuditLogFilters {
    pub limit: i64,
    pub offset: i64,
    /// `created_at` (ascending) or `-created_at` (descending, default).
    pub order_by: Option<String>,
    pub actor: Option<String>,
    /// Exact action, or a prefix pattern ending in `*` (`user.*`).
    pub action: Option<String>,
    pub target_type: Option<String>,
    pub target_id: Option<String>,
    pub after: Option<i64>,
    pub before: Option<i64>,
}

#[derive(Clone)]
enum Bind {
    Text(String),
    Int(i64),
}

fn placeholder(binds: &mut Vec<Bind>, bind: Bind) -> String {
    binds.push(bind);
    format!("${}", binds.len())
}

fn where_clause(filters: &AuditLogFilters) -> (String, Vec<Bind>) {
    let mut conditions: Vec<String> = Vec::new();
    let mut binds: Vec<Bind> = Vec::new();
    if let Some(actor) = &filters.actor {
        let slot = placeholder(&mut binds, Bind::Text(actor.clone()));
        conditions.push(format!("actor = {slot}"));
    }
    if let Some(action) = &filters.action {
        match action.strip_suffix('*') {
            Some(prefix) => {
                let slot = placeholder(&mut binds, Bind::Text(starts_with_pattern(prefix)));
                conditions.push(format!("lower(action) LIKE {slot} ESCAPE '\\'"));
            }
            None => {
                let slot = placeholder(&mut binds, Bind::Text(action.clone()));
                conditions.push(format!("action = {slot}"));
            }
        }
    }
    if let Some(target_type) = &filters.target_type {
        let slot = placeholder(&mut binds, Bind::Text(target_type.clone()));
        conditions.push(format!("target_type = {slot}"));
    }
    if let Some(target_id) = &filters.target_id {
        let slot = placeholder(&mut binds, Bind::Text(target_id.clone()));
        conditions.push(format!("target_id = {slot}"));
    }
    if let Some(after) = filters.after {
        let slot = placeholder(&mut binds, Bind::Int(after));
        conditions.push(format!("created_at >= {slot}"));
    }
    if let Some(before) = filters.before {
        let slot = placeholder(&mut binds, Bind::Int(before));
        conditions.push(format!("created_at <= {slot}"));
    }
    let clause = if conditions.is_empty() {
        String::new()
    } else {
        format!(" WHERE {}", conditions.join(" AND "))
    };
    (clause, binds)
}

/// Paginated audit log listing, newest first unless `order_by == "created_at"`.
pub async fn list_audit_logs(
    state: &AppState,
    filters: &AuditLogFilters,
) -> Result<PaginatedList<AuditLogJson>> {
    let (where_sql, binds) = where_clause(filters);
    let order = if filters.order_by.as_deref() == Some("created_at") {
        "ASC"
    } else {
        "DESC"
    };
    let limit_slot = binds.len() + 1;
    let offset_slot = binds.len() + 2;
    let sql = format!(
        "SELECT id, actor, action, target_type, target_id, metadata, ip, created_at \
         FROM audit_logs{where_sql} ORDER BY created_at {order}, id {order} \
         LIMIT ${limit_slot} OFFSET ${offset_slot}"
    );
    let mut query = sqlx::query_as::<_, AuditLogRow>(&sql);
    for bind in &binds {
        query = match bind {
            Bind::Text(value) => query.bind(value.clone()),
            Bind::Int(value) => query.bind(*value),
        };
    }
    let rows = query
        .bind(filters.limit.max(0))
        .bind(filters.offset.max(0))
        .fetch_all(&state.pool)
        .await?;

    let count_sql = format!("SELECT count(*) FROM audit_logs{where_sql}");
    let mut count_query = sqlx::query_scalar::<_, i64>(&count_sql);
    for bind in &binds {
        count_query = match bind {
            Bind::Text(value) => count_query.bind(value.clone()),
            Bind::Int(value) => count_query.bind(*value),
        };
    }
    let total: i64 = count_query.fetch_one(&state.pool).await?;

    Ok(PaginatedList {
        data: rows.iter().map(serialize_audit_log).collect(),
        total_count: total,
    })
}
