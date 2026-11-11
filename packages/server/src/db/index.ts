import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PostgresJsDatabase } from "drizzle-orm/postgres-js";
import { dialect, isPostgresUrl, type Dialect } from "./dialect";
import * as schema from "./schema";
import { closeSqliteWrite, registerSqliteWrite, SQLITE_BUSY_TIMEOUT_MS } from "./sqlite-write";

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

/** Private temporary directories backing `:memory:` SQLite handles; removed on close or process exit. */
const EPHEMERAL_PREFIX = "orbitid-sqlite-";
const STALE_EPHEMERAL_AGE_MS = 24 * 60 * 60 * 1000;
/** One directory per process; every `:memory:` handle gets its own database file inside it. */
let ephemeralProcessDir: string | null = null;
const ephemeralDirs = new Set<string>();
let ephemeralCleanupInstalled = false;

/** Whether a PID still exists. `EPERM` means it exists but belongs to another user, so it is alive. */
function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Removes throwaway SQLite databases left behind by a process that was killed (`SIGKILL` cannot run an exit hook).
 * Only directories that belong to a dead PID and are older than a day are touched, so a concurrently starting
 * process (or a test runner's live handle) is never affected. Exported for the startup-cleanup test.
 */
export function sweepStaleEphemeralDirs(): void {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(tmpdir(), { withFileTypes: true });
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    // Both throwaway-SQLite directories and an embedded-Postgres test directory are ours; never touch anything else.
    if (!entry.isDirectory() || !/^orbitid-(?:sqlite|pg)-/.test(entry.name)) continue;
    const pid = Number(/^orbitid-sqlite-(\d+)-/.exec(entry.name)?.[1] ?? Number.NaN);
    if (Number.isInteger(pid) && isProcessAlive(pid)) continue;
    const full = join(tmpdir(), entry.name);
    let modified: number;
    try {
      modified = statSync(full).mtimeMs;
    } catch {
      continue;
    }
    if (now - modified < STALE_EPHEMERAL_AGE_MS) continue;
    try {
      rmSync(full, { recursive: true, force: true });
    } catch {
      /* another process is already removing it */
    }
  }
}

function installEphemeralCleanup(): void {
  if (ephemeralCleanupInstalled) return;
  ephemeralCleanupInstalled = true;
  const cleanup = () => {
    for (const dir of ephemeralDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        /* best effort at shutdown */
      }
    }
    ephemeralDirs.clear();
    ephemeralProcessDir = null;
  };
  // Tests do not always close their contexts; a throwaway file must not outlive the process either.
  process.once("exit", cleanup);
  // `SIGKILL` cannot be caught (see `sweepStaleEphemeralDirs`), but an ordinary Ctrl-C or container stop can and
  // must not leave a file behind. This only runs when an ephemeral `:memory:` handle exists: a real deployment uses
  // a disk path or Postgres, so its process lifecycle is untouched.
  for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
    process.once(signal, () => {
      cleanup();
      process.exit(code);
    });
  }
}

/** Creates (once per process) the directory that holds this process's throwaway databases. */
function openEphemeralDir(): string {
  if (!ephemeralProcessDir) {
    sweepStaleEphemeralDirs();
    ephemeralProcessDir = mkdtempSync(join(tmpdir(), `${EPHEMERAL_PREFIX}${process.pid}-`));
    ephemeralDirs.add(ephemeralProcessDir);
    installEphemeralCleanup();
  }
  const dir = mkdtempSync(join(ephemeralProcessDir, "db-"));
  ephemeralDirs.add(dir);
  return dir;
}

async function openSqlite(url: string): Promise<DbHandle> {
  const [{ default: Database }, { drizzle }] = await Promise.all([import("better-sqlite3"), import("drizzle-orm/better-sqlite3")]);
  const requested = url.replace(/^(sqlite:|file:)(\/\/)?/i, "");
  // `:memory:` is a throwaway database. It is backed by a private temporary file (in a per-process temp directory)
  // so a second connection can serve write transactions (see `./sqlite-write.ts`); an in-memory SQLite database is
  // private to a single connection, which would let other requests join an open transaction. Real persistence needs
  // a disk path (`sqlite:/path/to/file.db`) or Postgres: nothing here survives the process.
  const ephemeral = requested === ":memory:";
  const tempDir = ephemeral ? openEphemeralDir() : null;
  const path = tempDir ? join(tempDir, "orbitid.db") : requested;
  if (!ephemeral) mkdirSync(dirname(resolve(path)), { recursive: true });
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  // Every write on this connection is gated asynchronously (see sqlite-write.ts). The synchronous busy timeout is
  // only a last resort for another process; it must stay short so it can never park the event loop.
  raw.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  const db = drizzle(raw, { schema }) as unknown as Db;
  // The transaction sibling connection. It only ever runs serialized write transactions (see sqlite-write.ts),
  // so it needs the foreign-key check and the same short synchronous busy timeout, never a long one.
  const writer = new Database(path);
  writer.pragma("foreign_keys = ON");
  writer.pragma(`busy_timeout = ${SQLITE_BUSY_TIMEOUT_MS}`);
  registerSqliteWrite(db, {
    db: drizzle(writer, { schema }) as unknown as Db,
    close: () => writer.close(),
  });
  return {
    db,
    driver: "sqlite",
    dialect,
    label: ephemeral ? "sqlite memory" : `sqlite:${path}`,
    close: async () => {
      try {
        await closeSqliteWrite(db);
      } finally {
        try {
          raw.close();
        } finally {
          if (tempDir) {
            ephemeralDirs.delete(tempDir);
            rmSync(tempDir, { recursive: true, force: true });
          }
        }
      }
    },
  };
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
