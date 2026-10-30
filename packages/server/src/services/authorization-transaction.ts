import type { SQL } from "drizzle-orm";
import type { AppContext } from "../context";

/**
 * Authorization writes must lock the stable parent before touching its grant rows. This serializes even
 * replacements of an empty set across Postgres connections/processes. Every grant writer takes this lock.
 * SQLite uses a synchronous IMMEDIATE transaction: never await inside better-sqlite3's callback, or a
 * different request on the shared connection could join/commit another request's transaction.
 */
export async function mutateAuthorization(ctx: AppContext, lockParent: SQL, statements: SQL[]): Promise<void> {
  if (ctx.database.driver === "sqlite") {
    const db = ctx.db as unknown as {
      transaction(fn: (tx: { run(statement: SQL): unknown }) => void, options: { behavior: "immediate" }): void;
    };
    db.transaction((tx) => {
      tx.run(lockParent);
      for (const statement of statements) tx.run(statement);
    }, { behavior: "immediate" });
    return;
  }
  await ctx.db.transaction(async (tx) => {
    await tx.execute(lockParent);
    for (const statement of statements) await tx.execute(statement);
  });
}
