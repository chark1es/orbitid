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
import type { AppContext } from "../context";
import { dialect, isPostgresUrl, type Dialect } from "../db/dialect";
import { TABLE_NAMES } from "../db/define-schema";
import * as schema from "../db/schema";
import { decrypt, encrypt } from "../lib/crypto";

/** Bumped when the JSONL shape changes incompatibly. */
export const EXPORT_FORMAT = 1;
/** Rows per keyset page; keeps memory flat for large tables. */
const PAGE_SIZE = 500;
/** Rows per multi-row INSERT. */
const INSERT_BATCH = 200;
/** Only the current key can decrypt the canary; a mismatch means the wrong encryption key. */
const CANARY_PREFIX = "orbitid-export-canary-v1:";

/**
 * Ephemeral tables are not copied: rate-limit counters describe the old process, not the instance.
 * Everything else (webhooks, deliveries, audit logs, in-flight sessions) moves so the target behaves
 * exactly like the source.
 */
export const SKIPPED_TABLES: ReadonlySet<string> = new Set(["rateLimits"]);

/**
 * Tables that bootstrapping fills on a brand-new database (the instance settings row and the seeded
 * RBAC rows). They do not make a target "non-empty" for the purpose of refusing an import.
 */
const BOOTSTRAP_TABLES = new Set(["instance", "roles", "permissions", "rolePermissions"]);

type TableLike = Record<string, unknown>;

interface TableEntry {
  /** Schema property name, e.g. `emailAddresses` (also `TABLE_NAMES` entries). */
  key: string;
  table: TableLike;
  /** Name in the database, e.g. `email_addresses`. */
  name: string;
  /** Column property name → column, as drizzle exposes it. */
  columns: Record<string, TableColumn>;
}

interface TableColumn {
  name: string;
  /** True for the single-column primary key drizzle stores on the column itself. */
  primary: boolean;
}

export interface TransferProgress {
  (message: string): void;
}

const schemaByName = schema as unknown as Record<string, TableLike>;

function tableConfig(table: TableLike): {
  name: string;
  columns: TableColumn[];
  primaryKeys: { columns: TableColumn[] }[];
  foreignKeys: { reference(): { columns: TableColumn[]; foreignTable: TableLike; foreignColumns: TableColumn[] } }[];
} {
  // Only one dialect's builder was used to define these tables, and they are structurally identical.
  const get = dialect === "postgres" ? (getPostgresTableConfig as (t: never) => unknown) : (getSqliteTableConfig as (t: never) => unknown);
  return get(table as never) as never;
}

const entries = new Map<string, TableEntry>();

function tableEntry(key: string): TableEntry {
  const cached = entries.get(key);
  if (cached) return cached;
  const table = schemaByName[key];
  if (!table) throw new Error(`Unknown table: ${key}`);
  const config = tableConfig(table);
  const entry: TableEntry = {
    key,
    table,
    name: config.name,
    columns: getTableColumns(table as never) as unknown as Record<string, TableColumn>,
  };
  entries.set(key, entry);
  return entry;
}

const byDatabaseName = () => new Map(TABLE_NAMES.map((key) => [tableEntry(key).name, tableEntry(key)]));

/** Tables in dependency order: every row's foreign keys point at a table that comes earlier. */
export function tableOrder(): TableEntry[] {
  const included = TABLE_NAMES.filter((key) => !SKIPPED_TABLES.has(key)).map(tableEntry);
  const names = new Map(included.map((entry) => [entry.name, entry]));
  const dependencies = new Map<string, Set<string>>();
  for (const entry of included) {
    const deps = new Set<string>();
    for (const fk of tableConfig(entry.table).foreignKeys) {
      const ref = fk.reference();
      const parent = names.get(tableConfig(ref.foreignTable).name);
      if (parent && parent.name !== entry.name) deps.add(parent.name);
    }
    dependencies.set(entry.name, deps);
  }
  const ordered: TableEntry[] = [];
  const done = new Set<string>();
  while (ordered.length < included.length) {
    const next = included.find((entry) => !done.has(entry.name) && [...(dependencies.get(entry.name) ?? [])].every((dep) => done.has(dep)));
    if (!next) throw new Error("The schema contains a foreign-key cycle; cannot derive a safe table order");
    ordered.push(next);
    done.add(next.name);
  }
  return ordered;
}

/** Primary-key columns in declaration order (drizzle stores composite keys separately from single ones). */
function primaryKeyColumns(table: TableLike): TableColumn[] {
  const config = tableConfig(table);
  if (config.primaryKeys.length === 1) return config.primaryKeys[0]!.columns;
  if (config.primaryKeys.length > 1) throw new Error(`Table ${config.name} has more than one primary key`);
  return config.columns.filter((column) => column.primary);
}

/** Values every dialect can read back: nothing driver-specific, nothing base64-of-a-buffer. */
function portable(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(portable);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, portable(item)]));
  return value;
}

function schemaVersion(): string {
  try {
    const journal = resolve(dirname(fileURLToPath(import.meta.url)), `../../drizzle/${dialect}/meta/_journal.json`);
    const parsed = JSON.parse(readFileSync(journal, "utf8")) as { entries?: { tag?: string }[] };
    const list = parsed.entries ?? [];
    return `${dialect}:${list.length}:${list.at(-1)?.tag ?? "none"}`;
  } catch {
    return `${dialect}:unknown`;
  }
}

class JsonLines {
  private failure: Error | undefined;

  constructor(private readonly stream: Writable, private readonly closeStream: boolean) {
    // A closed pipe (the import side exiting early) must surface as an error, not crash the process.
    stream.on("error", (error: Error) => { this.failure ??= error; });
  }

  async write(record: unknown): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.stream.write(`${JSON.stringify(record)}\n`)) {
      await new Promise<void>((resolve) => {
        const done = () => {
          this.stream.off("drain", done);
          this.stream.off("error", done);
          resolve();
        };
        this.stream.once("drain", done);
        this.stream.once("error", done);
      });
    }
    if (this.failure) throw this.failure;
  }

  async end(): Promise<void> {
    if (this.failure) throw this.failure;
    if (!this.closeStream) return;
    await new Promise<void>((done, fail) => this.stream.end((error?: Error | null) => (error ? fail(error) : done())));
  }
}

export interface ExportOptions {
  /** File path, or `-` for stdout. */
  out: string;
  progress?: TransferProgress;
}

export interface ExportResult {
  dialect: Dialect;
  tables: { table: string; rows: number }[];
  rows: number;
}

/** Streams every copied table to JSON Lines, parents before children, paging on the primary key. */
export async function exportDatabase(ctx: AppContext, options: ExportOptions): Promise<ExportResult> {
  const progress = options.progress ?? (() => {});
  const toStdout = options.out === "-";
  const stream = toStdout ? (process.stdout as unknown as Writable) : createWriteStream(options.out, { encoding: "utf8" });
  const writer = new JsonLines(stream, !toStdout);
  const order = tableOrder();
  const result: ExportResult = { dialect, tables: [], rows: 0 };

  try {
    // Count first, so the header carries the row count per table and an import can verify against the
    // source rather than against however many lines happened to arrive.
    const counts: Record<string, number> = {};
    for (const entry of order) counts[entry.name] = await countRows(ctx, entry);

    await writer.write({
      orbitid_export: EXPORT_FORMAT,
      dialect,
      schema_version: schemaVersion(),
      created_at: Date.now(),
      key_check: encrypt(ctx.env.encryptionKey, `${CANARY_PREFIX}${randomUUID()}`),
      tables: order.map((entry) => entry.name),
      counts,
    });

    for (const entry of order) {
      const columns = Object.entries(entry.columns);
      const keyColumns = primaryKeyColumns(entry.table);
      if (!keyColumns.length) throw new Error(`Table ${entry.name} has no primary key, so it cannot be paged safely`);
      const keyProps = keyColumns.map((key) => columns.find(([, column]) => column.name === key.name)!);
      let cursor: unknown[] | undefined;
      let rows = 0;

      for (;;) {
        const filter = cursor
          ? keyColumns.length === 1
            ? sql`${keyColumns[0]} > ${cursor[0]}`
            : sql`(${sql.join(keyColumns, sql`, `)}) > (${sql.join(cursor.map((value) => sql`${value}`), sql`, `)})`
          : undefined;
        const page = (await ctx.db
          .select()
          .from(entry.table as never)
          .where(filter as never)
          .orderBy(...keyColumns.map((column) => asc(column as never)))
          .limit(PAGE_SIZE)) as unknown as Record<string, unknown>[];
        if (!page.length) break;
        for (const row of page) {
          const values: Record<string, unknown> = {};
          for (const [prop, column] of columns) values[column.name] = portable(row[prop]);
          await writer.write({ t: entry.name, r: values });
        }
        rows += page.length;
        const last = page[page.length - 1]!;
        cursor = keyProps.map(([prop]) => last[prop]);
      }

      // Rows written while the export ran would make the header's counts a lie; the operator is told to
      // stop writes, so a difference means they did not.
      if (rows !== counts[entry.name]) progress(`Warning: ${entry.name} changed during the export (${counts[entry.name]} counted, ${rows} written)`);
      result.tables.push({ table: entry.name, rows });
      result.rows += rows;
      progress(`Exported ${entry.name}: ${rows} row${rows === 1 ? "" : "s"}`);
    }
    await writer.end();
  } catch (error) {
    stream.destroy();
    throw error;
  }
  return result;
}

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

async function countRows(ctx: AppContext, entry: TableEntry): Promise<number> {
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
export async function importDatabase(ctx: AppContext, options: ImportOptions): Promise<ImportResult> {
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
        if (new Set(header.tables).size !== header.tables.length) throw new Error("The export header lists a table twice");
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

function redact(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.protocol}//${parsed.username ? `${decodeURIComponent(parsed.username)}@` : ""}${parsed.host}${parsed.pathname}`;
  } catch {
    return url;
  }
}

/** The URL decides the dialect, so a `--from sqlite:` copy cannot inherit the parent's forced dialect. */
function dialectFor(url: string): Dialect {
  return isPostgresUrl(url) ? "postgres" : "sqlite";
}

function cliPath(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "../cli.ts");
}

function cliCommand(args: string[]): { command: string; args: string[] } {
  const cli = cliPath();
  // The CLI is TypeScript source in this repo and tsx is a server dependency, so load it by its
  // resolved path: the child must not depend on its working directory to find the loader.
  const loader = /\.ts$/.test(cli) ? ["--import", createRequire(import.meta.url).resolve("tsx")] : [];
  return { command: process.execPath, args: [...loader, cli, ...args] };
}

export interface CopyOptions {
  from: string;
  to: string;
  truncate: boolean;
  yes: boolean;
  progress?: TransferProgress;
}

/**
 * `export` in one process and `import` in another, piped together. Connection URLs travel in the
 * children's environment, never in their arguments, and are only ever printed without credentials.
 */
export async function copyDatabase(options: CopyOptions): Promise<ImportResult> {
  const progress = options.progress ?? (() => {});
  if (options.from === options.to) throw new Error("--from and --to are the same database");
  if (options.truncate && !options.yes) throw new Error("--truncate deletes everything in the target database. Pass --yes to confirm.");
  const fromDialect = dialectFor(options.from);
  const toDialect = dialectFor(options.to);
  const childEnv = (url: string, forced: Dialect): NodeJS.ProcessEnv => ({ ...process.env, ORBITID_DATABASE_URL: url, ORBITID_DB_DIALECT: forced });

  progress(`Copying ${redact(options.from)} (${fromDialect}) -> ${redact(options.to)} (${toDialect})`);

  const exporter = cliCommand(["export", "--out", "-"]);
  const importer = cliCommand(["import", "--in", "-", ...(options.truncate ? ["--truncate", "--yes"] : [])]);

  // The exporter's stderr is captured rather than inherited: if the import refuses the data and exits
  // while the export is still writing, the export's own "broken pipe" message is noise, and the import's
  // message is the one the operator needs.
  const exportChild = spawn(exporter.command, exporter.args, { env: childEnv(options.from, fromDialect), stdio: ["ignore", "pipe", "pipe"] });
  const importChild = spawn(importer.command, importer.args, { env: childEnv(options.to, toDialect), stdio: ["pipe", "pipe", "inherit"] });

  let exportErrors = "";
  exportChild.stderr.setEncoding("utf8");
  exportChild.stderr.on("data", (chunk: string) => { exportErrors += chunk; });

  // The import closing its stdin early must be an ordinary failure of this command, not an unhandled
  // event on either side of the pipe.
  importChild.stdin.on("error", () => { exportChild.stdout.unpipe(importChild.stdin); exportChild.stdout.destroy(); });
  exportChild.stdout.on("error", () => { /* surfaced as the import's failure below */ });
  exportChild.stdout.pipe(importChild.stdin);

  let summary = "";
  importChild.stdout.setEncoding("utf8");
  importChild.stdout.on("data", (chunk: string) => { summary += chunk; });

  const exportExit = new Promise<number>((done) => exportChild.on("close", (code) => done(code ?? 1)));
  const importExit = new Promise<number>((done) => importChild.on("close", (code) => done(code ?? 1)));

  const [exportCode, importCode] = await Promise.all([exportExit, importExit]);
  exportChild.stdout.destroy();

  // The import's error is the real cause when both failed (a refused import makes the export's writes fail).
  if (importCode !== 0) throw new Error(`Import into ${redact(options.to)} failed (exit ${importCode})`);
  if (exportCode !== 0) throw new Error(`Export from ${redact(options.from)} failed (exit ${exportCode})${exportErrors ? `: ${exportErrors.trim()}` : ""}`);

  const last = summary.trim().split("\n").filter(Boolean).at(-1);
  let result: ImportResult | undefined;
  if (last) {
    try {
      const parsed = JSON.parse(last) as { orbitid_import?: number; counts?: ImportResult["counts"]; ok?: boolean };
      if (parsed.orbitid_import === 1 && parsed.counts) result = { counts: parsed.counts, ok: parsed.ok ?? true };
    } catch {
      // The import prints its machine-readable summary last; anything else on stdout is ignored.
    }
  }
  if (!result) throw new Error("The import finished without a count summary");

  progress("");
  progress(`Copied ${result.counts.reduce((sum, item) => sum + item.target, 0)} rows in ${result.counts.length} tables`);
  const width = Math.max(...result.counts.map((item) => item.table.length));
  for (const item of result.counts) progress(`  ${item.table.padEnd(width)}  ${String(item.imported).padStart(8)} -> ${String(item.target).padStart(8)}  ${item.ok ? "ok" : "MISMATCH"}`);
  // Machine-readable summary last, matching `import`, so callers need not parse the table above.
  progress(JSON.stringify({ orbitid_copy: 1, ok: result.ok, counts: result.counts }));
  return result;
}
