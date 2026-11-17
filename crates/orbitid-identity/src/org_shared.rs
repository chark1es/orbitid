//! Shared organization request/domain helpers, ported from
//! `modules/orgs/shared.ts`.
//!
//! Nothing here touches an HTTP response: list paging/sorting return plain
//! values and middleware-style guards return `OrbitError`s, so both the
//! Frontend and Backend API crates can build their own responses.

use std::collections::HashMap;

use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::{OrganizationMembershipRow, OrganizationRow};
use orbitid_core::resources::Metadata;
use orbitid_core::state::AppState;
use serde_json::Value;
use unicode_normalization::UnicodeNormalization;

use crate::rbac::permissions_for_role;

const RESERVED_SLUGS: &[&str] = &[
    "api",
    "app",
    "admin",
    "dashboard",
    "www",
    "sign_in",
    "sign_up",
    "oauth",
    "organizations",
    "users",
    "sessions",
    "environment",
    "oidc",
    "jwks",
    "health",
];

pub fn require_organizations_enabled(state: &AppState) -> Result<()> {
    if !state.settings.get().organizations.enabled {
        return Err(OrbitError::forbidden(
            error_codes::ORGANIZATIONS_DISABLED,
            "Organizations are not enabled for this instance",
        ));
    }
    Ok(())
}

pub fn require_domains_enabled(state: &AppState) -> Result<()> {
    if !state.settings.get().organizations.domains_enabled {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Organization domains are not enabled for this instance",
        ));
    }
    Ok(())
}

pub fn require_membership_requests_enabled(state: &AppState) -> Result<()> {
    if !state
        .settings
        .get()
        .organizations
        .membership_requests_enabled
    {
        return Err(OrbitError::forbidden(
            error_codes::NOT_ALLOWED_ACCESS,
            "Organization membership requests are not enabled for this instance",
        ));
    }
    Ok(())
}

pub async fn find_organization(
    state: &AppState,
    id_or_slug: &str,
) -> Result<Option<OrganizationRow>> {
    if id_or_slug.is_empty() {
        return Ok(None);
    }
    if let Some(org) =
        sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE id = $1")
            .bind(id_or_slug)
            .fetch_optional(&state.pool)
            .await?
    {
        return Ok(Some(org));
    }
    Ok(
        sqlx::query_as::<_, OrganizationRow>("SELECT * FROM organizations WHERE slug = $1")
            .bind(id_or_slug.to_lowercase())
            .fetch_optional(&state.pool)
            .await?,
    )
}

pub async fn require_organization(state: &AppState, id_or_slug: &str) -> Result<OrganizationRow> {
    find_organization(state, id_or_slug).await?.ok_or_else(|| {
        OrbitError::not_found(
            error_codes::ORGANIZATION_NOT_FOUND,
            "Organization not found",
        )
    })
}

pub async fn find_membership(
    state: &AppState,
    org_id: &str,
    user_id: &str,
) -> Result<Option<OrganizationMembershipRow>> {
    Ok(sqlx::query_as::<_, OrganizationMembershipRow>(
        "SELECT * FROM organization_memberships WHERE organization_id = $1 AND user_id = $2",
    )
    .bind(org_id)
    .bind(user_id)
    .fetch_optional(&state.pool)
    .await?)
}

pub async fn require_membership(
    state: &AppState,
    org: &OrganizationRow,
    user_id: &str,
    extra: &str,
) -> Result<OrganizationMembershipRow> {
    find_membership(state, &org.id, user_id)
        .await?
        .ok_or_else(|| {
            OrbitError::not_found(
                error_codes::NOT_A_MEMBER_IN_ORGANIZATION,
                format!("You are not a member of this organization{extra}"),
            )
        })
}

/// Guard result for organization routes: membership plus its permissions.
#[derive(Debug, Clone)]
pub struct OrgAccess {
    pub org: OrganizationRow,
    pub membership: OrganizationMembershipRow,
    pub permissions: Vec<String>,
}

/// Frontend API guard: organizations enabled, member of `id_or_slug`, and
/// optionally holding `permission`.
pub async fn org_access(
    state: &AppState,
    id_or_slug: &str,
    user_id: &str,
    permission: Option<&str>,
) -> Result<OrgAccess> {
    require_organizations_enabled(state)?;
    let org = require_organization(state, id_or_slug).await?;
    let membership = require_membership(state, &org, user_id, "").await?;
    let permissions = permissions_for_role(state, &membership.role_key).await?;
    if let Some(permission) = permission {
        crate::rbac::assert_permission(&membership, &permissions, permission)?;
    }
    Ok(OrgAccess {
        org,
        membership,
        permissions,
    })
}

fn slug_re_match(slug: &str) -> bool {
    let bytes = slug.as_bytes();
    if bytes.is_empty() || bytes.len() > 50 {
        return false;
    }
    if !(bytes[0].is_ascii_lowercase() || bytes[0].is_ascii_digit()) {
        return false;
    }
    if !(bytes[bytes.len() - 1].is_ascii_lowercase() || bytes[bytes.len() - 1].is_ascii_digit()) {
        return false;
    }
    slug.chars()
        .all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || ch == '-')
}

pub fn slugify(name: &str) -> String {
    let normalized: String = name.nfkd().collect();
    let mut slug = String::new();
    let mut last_dash = false;
    for ch in normalized.chars() {
        let lowered = ch.to_ascii_lowercase();
        if lowered.is_ascii_lowercase() || lowered.is_ascii_digit() {
            slug.push(lowered);
            last_dash = false;
        } else if !last_dash {
            slug.push('-');
            last_dash = true;
        }
    }
    let slug = slug.trim_matches('-');
    let slug: String = slug.chars().take(50).collect();
    if slug.is_empty() {
        "organization".into()
    } else {
        slug
    }
}

pub fn normalize_slug(raw: &str) -> Result<String> {
    let slug = raw.trim().to_lowercase();
    if !slug_re_match(&slug) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_FORMAT_INVALID,
            "Slug must be 1-50 characters of lowercase letters, numbers and single dashes",
        )
        .with_meta(serde_json::json!({ "param_name": "slug" })));
    }
    if RESERVED_SLUGS.contains(&slug.as_str()) {
        return Err(OrbitError::unprocessable(
            error_codes::FORM_PARAM_VALUE_INVALID,
            format!("Slug \"{slug}\" is reserved"),
        )
        .with_meta(serde_json::json!({ "param_name": "slug" })));
    }
    Ok(slug)
}

/// Validates a requested slug (or derives one from the name) and makes it
/// unique by suffixing `-2`, `-3`, ….
pub async fn resolve_slug(
    state: &AppState,
    requested: Option<&str>,
    name: &str,
    exclude_org_id: Option<&str>,
) -> Result<String> {
    let base = match requested {
        Some(requested) => normalize_slug(requested)?,
        None => slugify(name),
    };
    async fn taken(state: &AppState, slug: String, exclude: Option<String>) -> Result<bool> {
        let row: Option<(String, Option<String>)> =
            sqlx::query_as("SELECT id, slug FROM organizations WHERE slug = $1")
                .bind(slug)
                .fetch_optional(&state.pool)
                .await?;
        Ok(row
            .map(|(id, _)| Some(id.as_str()) != exclude.as_deref())
            .unwrap_or(false))
    }
    if requested.is_some() {
        if taken(state, base.clone(), exclude_org_id.map(str::to_string)).await? {
            return Err(OrbitError::conflict(
                error_codes::ORGANIZATION_SLUG_TAKEN,
                format!("Slug \"{base}\" is already taken"),
            )
            .with_meta(serde_json::json!({ "param_name": "slug" })));
        }
        return Ok(base);
    }
    let mut slug = base.clone();
    let mut index = 2;
    while taken(state, slug.clone(), exclude_org_id.map(str::to_string)).await? && index < 1000 {
        slug = format!("{}-{index}", base.chars().take(46).collect::<String>());
        index += 1;
    }
    Ok(slug)
}

/// Maps the unique violation a concurrent slug write hits to the same 409
/// `organization_slug_taken` the TypeScript `resolveSlug` check returns (the
/// pre-transaction check cannot see a row another request is about to insert).
pub fn map_slug_violation(error: sqlx::Error, slug: &str) -> OrbitError {
    let mapped = OrbitError::from(error);
    if mapped.code == error_codes::DUPLICATE_RECORD {
        return OrbitError::conflict(
            error_codes::ORGANIZATION_SLUG_TAKEN,
            format!("Slug \"{slug}\" is already taken"),
        )
        .with_meta(serde_json::json!({ "param_name": "slug" }));
    }
    mapped
}

pub fn deleted_object(object: &str, id: &str) -> Value {
    serde_json::json!({ "object": object, "id": id, "deleted": true })
}

pub fn invitation_url(state: &AppState, ticket: &str) -> String {
    format!(
        "{}/v1/client/organization_invitations/accept?ticket={}",
        state.env.base_url,
        percent_encoding::utf8_percent_encode(ticket, percent_encoding::NON_ALPHANUMERIC)
    )
}

/// Frontend API list query parameters.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ListParams {
    pub limit: i64,
    pub offset: i64,
    pub paginated: bool,
}

impl ListParams {
    /// Reads `limit`, `offset` and `paginated` from a query map. Values are
    /// clamped exactly like the TS helper (`limit` 1..=500, default 10).
    pub fn from_query(query: &HashMap<String, String>) -> Self {
        let raw_limit = query
            .get("limit")
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
            .map(|value| value.trunc() as i64)
            .unwrap_or(10);
        let raw_offset = query
            .get("offset")
            .and_then(|value| value.parse::<f64>().ok())
            .filter(|value| value.is_finite())
            .map(|value| value.trunc() as i64)
            .unwrap_or(0);
        Self {
            limit: raw_limit.clamp(1, 500),
            offset: raw_offset.max(0),
            paginated: query
                .get("paginated")
                .map(|value| value == "true")
                .unwrap_or(false),
        }
    }
}

/// Slices rows for `?offset`/`?limit` and returns the page plus the total.
pub fn page<T: Clone>(rows: &[T], params: ListParams) -> (Vec<T>, i64) {
    let total = rows.len() as i64;
    let start = params.offset.max(0) as usize;
    let end = start.saturating_add(params.limit.max(0) as usize);
    let items = if start >= rows.len() {
        Vec::new()
    } else {
        rows[start..end.min(rows.len())].to_vec()
    };
    (items, total)
}

/// Sorts rows by `?order_by=field|-field|+field`. Unknown fields keep the
/// existing order.
pub fn sort_rows<T: Clone, F>(rows: &mut [T], order_by: Option<&str>, columns: F)
where
    F: Fn(&T, &str) -> Option<Value>,
{
    let Some(order_by) = order_by else {
        return;
    };
    let descending = order_by.starts_with('-');
    let field = order_by.trim_start_matches(['+', '-']);
    let mut keyed: Vec<(Value, T)> = Vec::with_capacity(rows.len());
    for row in rows.iter() {
        let value = columns(row, field);
        keyed.push((value.unwrap_or(Value::Null), row.clone()));
    }
    if keyed.iter().all(|(value, _)| value.is_null()) {
        return;
    }
    keyed.sort_by(|a, b| {
        let ordering = match (&a.0, &b.0) {
            (Value::Number(a), Value::Number(b)) => a.as_f64().partial_cmp(&b.as_f64()),
            _ => Some(a.0.to_string().cmp(&b.0.to_string())),
        }
        .unwrap_or(std::cmp::Ordering::Equal);
        if descending {
            ordering.reverse()
        } else {
            ordering
        }
    });
    for (slot, (_, row)) in rows.iter_mut().zip(keyed) {
        *slot = row;
    }
}

const PROTOTYPE_KEYS: &[&str] = &["__proto__", "constructor", "prototype"];

/// Deep-merges metadata objects (arrays/scalars replaced, `null` removes the
/// key). Prototype keys are ignored at every level.
pub fn merge_metadata(base: Option<&Metadata>, patch: Option<&Metadata>) -> Metadata {
    let mut out = base.cloned().unwrap_or_default();
    for (key, value) in patch.into_iter().flat_map(|patch| patch.iter()) {
        if PROTOTYPE_KEYS.contains(&key.as_str()) {
            continue;
        }
        if value.is_null() {
            out.remove(key);
            continue;
        }
        let both_objects = value.is_object()
            && out
                .get(key)
                .map(|current| current.is_object())
                .unwrap_or(false);
        if both_objects {
            let current = out
                .get(key)
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default();
            let patch = value.as_object().cloned().unwrap_or_default();
            out.insert(
                key.clone(),
                Value::Object(merge_metadata(Some(&current), Some(&patch))),
            );
        } else {
            out.insert(key.clone(), value.clone());
        }
    }
    out
}
