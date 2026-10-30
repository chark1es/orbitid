import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { sql, type SQL } from "drizzle-orm";
import { createContext } from "../../src/bootstrap";
import { dialect, runMigrations } from "../../src/db";
import * as s from "../../src/db/schema";
import type { AppContext } from "../../src/context";

async function execute(ctx: AppContext, statement: SQL) {
  if (ctx.database.driver === "sqlite") return (ctx.db as unknown as { run(query: SQL): unknown }).run(statement);
  return ctx.db.execute(statement);
}

describe("authorization integrity upgrade", () => {
  it("preserves valid legacy grants, removes orphan grants and enforces the new role constraint", async () => {
    const ctx = await createContext({ databaseUrl: ":memory:", nodeEnv: "test", secretKey: "sk_test_upgrade" });
    try {
      // Re-create just the assignment table exactly as the previous released migration defined it.
      await execute(ctx, sql`DROP TABLE ${s.userRoles}`);
      const previous = dialect === "sqlite" ? "sqlite/0007_user_roles.sql" : "postgres/0005_user_roles.sql";
      const migration = readFileSync(new URL(`../../drizzle/${previous}`, import.meta.url), "utf8");
      for (const statement of migration.split("--> statement-breakpoint").filter((text) => text.trim())) await execute(ctx, sql.raw(statement));
      const now = Date.now();
      await ctx.db.insert(s.users).values({ id: "upgrade_user", createdAt: now, updatedAt: now });
      await ctx.db.insert(s.roles).values({ id: "upgrade_role", key: "app:upgrade", name: "Upgrade", createdAt: now, updatedAt: now });
      await ctx.db.insert(s.userRoles).values([
        { userId: "upgrade_user", roleKey: "app:upgrade", createdAt: now, updatedAt: now },
        { userId: "upgrade_user", roleKey: "app:orphan", createdAt: now, updatedAt: now },
      ]);
      const journal = dialect === "sqlite" ? '__drizzle_migrations' : 'drizzle.__drizzle_migrations';
      await execute(ctx, sql.raw(`DELETE FROM ${journal} WHERE created_at = (SELECT MAX(created_at) FROM ${journal})`));
      await runMigrations({ db: ctx.db, driver: ctx.database.driver, dialect, label: ctx.database.label, close: ctx.close });
      expect((await ctx.db.select().from(s.userRoles)).map((row) => row.roleKey)).toEqual(["app:upgrade"]);
      await expect(ctx.db.insert(s.userRoles).values({ userId: "upgrade_user", roleKey: "app:orphan", createdAt: now, updatedAt: now })).rejects.toThrow();
    } finally { await ctx.close(); }
  });
});
