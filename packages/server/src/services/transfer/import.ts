// Moving an instance's data between the two supported databases (SQLite ↔ Postgres).
//
// The schema is instantiated once per process from a dialect fixed at import time, so a single process
// can never hold both. Every operation here therefore works in exactly one dialect: `export` reads the
// configured database, `import` writes the configured database, and `copy` pipes the first into the
// second through two child processes of the CLI.
//
// The wire format is JSON Lines, one row per line, with portable values only (epoch-ms numbers for
// timestamps, real booleans, JSON for JSON columns). Secrets stay as stored (already hashed or
// encrypted), so password digests, TOTP secrets, passkeys, client token hashes and signing keys survive
// a move unchanged.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createReadStream, createWriteStream, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { asc, count, getTableColumns, sql } from "drizzle-orm";
import { getTableConfig as getPostgresTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as getSqliteTableConfig } from "drizzle-orm/sqlite-core";
import { z } from "zod";
import {
  BOOTSTRAP_TABLES, CANARY_PREFIX, EXPORT_FORMAT, INSERT_BATCH, SKIPPED_TABLES, byDatabaseName, exportPredates, portable,
  schemaVersion, tableConfig, tableEntry, tableOrder,
  type TableColumn, type TableEntry, type TransferProgress,
} from "./shared";
import type { AppContext } from "../../context";
import { dialect, isPostgresUrl, type Dialect } from "../../db/dialect";
import { TABLE_NAMES } from "../../db/define-schema";
import * as schema from "../../db/schema";
import { decrypt, encrypt } from "../../lib/crypto";

const headerSchema = z.object({
  orbitid_export: z.literal(EXPORT_FORMAT),
  dialect: z.enum(["postgres", "sqlite"]),
  schema_version: z.string(),
  created_at: z.number().optional(),
  key_check: z.string().min(1),
  tables: z.array(z.string().min(1)).min(1),
  /** Row count per table at the moment the export started; the import verifies against it. */
  counts: z.record(z.string(), z.number().int().min(0)),
});

const rowSchema = z.object({
  t: z.string().min(1),
  r: z.record(z.string(), z.unknown()),
});

type Header = z.infer<typeof headerSchema>;

export interface ImportOptions {
  /** File path, or `-` for stdin. */
  in: string;
  truncate: boolean;
  /** Confirms the destructive `--truncate`, which replaces everything in the target. */
  yes: boolean;
  progress?: TransferProgress;
}

export interface ImportResult {
  counts: { table: string; imported: number; target: number; expected: number; ok: boolean }[];
  ok: boolean;
}

/** Fails before any write when the header's table order would insert a child before its parent. */
function assertDependencyOrder(order: TableEntry[]): void {
  const position = new Map(order.map((entry, index) => [entry.name, index]));
  for (const entry of order) {
    for (const fk of tableConfig(entry.table).foreignKeys) {
      const parent = tableConfig(fk.reference().foreignTable).name;
      const parentAt = position.get(parent);
      if (parentAt !== undefined && parentAt > position.get(entry.name)!) {
        throw new Error(`The export lists ${entry.name} before ${parent}, which it references; use a newer export or re-export from this version`);
      }
    }
  }
}

export async function countRows(ctx: AppContext, entry: TableEntry): Promise<number> {
  const row = (await ctx.db.select({ n: count() }).from(entry.table as never)) as unknown as { n: number | string }[];
  return Number(row[0]?.n ?? 0);
}

/** Rows the target already holds, ignoring the instance/RBAC rows every fresh database is born with. */
async function occupiedTables(ctx: AppContext): Promise<{ table: string; rows: number }[]> {
  const occupied: { table: string; rows: number }[] = [];
  for (const entry of tableOrder()) {
    if (BOOTSTRAP_TABLES.has(entry.key)) continue;
    const rows = await countRows(ctx, entry);
    if (rows > 0) occupied.push({ table: entry.name, rows });
  }
  return occupied;
}

async function deleteAll(ctx: AppContext, order: TableEntry[]): Promise<void> {
  for (const entry of [...order].reverse()) {
    await ctx.db.delete(entry.table as never);
  }
}

/** Every table, including the ephemeral ones, children first; used by `--truncate`. */
function allTables(): TableEntry[] {
  const all = TABLE_NAMES.map(tableEntry);
  const names = new Set(all.map((entry) => entry.name));
  const ordered: TableEntry[] = [];
  const done = new Set<string>();
  while (ordered.length < all.length) {
    const next = all.find((entry) => !done.has(entry.name) && tableConfig(entry.table).foreignKeys
      .map((fk) => tableConfig(fk.reference().foreignTable).name)
      .every((parent) => !names.has(parent) || parent === entry.name || done.has(parent)));
    if (!next) throw new Error("The schema contains a foreign-key cycle; cannot derive a safe table order");
    ordered.push(next);
    done.add(next.name);
  }
  return ordered;
}

/**
 * Writes an export into the configured, freshly migrated database. The header is validated (format,
 * known tables, encryption-key canary) before anything is deleted or written.
 */
/**
 * Everything the import does, the clearing of the target included, happens in one transaction: a malformed line, a
 * constraint failure or a count mismatch rolls the whole thing back and leaves the target exactly as it was.
 * SQLite's driver is synchronous (its transaction callback cannot await), so there the single connection is driven with
 * explicit BEGIN / COMMIT / ROLLBACK.
 */
export async function importDatabase(ctx: AppContext, options: ImportOptions): Promise<ImportResult> {
  if (options.truncate && !options.yes) {
    throw new Error("--truncate deletes everything in the target database. Pass --yes to confirm.");
  }
  if (ctx.database.driver !== "sqlite") {
    return ctx.db.transaction(async (tx) => importInto({ ...ctx, db: tx as unknown as AppContext["db"] }, options));
  }
  const raw = ctx.db as unknown as { run(query: unknown): unknown };
  await raw.run(sql`BEGIN IMMEDIATE`);
  try {
    const result = await importInto(ctx, options);
    await raw.run(sql`COMMIT`);
    return result;
  } catch (error) {
    await raw.run(sql`ROLLBACK`);
    throw error;
  }
}

async function importInto(ctx: AppContext, options: ImportOptions): Promise<ImportResult> {
  const progress = options.progress ?? (() => {});
  if (options.truncate && !options.yes) {
    throw new Error("--truncate deletes everything in the target database. Pass --yes to confirm.");
  }
  const fromStdin = options.in === "-";
  const stream: Readable = fromStdin ? (process.stdin as unknown as Readable) : createReadStream(options.in, { encoding: "utf8" });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  let header: Header | undefined;
  const imported = new Map<string, number>();
  const local = byDatabaseName();
  let order: TableEntry[] = [];

  const ensureHeader = (): Header => {
    if (!header) throw new Error("The input is empty: expected a JSON Lines export header on the first line");
    return header;
  };

  const flush = async (entries: { entry: TableEntry; rows: Record<string, unknown>[] }[]) => {
    for (const { entry, rows } of entries) {
      if (!rows.length) continue;
      await ctx.db.insert(entry.table as never).values(rows as never);
    }
    entries.length = 0;
  };

  let batch: Record<string, unknown>[] = [];
  let batchTable: TableEntry | undefined;
  let pending: { entry: TableEntry; rows: Record<string, unknown>[] }[] = [];
  let lastPosition = 0;

  const flushBatch = async () => {
    if (!batchTable || !batch.length) return;
    pending.push({ entry: batchTable, rows: batch });
    batch = [];
    if (pending.length >= 8) await flush(pending);
  };

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        throw new Error("The input is not JSON Lines: a line could not be parsed");
      }

      if (!header) {
        const check = headerSchema.safeParse(parsed);
        if (!check.success) throw new Error(`Invalid export header: ${check.error.issues.map((issue) => `${issue.path.join(".") || "header"} ${issue.message}`).join("; ")}`);
        header = check.data;
        if (header.dialect === dialect) progress(`Importing a ${header.dialect} export into ${dialect}`);
        else progress(`Converting a ${header.dialect} export into ${dialect}`);
        if (header.schema_version !== schemaVersion()) {
          progress(`Warning: the export comes from schema ${header.schema_version}, the target is ${schemaVersion()}. Columns added since then get their defaults.`);
        }
        try {
          if (!decrypt(ctx.env.encryptionKey, header.key_check).startsWith(CANARY_PREFIX)) throw new Error("wrong canary");
        } catch {
          throw new Error(
            "The export was made with a different ORBITID_ENCRYPTION_KEY, so stored secrets (signing keys, TOTP secrets, OAuth tokens) could not be read. " +
              "Run the import with the same key the source instance used.",
          );
        }
        const unknownTables = header.tables.filter((name) => !local.has(name));
        if (unknownTables.length) throw new Error(`The export contains tables this version does not know: ${unknownTables.join(", ")}`);
        const excluded = header.tables.filter((name) => SKIPPED_TABLES.has(local.get(name)!.key));
        if (excluded.length) throw new Error(`The export contains excluded tables that cannot be imported: ${excluded.join(", ")}`);
        if (new Set(header.tables).size !== header.tables.length) throw new Error("The export header lists a table twice");
        // A replacement import clears every table, so the file has to account for every table it clears. Only tables
        // added in a later release may be absent (an export from an older version cannot contain them).
        const listed = new Set(header.tables);
        const absent = [...local.values()].filter((entry) => !SKIPPED_TABLES.has(entry.key) && !listed.has(entry.name) && !exportPredates(entry.name, header!.schema_version)).map((entry) => entry.name);
        if (absent.length) {
          throw new Error(`The export is incomplete: it does not list ${absent.join(", ")}. Importing it would leave those tables empty. Use a complete export.`);
        }
        const uncounted = header.tables.filter((name) => header!.counts[name] === undefined);
        if (uncounted.length) throw new Error(`The export header has no row count for ${uncounted.join(", ")}, so it cannot be verified`);
        order = header.tables.map((name) => local.get(name)!);
        assertDependencyOrder(order);

        const occupied = await occupiedTables(ctx);
        if (occupied.length && !options.truncate) {
          const summary = occupied.map((item) => `${item.table} (${item.rows})`).join(", ");
          throw new Error(`The target database already contains data: ${summary}. Pass --truncate --yes to replace it.`);
        }
        progress(options.truncate ? "Clearing the target database" : "Clearing bootstrap rows (instance settings, seeded roles)");
        await deleteAll(ctx, options.truncate ? allTables() : order.filter((entry) => BOOTSTRAP_TABLES.has(entry.key)));
        continue;
      }

      const check = rowSchema.safeParse(parsed);
      if (!check.success) throw new Error(`Invalid row on line ${lines.line + 1}: ${check.error.issues[0]?.message ?? "not a row"}`);
      const entry = local.get(check.data.t);
      const position = entry ? order.indexOf(entry) : -1;
      if (!entry || position < 0) throw new Error(`Row for table ${check.data.t}, which the export header did not list`);
      // Parents come before children, so a table can never appear again after the import moved past it.
      if (position < lastPosition) throw new Error(`Rows for ${entry.name} appear after rows for a table that depends on it; the export is out of order`);
      lastPosition = position;

      const values: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(check.data.r)) {
        const prop = Object.keys(entry.columns).find((key) => entry.columns[key]!.name === name);
        if (!prop) throw new Error(`Table ${entry.name} has no column ${name}; the export and this schema version do not match`);
        values[prop] = portable(value);
      }

      if (batchTable && batchTable.name !== entry.name) await flushBatch();
      batchTable = entry;
      batch.push(values);
      imported.set(entry.name, (imported.get(entry.name) ?? 0) + 1);
      if (batch.length >= INSERT_BATCH) await flushBatch();
    }
    await flushBatch();
    await flush(pending);

    const configuration = ensureHeader();
    for (const entry of order) progress(`Imported ${entry.name}: ${imported.get(entry.name) ?? 0} row${(imported.get(entry.name) ?? 0) === 1 ? "" : "s"}`);

    const counts: ImportResult["counts"] = [];
    let ok = true;
    for (const entry of order) {
      const target = await countRows(ctx, entry);
      const expected = imported.get(entry.name) ?? 0;
      const promised = configuration.counts[entry.name];
      const matches = target === expected && (promised === undefined || target === promised);
      if (!matches) ok = false;
      counts.push({ table: entry.name, imported: expected, target, expected: promised ?? expected, ok: matches });
    }
    if (!ok) {
      const problems = counts.filter((item) => !item.ok).map((item) => `${item.table}: the export promised ${item.expected}, imported ${item.imported}, target has ${item.target}`);
      throw new Error(`Row count verification failed after importing ${configuration.tables.length} tables: ${problems.join("; ")}`);
    }
    return { counts, ok };
  } finally {
    lines.close();
    if (!fromStdin) stream.destroy();
  }
}

export function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.username ? `${decodeURIComponent(parsed.username)}@` : ""}${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** The URL decides the dialect, so a `--from sqlite:` copy cannot inherit the parent's forced dialect. */
export function dialectFor(url: string): Dialect {
  return isPostgresUrl(url) ? "postgres" : "sqlite";
}

export function cliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../../cli.ts");
}

export function cliCommand(args: string[]): { command: string; args: string[] } {
  const cli = cliPath();
  // The CLI is TypeScript source in this repo and tsx is a server dependency, so load it by its
  // resolved path: the child must not depend on its working directory to find the loader.
  const loader = /\.ts$/.test(cli) ? ["--import", createRequire(import.meta.url).resolve("tsx")] : [];
  return { command: process.execPath, args: [...loader, cli, ...args] };
}
