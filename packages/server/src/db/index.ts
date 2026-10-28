import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as schema from "./schema";

export type Db = BetterSQLite3Database<typeof schema>;
export { schema };

export function createDb(path: string): { db: Db; raw: Database.Database } {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const raw = new Database(path);
  raw.pragma("journal_mode = WAL");
  raw.pragma("foreign_keys = ON");
  return { db: drizzle(raw, { schema }), raw };
}

export function runMigrations(db: Db) {
  const folder = resolve(dirname(fileURLToPath(import.meta.url)), "../../drizzle");
  migrate(db, { migrationsFolder: folder });
}
