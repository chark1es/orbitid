//! JSON Lines import (`services/transfer/import.ts`).
//!
//! The whole import runs in one transaction: a malformed line, a constraint
//! failure or a count mismatch rolls it back and leaves the target untouched.
//! Rows are inserted through `jsonb_populate_recordset`, so the document can
//! carry the table's columns in any order without a generated SQL statement per
//! column.

use orbitid_core::crypto::decrypt;
use serde_json::Value;
use sqlx::PgPool;
use std::collections::{BTreeMap, HashMap, HashSet};
use tokio::io::{AsyncBufReadExt, AsyncRead, BufReader};

use super::import_batch::{export_predates, flush_batch, ColumnInfo};
use super::tables::{db, quote, schema, Dependencies};
use super::{
    TransferResult, BOOTSTRAP_TABLES, CANARY_PREFIX, EXPORT_FORMAT, INSERT_BATCH, RUST_ONLY_TABLES,
    SKIPPED_TABLES,
};

#[derive(Debug, serde::Serialize)]
pub struct ImportCount {
    pub table: String,
    pub imported: i64,
    pub target: i64,
    pub expected: i64,
    pub ok: bool,
}

#[derive(Debug)]
pub struct ImportResult {
    pub counts: Vec<ImportCount>,
    pub ok: bool,
}

pub(super) async fn run(
    pool: &PgPool,
    input: &str,
    encryption_key: &str,
    truncate: bool,
    progress: &dyn Fn(&str),
) -> TransferResult<ImportResult> {
    import_into(pool, input, encryption_key, truncate, progress).await
}

struct Reader {
    lines: tokio::io::Lines<BufReader<Box<dyn AsyncRead + Unpin + Send>>>,
}

impl Reader {
    async fn open(input: &str) -> TransferResult<Self> {
        let source: Box<dyn AsyncRead + Unpin + Send> = if input == "-" {
            Box::new(tokio::io::stdin())
        } else {
            Box::new(
                tokio::fs::File::open(std::path::Path::new(input))
                    .await
                    .map_err(|error| error.to_string())?,
            )
        };
        Ok(Self {
            lines: BufReader::new(source).lines(),
        })
    }

    async fn next(&mut self) -> TransferResult<Option<String>> {
        self.lines
            .next_line()
            .await
            .map_err(|error| error.to_string())
    }
}

async fn import_into(
    pool: &PgPool,
    input: &str,
    encryption_key: &str,
    truncate: bool,
    progress: &dyn Fn(&str),
) -> TransferResult<ImportResult> {
    let (all, dependencies) = schema(pool).await?;
    let mut reader = Reader::open(input).await?;
    let mut header: Option<Value> = None;
    let mut order: Vec<String> = Vec::new();
    let mut imported: BTreeMap<String, i64> = BTreeMap::new();
    let mut batch_table: Option<String> = None;
    let mut batch: Vec<Value> = Vec::new();
    let mut last_position = 0usize;
    // Column metadata is read once per table: old exports (in particular from
    // the TypeScript server) predate columns that now have a default.
    let mut columns: HashMap<String, Vec<ColumnInfo>> = HashMap::new();

    // An import target is never a fresh instance: claim it first, in its own
    // committed transaction (claim lock first, holding nothing else), so owner
    // setup cannot open on a restore without accounts, and a failed import
    // cannot leave the instance unclaimed either.
    claim_target(pool).await?;
    let mut tx = pool.begin().await.map_err(db)?;
    loop {
        let Some(line) = reader.next().await? else {
            break;
        };
        if line.trim().is_empty() {
            continue;
        }
        let parsed: Value = serde_json::from_str(&line)
            .map_err(|_| "The input is not JSON Lines: a line could not be parsed".to_string())?;
        if header.is_none() {
            validate_header(
                &parsed,
                &all,
                &dependencies,
                encryption_key,
                truncate,
                &mut tx,
            )
            .await?;
            header = Some(parsed.clone());
            order = parsed["tables"]
                .as_array()
                .map(|tables| {
                    tables
                        .iter()
                        .filter_map(|value| value.as_str().map(str::to_string))
                        .collect()
                })
                .unwrap_or_default();
            progress(if truncate {
                "Clearing the target database"
            } else {
                "Clearing bootstrap rows (instance settings, seeded roles)"
            });
            continue;
        }
        let table = parsed["t"]
            .as_str()
            .ok_or_else(|| "Invalid row: missing table".to_string())?
            .to_string();
        let position = order
            .iter()
            .position(|name| name == &table)
            .ok_or_else(|| {
                format!("Row for table {table}, which the export header did not list")
            })?;
        if position < last_position {
            return Err(format!(
                "Rows for {table} appear after rows for a table that depends on it; the export is out of order"
            ));
        }
        last_position = position;
        let row = parsed["r"].clone();
        if batch_table.as_deref() != Some(table.as_str()) {
            flush_batch(
                &mut tx,
                batch_table.take(),
                &mut batch,
                &mut imported,
                &mut columns,
            )
            .await?;
            batch_table = Some(table.clone());
        }
        batch.push(row);
        if batch.len() >= INSERT_BATCH {
            flush_batch(
                &mut tx,
                batch_table.take(),
                &mut batch,
                &mut imported,
                &mut columns,
            )
            .await?;
        }
    }
    flush_batch(
        &mut tx,
        batch_table.take(),
        &mut batch,
        &mut imported,
        &mut columns,
    )
    .await?;
    drop(reader);

    // A replica may have published the settings revision it read before the
    // import. Bumping the revision guarantees the imported settings are newer
    // than any revision this process (or another replica) could still hold, so
    // the next `LISTEN/NOTIFY` refresh cannot be ignored as stale.
    sqlx::query("UPDATE instance SET revision = revision + 1")
        .execute(&mut *tx)
        .await
        .map_err(db)?;

    let header = header.ok_or_else(|| {
        "The input is empty: expected a JSON Lines export header on the first line".to_string()
    })?;
    let promised = header["counts"].as_object().cloned().unwrap_or_default();

    let mut counts = Vec::new();
    let mut ok = true;
    for table in &order {
        let target = count_rows_in(&mut tx, table).await?;
        let count = imported.get(table).copied().unwrap_or(0);
        let expected = promised.get(table).and_then(Value::as_i64).unwrap_or(count);
        let matches = target == count && target == expected;
        ok &= matches;
        counts.push(ImportCount {
            table: table.clone(),
            imported: count,
            target,
            expected,
            ok: matches,
        });
        progress(&format!(
            "Imported {table}: {count} row{}",
            if count == 1 { "" } else { "s" }
        ));
    }
    if !ok {
        let problems: Vec<String> = counts
            .iter()
            .filter(|count| !count.ok)
            .map(|count| {
                format!(
                    "{}: the export promised {}, imported {}, target has {}",
                    count.table, count.expected, count.imported, count.target
                )
            })
            .collect();
        return Err(format!(
            "Row count verification failed after importing {} tables: {}",
            order.len(),
            problems.join("; ")
        ));
    }
    // From here the server decides the outcome; a copy interrupt is ignored.
    super::COMMITTING.store(true, std::sync::atomic::Ordering::SeqCst);
    tx.commit().await.map_err(db)?;
    Ok(ImportResult { counts, ok })
}

/// Marks the target claimed (dashboard owner setup closed) before any import
/// work starts, in its own transaction. Mirrors `orbitid_identity::console::claim_on`.
async fn claim_target(pool: &PgPool) -> TransferResult<()> {
    let mut tx = pool.begin().await.map_err(db)?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext('orbitid_owner_setup')::bigint)")
        .execute(&mut *tx)
        .await
        .map_err(db)?;
    sqlx::query(
        "INSERT INTO console_owner_setup (id, claimed_at) \
         VALUES ('default', (extract(epoch FROM clock_timestamp()) * 1000)::bigint) \
         ON CONFLICT (id) DO NOTHING",
    )
    .execute(&mut *tx)
    .await
    .map_err(db)?;
    tx.commit().await.map_err(db)?;
    Ok(())
}

async fn validate_header(
    header: &Value,
    all: &[String],
    dependencies: &Dependencies,
    encryption_key: &str,
    truncate: bool,
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
) -> TransferResult<()> {
    if header["orbitid_export"].as_i64() != Some(EXPORT_FORMAT) {
        return Err("Invalid export header: orbitid_export must be 1".into());
    }
    if header["dialect"].as_str() != Some("postgres") {
        return Err("Invalid export header: only a postgres export can be imported (SQLite/PGlite support was dropped)".into());
    }
    let key_check = header["key_check"]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| "Invalid export header: key_check is required".to_string())?;
    let opened = decrypt(encryption_key, key_check).map_err(|_| {
        "The export was made with a different ORBITID_ENCRYPTION_KEY, so stored secrets (signing keys, TOTP secrets, OAuth tokens) could not be read. Run the import with the same key the source instance used.".to_string()
    })?;
    if !opened.starts_with(CANARY_PREFIX) {
        return Err("The export was made with a different ORBITID_ENCRYPTION_KEY".into());
    }
    let tables: Vec<String> = header["tables"]
        .as_array()
        .ok_or_else(|| "Invalid export header: tables is required".to_string())?
        .iter()
        .filter_map(|value| value.as_str().map(str::to_string))
        .collect();
    if tables.is_empty() {
        return Err("Invalid export header: tables must list at least one table".into());
    }
    let known: HashSet<&str> = all.iter().map(String::as_str).collect();
    let unknown: Vec<&String> = tables
        .iter()
        .filter(|table| {
            !known.contains(table.as_str()) && !RUST_ONLY_TABLES.contains(&table.as_str())
        })
        .collect();
    if !unknown.is_empty() {
        let names: Vec<&str> = unknown.iter().map(|name| name.as_str()).collect();
        return Err(format!(
            "The export contains tables this version does not know: {}",
            names.join(", ")
        ));
    }
    let excluded: Vec<&String> = tables
        .iter()
        .filter(|table| SKIPPED_TABLES.contains(&table.as_str()))
        .collect();
    if !excluded.is_empty() {
        let names: Vec<&str> = excluded.iter().map(|name| name.as_str()).collect();
        return Err(format!(
            "The export contains excluded tables that cannot be imported: {}",
            names.join(", ")
        ));
    }
    if tables.iter().collect::<HashSet<_>>().len() != tables.len() {
        return Err("The export header lists a table twice".into());
    }
    let listed: HashSet<&str> = tables.iter().map(String::as_str).collect();
    let absent: Vec<&String> = all
        .iter()
        .filter(|table| {
            !listed.contains(table.as_str())
                && !RUST_ONLY_TABLES.contains(&table.as_str())
                && !export_predates(table, header["schema_version"].as_str().unwrap_or(""))
        })
        .collect();
    if !absent.is_empty() {
        let names: Vec<&str> = absent.iter().map(|name| name.as_str()).collect();
        return Err(format!(
            "The export is incomplete: it does not list {}. Importing it would leave those tables empty. Use a complete export.",
            names.join(", ")
        ));
    }
    for table in &tables {
        if !header["counts"]
            .get(table)
            .is_some_and(|value| value.is_i64() || value.is_u64())
        {
            return Err(format!(
                "The export header has no row count for {table}, so it cannot be verified"
            ));
        }
    }
    assert_dependency_order(&tables, all, dependencies)?;

    if truncate {
        let mut ordered = all.to_vec();
        ordered.reverse();
        for table in &ordered {
            let sql = format!("TRUNCATE TABLE \"{}\" CASCADE", quote(table));
            sqlx::query(&sql).execute(&mut **tx).await.map_err(db)?;
        }
    } else {
        let occupied = occupied_tables(tx, all).await?;
        if !occupied.is_empty() {
            let summary = occupied
                .iter()
                .map(|(table, rows)| format!("{table} ({rows})"))
                .collect::<Vec<_>>()
                .join(", ");
            return Err(format!(
                "The target database already contains data: {summary}. Pass --truncate --yes to replace it."
            ));
        }
        for table in &tables {
            if BOOTSTRAP_TABLES.contains(&table.as_str()) {
                let sql = format!("DELETE FROM \"{}\"", quote(table));
                sqlx::query(&sql).execute(&mut **tx).await.map_err(db)?;
            }
        }
    }
    Ok(())
}

/// Checks the header's table order against the *actual* foreign keys.
///
/// Any valid topological order is acceptable: two exporters with different
/// table-discovery orders (the retired TypeScript server walked its schema
/// declaration order, this port walks the database's physical order) may
/// legitimately list independent tables in different positions, and only the
/// dependencies decide whether rows can be inserted in the header's sequence.
fn assert_dependency_order(
    tables: &[String],
    all: &[String],
    dependencies: &Dependencies,
) -> TransferResult<()> {
    let position: HashMap<&str, usize> = tables
        .iter()
        .enumerate()
        .map(|(index, table)| (table.as_str(), index))
        .collect();
    let known: HashSet<&str> = all.iter().map(String::as_str).collect();
    for (index, table) in tables.iter().enumerate() {
        let Some(parents) = dependencies.get(table) else {
            continue;
        };
        for parent in parents {
            // A self-reference is satisfied by the batch insert itself: the
            // whole table is written in statements whose immediate foreign-key
            // check runs at the end of each statement, so it needs no table
            // ordering.
            if parent == table || !known.contains(parent.as_str()) {
                continue;
            }
            let Some(parent_index) = position.get(parent.as_str()).copied() else {
                // The completeness check above already rejects a missing table
                // unless the export is old enough to predate it.
                continue;
            };
            if parent_index >= index {
                return Err(format!(
                    "The export lists {table} before {parent}, a table it references; use a newer export or re-export from this version"
                ));
            }
        }
    }
    Ok(())
}

async fn occupied_tables(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    all: &[String],
) -> TransferResult<Vec<(String, i64)>> {
    let mut occupied = Vec::new();
    for table in all {
        if BOOTSTRAP_TABLES.contains(&table.as_str()) || RUST_ONLY_TABLES.contains(&table.as_str())
        {
            continue;
        }
        let rows = count_rows_in(tx, table).await?;
        if rows > 0 {
            occupied.push((table.clone(), rows));
        }
    }
    Ok(occupied)
}

async fn count_rows_in(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    table: &str,
) -> TransferResult<i64> {
    let sql = format!("SELECT count(*)::bigint FROM \"{}\"", quote(table));
    sqlx::query_scalar(&sql)
        .fetch_one(&mut **tx)
        .await
        .map_err(db)
}
