//! JSON Lines export (`services/transfer/export.ts`).
//!
//! Rows are read through `to_jsonb(t)`, so the document carries exactly the
//! portable values every dialect can consume: numbers stay numbers (timestamps
//! are `bigint` epoch milliseconds), booleans stay booleans and JSONB stays JSON.

use std::path::Path;

use orbitid_core::crypto::{encrypt, random_token};
use serde_json::{json, Value};
use sqlx::PgPool;
use tokio::io::{AsyncWriteExt, BufWriter};

use super::tables::{count_rows, db, quote};
use super::{TransferResult, CANARY_PREFIX, EXPORT_FORMAT, PAGE_SIZE, SCHEMA_VERSION};

#[derive(Debug)]
pub struct ExportResult {
    pub tables: Vec<(String, i64)>,
    pub rows: i64,
}

pub(super) async fn run(
    pool: &PgPool,
    out: &str,
    encryption_key: &str,
    progress: &dyn Fn(&str),
) -> TransferResult<ExportResult> {
    let order = super::tables::table_order(pool).await?;
    let mut writer = Writer::open(out).await?;
    let mut counts: std::collections::BTreeMap<String, i64> = std::collections::BTreeMap::new();
    for table in &order {
        counts.insert(table.clone(), count_rows(pool, table).await?);
    }
    let canary = encrypt(
        encryption_key,
        &format!("{CANARY_PREFIX}{}", random_token(16)),
    )
    .map_err(|error| error.to_string())?;
    writer
        .line(&json!({
            "orbitid_export": EXPORT_FORMAT,
            "dialect": "postgres",
            "schema_version": SCHEMA_VERSION,
            "created_at": orbitid_core::http::now(),
            "key_check": canary,
            "tables": order,
            "counts": counts,
        }))
        .await?;

    let mut result = ExportResult {
        tables: Vec::new(),
        rows: 0,
    };
    for table in &order {
        let sql = format!(
            "SELECT to_jsonb(t) FROM \"{}\" t ORDER BY {} LIMIT $1 OFFSET $2",
            quote(table),
            order_by_clause(pool, table).await?
        );
        let mut offset = 0i64;
        let mut written = 0i64;
        loop {
            let rows: Vec<Value> = sqlx::query_scalar(&sql)
                .bind(PAGE_SIZE)
                .bind(offset)
                .fetch_all(pool)
                .await
                .map_err(db)?;
            if rows.is_empty() {
                break;
            }
            for row in &rows {
                writer.line(&json!({ "t": table, "r": row })).await?;
            }
            written += rows.len() as i64;
            offset += rows.len() as i64;
        }
        if written != counts[table] {
            progress(&format!(
                "Warning: {table} changed during the export ({} counted, {written} written)",
                counts[table]
            ));
        }
        result.rows += written;
        result.tables.push((table.clone(), written));
        progress(&format!(
            "Exported {table}: {written} row{}",
            if written == 1 { "" } else { "s" }
        ));
    }
    writer.finish().await?;
    Ok(result)
}

async fn order_by_clause(pool: &PgPool, table: &str) -> TransferResult<String> {
    // A deterministic order keeps pagination stable; every table has a primary key.
    let columns: Vec<String> = sqlx::query_scalar(
        "SELECT a.attname \
         FROM pg_index i \
         JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey) \
         WHERE i.indrelid = $1::regclass AND i.indisprimary \
         ORDER BY array_position(i.indkey, a.attnum)",
    )
    .bind(table)
    .fetch_all(pool)
    .await
    .map_err(db)?;
    if columns.is_empty() {
        return Err(format!(
            "Table {table} has no primary key, so it cannot be paged safely"
        ));
    }
    Ok(columns
        .iter()
        .map(|column| format!("\"{}\"", quote(column)))
        .collect::<Vec<_>>()
        .join(", "))
}

struct Writer {
    inner: BufWriter<Box<dyn tokio::io::AsyncWrite + Unpin + Send>>,
    close: bool,
}

impl Writer {
    async fn open(path: &str) -> TransferResult<Self> {
        if path == "-" {
            Ok(Self {
                inner: BufWriter::new(Box::new(tokio::io::stdout())),
                close: false,
            })
        } else {
            let file = tokio::fs::File::create(Path::new(path))
                .await
                .map_err(|error| error.to_string())?;
            Ok(Self {
                inner: BufWriter::new(Box::new(file)),
                close: true,
            })
        }
    }

    async fn line(&mut self, value: &Value) -> TransferResult<()> {
        let mut line = serde_json::to_string(value).map_err(|error| error.to_string())?;
        line.push('\n');
        self.inner
            .write_all(line.as_bytes())
            .await
            .map_err(|error| error.to_string())
    }

    async fn finish(mut self) -> TransferResult<()> {
        self.inner
            .flush()
            .await
            .map_err(|error| error.to_string())?;
        if self.close {
            self.inner
                .shutdown()
                .await
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }
}
