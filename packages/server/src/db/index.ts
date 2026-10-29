import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dialect, isPostgresUrl, type Dialect } from "./dialect";
import * as schema from "./schema";

/** Typed against Postgres; the SQLite driver exposes the same query builders (awaiting them works on both). */
export type Db = PostgresJsDatabase<typeof schema>;
export { schema, dialect };
export type { Dialect };

export type Driver = "postgres" | "pglite" | "sqlite";

export interface DbHandle {
  db: Db;
  driver: Driver;
  dialect: Dialect;
  /** Where the data lives, safe to show (no password). */
  label: string;
  close(): Promise<void>;
}

const migrationsFolder = () => resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle", dialect);

type EphemeralProvider = () => Promise<{ url: string; drop(): Promise<void> }>;
let ephemeralPostgres: EphemeralProvider | undefined;
/** Tests register a provider that hands out an isolated, already migrated Postgres database per call. */
export const setEphemeralPostgres = (provider: EphemeralProvider | undefined) => { ephemeralPostgres = provider; };

function redact(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.username ? `${decodeURIComponent(u.username)}@` : ""}${u.host}${u.pathname}`;
  } catch {
    return url;
  }
}

/**
 * Opens the database named by `url`:
 *  - `postgres://…` or `postgresql://…` (the main backend)
 *  - `pglite://memory` or `pglite://<dir>` (Postgres compiled to WASM, no server needed)
 *  - `sqlite:<file>`, a plain file path, or `:memory:` (SQLite)
 * `:memory:` always means "a throwaway database in the active dialect".
 */
export async function createDb(url: string): Promise<DbHandle> {
  const wantsPostgres = isPostgresUrl(url) || (url === ":memory:" && dialect === "postgres");
  if (wantsPostgres !== (dialect === "postgres")) {
    throw new Error(`Database URL needs the ${wantsPostgres ? "postgres" : "sqlite"} schema but this process loaded the ${dialect} one. Set ORBITID_DATABASE_URL before starting.`);
  }
  if (dialect === "sqlite") return openSqlite(url);
  if (url === ":memory:" && ephemeralPostgres) {
    const ephemeral = await ephemeralPostgres();
    const handle = await openPostgres(ephemeral.url);
    return { ...handle, async close() { await handle.close(); await ephemeral.drop(); } };
  }
  return /^pglite:/i.test(url) || url === ":memory:" ? await openPglite(url) : await openPostgres(url);
}

async function openPostgres(url: string): Promise<DbHandle> {
  const [{ default: postgres }, { drizzle }] = await Promise.all([import("postgres"), import("drizzle-orm/postgres-js")]);
  const client = postgres(url, { max: Number(process.env.ORBITID_DATABASE_POOL ?? 10), onnotice: () => {} });
  return { db: drizzle(client, { schema }), driver: "postgres", dialect, label: redact(url), close: () => client.end({ timeout: 5 }) };
}

async function openPglite(url: string): Promise<DbHandle> {
  const [{ PGlite }, { drizzle }] = await Promise.all([import("@electric-sql/pglite"), import("drizzle-orm/pglite")]);
  const location = url === ":memory:" ? "memory://" : `${url.replace(/^pglite:\/\//i, "") === "memory" ? "memory://" : url.replace(/^pglite:\/\//i, "")}`;
  if (!location.startsWith("memory://")) mkdirSync(location, { recursive: true });
  const client = new PGlite(location);
  await client.waitReady;
  return { db: drizzle(client, { schema }) as unknown as Db, driver: "pglite", dialect, label: `pglite://${location.replace("memory://", "memory")}`, close: () => client.close() };
}

async function openSqlite(url: string): Promise<DbHandle> {
  const [{ default: Database }, { drizzle }] = await Promise.all([import("better-sqlite3"), import("drizzle-orm/better-sqlite3")]);
  const path = url.replace(/^(sqlite:|file:)(\/\/)?/i, "");
  if (path !== ":memory:") mkdirSync(dirname(resolve(path)), { recursive: true });
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  return { db: drizzle(raw, { schema }) as unknown as Db, driver: "sqlite", dialect, label: path === ":memory:" ? "sqlite memory" : `sqlite:${path}`, close: async () => { raw.close(); } };
}

export async function runMigrations(handle: DbHandle): Promise<void> {
  const folder = migrationsFolder();
  if (handle.driver === "sqlite") {
    const { migrate } = await import("drizzle-orm/better-sqlite3/migrator");
    migrate(handle.db as never, { migrationsFolder: folder });
  } else if (handle.driver === "pglite") {
    const { migrate } = await import("drizzle-orm/pglite/migrator");
    await migrate(handle.db as never, { migrationsFolder: folder });
  } else {
    const { migrate } = await import("drizzle-orm/postgres-js/migrator");
    await migrate(handle.db, { migrationsFolder: folder });
  }
}
