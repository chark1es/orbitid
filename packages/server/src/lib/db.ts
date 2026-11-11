/** First row of a query result, or undefined when the query matched nothing. */
export const first = <T>(rows: readonly T[]): T | undefined => rows[0];

import { AsyncLocalStorage } from "node:async_hooks";
import { sql, type SQL } from "drizzle-orm";
import type { AnyColumn } from "drizzle-orm";
import type { AppContext } from "../context";
import type { Db } from "../db";
import { sqliteWriteTransaction } from "../db/sqlite-write";

/** The transaction a task is currently running in, so nested `inWriteTransaction` calls join it. */
const activeTransaction = new AsyncLocalStorage<{ db: Db; tx: Db }>();

/**
 * Runs `fn` in one write transaction on either dialect.
 *
 * Postgres uses the driver's transaction and its advisory locks (see {@link lockGrantFamily}). SQLite has one
 * synchronous connection per handle, so transactions are serialized through a per-connection FIFO queue and run on
 * a dedicated writer connection: only one body runs at a time, and statements from other async tasks cannot join it.
 * See `db/sqlite-write.ts` for the ownership model.
 *
 * Reentrancy is safe on both dialects: a call from inside a transaction body joins the outer transaction (a
 * `SAVEPOINT` on Postgres, and the same savepoint mechanism inside `sqliteWriteTransaction`) instead of waiting for
 * a gate/lock its own parent holds forever.
 */
export async function inWriteTransaction<T>(
  ctx: Pick<AppContext, "db" | "database">,
  fn: (tx: Db) => Promise<T>,
): Promise<T> {
  const outer = activeTransaction.getStore();
  if (outer && outer.db === ctx.db) {
    if (ctx.database.driver === "sqlite") return sqliteWriteTransaction(ctx.db, fn);
    // Drizzle's Postgres transaction handle nests through a savepoint on the same physical connection.
    const nested = outer.tx as unknown as { transaction<R>(run: (tx: unknown) => Promise<R>): Promise<R> };
    return nested.transaction((tx) => fn(tx as Db));
  }
  if (ctx.database.driver === "sqlite") {
    return sqliteWriteTransaction(ctx.db, (tx) => activeTransaction.run({ db: ctx.db, tx }, () => fn(tx)));
  }
  return ctx.db.transaction(async (tx) => {
    const handle = tx as unknown as Db;
    return activeTransaction.run({ db: ctx.db, tx: handle }, () => fn(handle));
  });
}

/**
 * Serializes operations on one OIDC refresh-token family. SQLite already holds the database write lock inside
 * {@link inWriteTransaction}; Postgres takes a transaction-scoped advisory lock keyed by the family id, so a
 * family revocation and a rotation cannot interleave (each waits for the other, then observes its commit).
 */
export async function lockGrantFamily(ctx: Pick<AppContext, "db" | "database">, tx: Db, family: string): Promise<void> {
  if (!family || ctx.database.driver === "sqlite") return;
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${family}))`);
}

/** `%` and `_` in user input must match themselves, not act as wildcards. */
const escapeLike = (value: string) => value.replace(/[\\%_]/g, (c) => `\\${c}`);

/** Case-insensitive "contains" that behaves the same on Postgres and SQLite (SQLite's LIKE already ignores ASCII case, Postgres's does not). */
export const containsText = (column: AnyColumn | SQL, text: string): SQL =>
  sql`lower(${column}) like ${`%${escapeLike(text.toLowerCase())}%`} escape '\\'`;

/** Case-insensitive "starts with". */
export const startsWithText = (column: AnyColumn | SQL, text: string): SQL =>
  sql`lower(${column}) like ${`${escapeLike(text.toLowerCase())}%`} escape '\\'`;
