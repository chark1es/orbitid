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
import type { AppContext } from "../../context";
import { dialect, isPostgresUrl, type Dialect } from "../../db/dialect";
import { TABLE_NAMES } from "../../db/define-schema";
import * as schema from "../../db/schema";
import { decrypt, encrypt } from "../../lib/crypto";

/** Bumped when the JSONL shape changes incompatibly. */
export const EXPORT_FORMAT = 1;
/** Rows per keyset page; keeps memory flat for large tables. */
export const PAGE_SIZE = 500;
/** Rows per multi-row INSERT. */
export const INSERT_BATCH = 200;
/** Only the current key can decrypt the canary; a mismatch means the wrong encryption key. */
export const CANARY_PREFIX = "orbitid-export-canary-v1:";

/**
 * Ephemeral and environment-local tables are not copied. `rate_limits` counters describe the old process,
 * not the instance. `operator_sessions` are dashboard logins: copying them would restore an operator's
 * browser session on the target instance (and, with a shared secret key, make an old cookie live again).
 * Operators sign in to the target separately. Everything else (webhooks, deliveries, audit
 * logs, in-flight user sessions) moves so the target behaves exactly like the source.
 */
export const SKIPPED_TABLES: ReadonlySet<string> = new Set(["rateLimits", "operatorSessions"]);

/**
 * Tables that bootstrapping fills on a brand-new database (the instance settings row and the seeded
 * RBAC rows). They do not make a target "non-empty" for the purpose of refusing an import.
 */
export const BOOTSTRAP_TABLES = new Set(["instance", "roles", "permissions", "rolePermissions"]);

export type TableLike = Record<string, unknown>;

export interface TableEntry {
  /** Schema property name, e.g. `emailAddresses` (also `TABLE_NAMES` entries). */
  key: string;
  table: TableLike;
  /** Name in the database, e.g. `email_addresses`. */
  name: string;
  /** Column property name → column, as drizzle exposes it. */
  columns: Record<string, TableColumn>;
}

export interface TableColumn {
  name: string;
  /** True for the single-column primary key drizzle stores on the column itself. */
  primary: boolean;
}

export interface TransferProgress {
  (message: string): void;
}

const schemaByName = schema as unknown as Record<string, TableLike>;

export function tableConfig(table: TableLike): {
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

export function tableEntry(key: string): TableEntry {
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

export const byDatabaseName = () => new Map(TABLE_NAMES.map((key) => [tableEntry(key).name, tableEntry(key)]));

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
export function primaryKeyColumns(table: TableLike): TableColumn[] {
  const config = tableConfig(table);
  if (config.primaryKeys.length === 1) return config.primaryKeys[0]!.columns;
  if (config.primaryKeys.length > 1) throw new Error(`Table ${config.name} has more than one primary key`);
  return config.columns.filter((column) => column.primary);
}

/** Values every dialect can read back: nothing driver-specific, nothing base64-of-a-buffer. */
export function portable(value: unknown): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "bigint") return Number(value);
  if (Array.isArray(value)) return value.map(portable);
  if (typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, portable(item)]));
  return value;
}

/**
 * Tables introduced after the first release, with the number of migrations (per dialect) from which they exist. An
 * export whose schema is older than that legitimately lacks them; a newer one that omits them is incomplete.
 */
const ADDED_IN_LATER_RELEASES: Record<string, { postgres: number; sqlite: number }> = {
  trusted_devices: { postgres: 3, sqlite: 5 },
  device_codes: { postgres: 3, sqlite: 5 },
  user_roles: { postgres: 6, sqlite: 8 },
};

/** True when an export made at `schemaVersion` (`<dialect>:<migrations>:<tag>`) predates `table`. */
export function exportPredates(table: string, version: string): boolean {
  const added = ADDED_IN_LATER_RELEASES[table];
  if (!added) return false;
  const [exportDialect, count] = version.split(":");
  const migrations = Number(count);
  if ((exportDialect !== "postgres" && exportDialect !== "sqlite") || !Number.isFinite(migrations)) return false;
  return migrations < added[exportDialect];
}

export function schemaVersion(): string {
  try {
    const journal = resolve(dirname(fileURLToPath(import.meta.url)), `../../../drizzle/${dialect}/meta/_journal.json`);
    const parsed = JSON.parse(readFileSync(journal, "utf8")) as { entries?: { tag?: string }[] };
    const list = parsed.entries ?? [];
    return `${dialect}:${list.length}:${list.at(-1)?.tag ?? "none"}`;
  } catch {
    return `${dialect}:unknown`;
  }
}
