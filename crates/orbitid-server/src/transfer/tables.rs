//! Table discovery, counting and identifier quoting for transfers.

use std::collections::{HashMap, HashSet};

use sqlx::PgPool;

use super::{TransferResult, SKIPPED_TABLES};

pub(super) fn db(err: sqlx::Error) -> String {
    err.to_string()
}

/// Foreign-key dependencies per table: child → the tables it references.
pub(super) type Dependencies = HashMap<String, HashSet<String>>;

/// The copied tables and their foreign-key edges, in discovery order.
///
/// Discovery order is deliberately *not* used as a dependency order: the
/// database returns `information_schema.tables` in physical creation order,
/// which differs between a database built by the TypeScript server and one
/// built by this port. Only the edges say what must come first.
pub(super) async fn schema(pool: &PgPool) -> TransferResult<(Vec<String>, Dependencies)> {
    let tables: Vec<String> = sqlx::query_scalar(
        "SELECT table_name FROM information_schema.tables \
         WHERE table_schema = 'public' AND table_type = 'BASE TABLE' \
         AND table_name <> '_sqlx_migrations'",
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;
    let tables: Vec<String> = tables
        .into_iter()
        .filter(|table| !SKIPPED_TABLES.contains(&table.as_str()))
        .collect();
    let edges: Vec<(String, String)> = sqlx::query_as(
        "SELECT c.relname::text, p.relname::text \
         FROM pg_constraint con \
         JOIN pg_class c ON c.oid = con.conrelid \
         JOIN pg_class p ON p.oid = con.confrelid \
         JOIN pg_namespace n ON n.oid = c.relnamespace \
         WHERE con.contype = 'f' AND n.nspname = 'public'",
    )
    .fetch_all(pool)
    .await
    .map_err(db)?;

    let known: HashSet<&str> = tables.iter().map(String::as_str).collect();
    let mut deps: Dependencies = HashMap::new();
    for table in &tables {
        deps.entry(table.clone()).or_default();
    }
    for (child, parent) in edges {
        if known.contains(child.as_str()) && known.contains(parent.as_str()) && child != parent {
            deps.entry(child).or_default().insert(parent);
        }
    }
    Ok((tables, deps))
}

/// Public tables in foreign-key dependency order (parents first).
pub(super) async fn table_order(pool: &PgPool) -> TransferResult<Vec<String>> {
    let (tables, deps) = schema(pool).await?;
    let mut ordered: Vec<String> = Vec::with_capacity(tables.len());
    let mut done: HashSet<String> = HashSet::new();
    while ordered.len() < tables.len() {
        let next = tables
            .iter()
            .find(|table| {
                !done.contains(*table)
                    && deps
                        .get(*table)
                        .is_none_or(|parents| parents.iter().all(|parent| done.contains(parent)))
            })
            .cloned();
        let Some(next) = next else {
            return Err(
                "The schema contains a foreign-key cycle; cannot derive a safe table order".into(),
            );
        };
        ordered.push(next.clone());
        done.insert(next);
    }
    Ok(ordered)
}

pub(super) async fn count_rows(pool: &PgPool, table: &str) -> TransferResult<i64> {
    let sql = format!("SELECT count(*)::bigint FROM \"{}\"", quote(table));
    sqlx::query_scalar(&sql).fetch_one(pool).await.map_err(db)
}

pub(super) fn quote(identifier: &str) -> String {
    identifier.replace('"', "\"\"")
}
