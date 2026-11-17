//! Batch insertion with schema-aware defaults (see `insert_statement`).

use serde_json::Value;
use std::collections::{BTreeMap, HashMap};

use super::tables::{db, quote};
use super::TransferResult;

pub(super) async fn flush_batch(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    table: Option<String>,
    batch: &mut Vec<Value>,
    imported: &mut BTreeMap<String, i64>,
    columns: &mut HashMap<String, Vec<ColumnInfo>>,
) -> TransferResult<()> {
    let Some(table) = table else {
        batch.clear();
        return Ok(());
    };
    if batch.is_empty() {
        return Ok(());
    }
    if !columns.contains_key(&table) {
        columns.insert(table.clone(), table_columns(tx, &table).await?);
    }
    let table_columns = columns
        .get(&table)
        .ok_or_else(|| format!("Column metadata for {table} disappeared during the import"))?;
    let sql = insert_statement(&table, table_columns, batch)?;
    let count = batch.len() as i64;
    let payload = Value::Array(std::mem::take(batch));
    sqlx::query(&sql)
        .bind(sqlx::types::Json(payload))
        .execute(&mut **tx)
        .await
        .map_err(db)?;
    *imported.entry(table).or_insert(0) += count;
    Ok(())
}

/// One column of the target table, as `information_schema` describes it.
#[derive(Debug, Clone)]
pub(super) struct ColumnInfo {
    name: String,
    default: Option<String>,
    not_null: bool,
}

/// Reads the target table's columns once. `column_default` is the SQL
/// expression Postgres would use for an omitted column; keeping it lets the
/// import apply today's defaults to a row from an older export.
async fn table_columns(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    table: &str,
) -> TransferResult<Vec<ColumnInfo>> {
    let rows: Vec<(String, Option<String>, String, String)> = sqlx::query_as(
        "SELECT column_name, column_default, is_nullable, is_generated \
         FROM information_schema.columns \
         WHERE table_schema = 'public' AND table_name = $1 \
         ORDER BY ordinal_position",
    )
    .bind(table)
    .fetch_all(&mut **tx)
    .await
    .map_err(db)?;
    Ok(rows
        .into_iter()
        .filter(|(_, _, _, generated)| generated != "ALWAYS")
        .map(|(name, default, nullable, _)| ColumnInfo {
            name,
            default,
            not_null: nullable == "NO",
        })
        .collect())
}

/// Builds the explicit `INSERT ... SELECT` for a batch.
///
/// `jsonb_populate_recordset` fills an absent JSON key with NULL and does not
/// apply column defaults, which is why an older export (the TypeScript server
/// predates `sign_ins.version`, `sign_ups.version` and `instance.revision`)
/// used to fail on a NOT NULL violation. Every column with a default is
/// therefore wrapped in `COALESCE(r."col", <default>)`. A NOT NULL column with
/// no default must be present in every row; if it is not, the message names the
/// table and column instead of leaking a database constraint error.
fn insert_statement(
    table: &str,
    columns: &[ColumnInfo],
    batch: &[Value],
) -> TransferResult<String> {
    if columns.is_empty() {
        return Err(format!("Table {table} has no columns to import"));
    }
    for column in columns {
        if column.not_null && column.default.is_none() {
            for (index, row) in batch.iter().enumerate() {
                if row.get(&column.name).is_none_or(Value::is_null) {
                    return Err(format!(
                        "Table \"{table}\", row {}: column \"{}\" is NOT NULL and has no database default, so the export must provide it",
                        index + 1,
                        column.name
                    ));
                }
            }
        }
    }
    let names = columns
        .iter()
        .map(|column| format!("\"{}\"", quote(&column.name)))
        .collect::<Vec<_>>()
        .join(", ");
    let values = columns
        .iter()
        .map(|column| match &column.default {
            Some(default) => format!("COALESCE(r.\"{}\", {default})", quote(&column.name)),
            None => format!("r.\"{}\"", quote(&column.name)),
        })
        .collect::<Vec<_>>()
        .join(", ");
    Ok(format!(
        "INSERT INTO \"{}\" ({names}) SELECT {values} \
         FROM jsonb_populate_recordset(NULL::\"{}\", $1) AS r",
        quote(table),
        quote(table)
    ))
}

/// True when an export made at `version` predates a table added later.
pub(super) fn export_predates(table: &str, version: &str) -> bool {
    let added = match table {
        "trusted_devices" | "device_codes" => Some(3),
        "user_roles" => Some(6),
        _ => None,
    };
    let Some(added) = added else {
        return false;
    };
    let mut parts = version.split(':');
    let dialect = parts.next().unwrap_or("");
    let count = parts.next().and_then(|value| value.parse::<i64>().ok());
    matches!(dialect, "postgres" | "sqlite") && count.is_some_and(|count| count < added)
}
