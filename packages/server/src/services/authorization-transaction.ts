import type { SQL } from "drizzle-orm";
import type { AppContext } from "../context";
import { inWriteTransaction } from "../lib/db";

/**
 * Authorization writes must lock the stable parent before touching its grant rows. This serializes even
 * replacements of an empty set across Postgres connections/processes. Every grant writer takes this lock.
 *
 * Both dialects now use {@link inWriteTransaction}: on SQLite it serializes through the per-connection FIFO queue
 * and runs the statements on the dedicated writer connection, so no other request can join (or commit) this
 * transaction while its statements execute.
 */
export async function mutateAuthorization(ctx: AppContext, lockParent: SQL, statements: SQL[]): Promise<void> {
  await inWriteTransaction(ctx, async (tx) => {
    // Drizzle's SQLite handle exposes raw statements as `run`; the Postgres handle uses `execute`. Both execute
    // synchronously/asynchronously on the transaction's own connection.
    const run = ctx.database.driver === "sqlite"
      ? (statement: SQL) => (tx as unknown as { run(query: SQL): unknown }).run(statement)
      : (statement: SQL) => tx.execute(statement);
    await run(lockParent);
    for (const statement of statements) await run(statement);
  });
}
