use orbitid_core::error::{error_codes, OrbitError, Result};
use orbitid_core::models::EnterpriseConnectionRow;
use orbitid_core::state::AppState;

pub(super) fn provider_for(protocol: &str, id: &str) -> String {
    format!("enterprise_{protocol}_{id}")
}

pub async fn require_connection(state: &AppState, id: &str) -> Result<EnterpriseConnectionRow> {
    sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT * FROM enterprise_connections WHERE id = $1",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?
    .ok_or_else(|| {
        OrbitError::not_found(
            error_codes::RESOURCE_NOT_FOUND,
            "Enterprise connection not found",
        )
    })
}

pub(super) async fn find_active_connection(
    state: &AppState,
    id: &str,
) -> Result<Option<EnterpriseConnectionRow>> {
    Ok(sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT * FROM enterprise_connections WHERE id = $1 AND active = true",
    )
    .bind(id)
    .fetch_optional(&state.pool)
    .await?)
}

pub(super) async fn find_connection_for_identifier(
    state: &AppState,
    identifier: &str,
) -> Result<Option<EnterpriseConnectionRow>> {
    let value = identifier.trim().to_lowercase();
    if value.is_empty() {
        return Ok(None);
    }
    // Accept an address, a bare domain, a URL or a host:port: TS strips the
    // scheme and everything from the first `:` or `/` after the host.
    let host = value
        .rsplit_once('@')
        .map(|(_, host)| host)
        .unwrap_or(&value);
    let host = host.strip_prefix("https://").unwrap_or(host);
    let host = host.strip_prefix("http://").unwrap_or(host);
    let domain = host
        .split(['/', ':'])
        .next()
        .unwrap_or_default()
        .to_string();
    if domain.is_empty() {
        return Ok(None);
    }
    let rows = sqlx::query_as::<_, EnterpriseConnectionRow>(
        "SELECT * FROM enterprise_connections WHERE active = true ORDER BY created_at ASC",
    )
    .fetch_all(&state.pool)
    .await?;
    Ok(rows.into_iter().find(|connection| {
        let domains: Vec<String> = connection
            .domains
            .0
            .iter()
            .map(|value| value.to_lowercase())
            .collect();
        domains.iter().any(|candidate| candidate == &domain)
            || (connection.allow_subdomains
                && domains
                    .iter()
                    .any(|candidate| domain.ends_with(&format!(".{candidate}"))))
    }))
}
