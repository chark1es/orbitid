import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { eq, sql, type SQL } from "drizzle-orm";
import { createContext } from "../../src/bootstrap";
import { createDb, dialect } from "../../src/db";
import type { AppContext } from "../../src/context";
import * as s from "../../src/db/schema";
import { rolesForUser, setUserRoles } from "../../src/services/user-roles";
import { permissionsForRoleId, setRolePermissions } from "../../src/services/rbac";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "orbit-auth-atomic-"));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  const ctx = await createContext({
    databaseUrl: dialect === "postgres" ? ":memory:" : `sqlite:${join(dir, "db.sqlite")}`,
    dataDir: dir, encryptionKey: "authorization-test-key-0123456789-abcdef", nodeEnv: "test",
  });
  cleanup.push(() => ctx.close());
  let other = ctx;
  if (dialect === "sqlite") {
    const handle = await createDb(ctx.env.databaseUrl);
    cleanup.push(() => handle.close());
    other = { ...ctx, db: handle.db };
    expect(other.db).not.toBe(ctx.db);
  }
  const now = Date.now();
  await ctx.db.insert(s.users).values({ id: "user_atomic", createdAt: now, updatedAt: now });
  await ctx.db.insert(s.roles).values([
    { id: "role_a", key: "app:admin", name: "Admin", createdAt: now, updatedAt: now },
    { id: "role_b", key: "app:reader", name: "Reader", createdAt: now, updatedAt: now },
  ]);
  await ctx.db.insert(s.permissions).values([
    { id: "permission_a", key: "app:records:read", name: "Read", createdAt: now, updatedAt: now },
    { id: "permission_b", key: "app:records:delete", name: "Delete", createdAt: now, updatedAt: now },
  ]);
  const role = (await ctx.db.select().from(s.roles).where(eq(s.roles.id, "role_a")))[0]!;
  return { ctx, other, role };
}

/** Start both Postgres transactions before either takes its parent lock; assert distinct physical connections. */
function overlapPostgresTransactions(ctx: AppContext) {
  const pids = new Set<number>();
  if (ctx.database.driver !== "postgres") return () => {};
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const original = ctx.db.transaction.bind(ctx.db);
  const observed: typeof ctx.db.transaction = async (fn, options) => original(async (tx) => {
    const rows = await tx.execute<{ pid: number }>(sql`select pg_backend_pid() as pid`);
    pids.add(Number(rows[0]!.pid));
    if (++arrived === 2) release();
    await gate;
    return fn(tx);
  }, options);
  vi.spyOn(ctx.db, "transaction").mockImplementation(observed);
  return () => expect(pids.size).toBe(2);
}

async function execute(ctx: AppContext, statement: SQL) {
  if (ctx.database.driver === "sqlite") return (ctx.db as unknown as { run(query: SQL): unknown }).run(statement);
  return ctx.db.execute(statement);
}

/** A real database-side insertion failure, after the replacement's DELETE, must roll back that DELETE. */
async function refuseInsert(ctx: AppContext, table: "user_roles" | "role_permissions") {
  if (ctx.database.driver === "sqlite") {
    await execute(ctx, sql.raw(`CREATE TRIGGER refuse_grant_insert BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'injected insert failure'); END`));
  } else {
    await execute(ctx, sql`CREATE FUNCTION refuse_grant_insert() RETURNS trigger AS $$ BEGIN RAISE EXCEPTION 'injected insert failure'; END; $$ LANGUAGE plpgsql`);
    await execute(ctx, sql.raw(`CREATE TRIGGER refuse_grant_insert BEFORE INSERT ON ${table} FOR EACH ROW EXECUTE FUNCTION refuse_grant_insert()`));
  }
}

describe("authorization replacements are atomic and serialized", () => {
  it("concurrent user-role replacements on separate connections never merge grants", async () => {
    const { ctx, other } = await fixture();
    const checkConnections = overlapPostgresTransactions(ctx);
    await Promise.all([
      setUserRoles(ctx, "user_atomic", ["app:admin"]),
      setUserRoles(other, "user_atomic", ["app:reader"]),
    ]);
    expect([["app:admin"], ["app:reader"]]).toContainEqual(await rolesForUser(ctx, "user_atomic"));
    checkConnections();
  });

  it("concurrent role-permission replacements on separate connections never merge grants", async () => {
    const { ctx, other, role } = await fixture();
    const checkConnections = overlapPostgresTransactions(ctx);
    await Promise.all([
      setRolePermissions(ctx, role, ["app:records:read"]),
      setRolePermissions(other, role, ["app:records:delete"]),
    ]);
    expect([["app:records:read"], ["app:records:delete"]]).toContainEqual(await permissionsForRoleId(ctx, role.id));
    checkConnections();
  });

  it("a failed user-role insert preserves the previous complete assignment", async () => {
    const { ctx } = await fixture();
    await setUserRoles(ctx, "user_atomic", ["app:admin"]);
    await refuseInsert(ctx, "user_roles");
    await expect(setUserRoles(ctx, "user_atomic", ["app:reader"])).rejects.toThrow();
    expect(await rolesForUser(ctx, "user_atomic")).toEqual(["app:admin"]);
  });

  it("a failed permission insert preserves the previous complete role grant", async () => {
    const { ctx, role } = await fixture();
    await setRolePermissions(ctx, role, ["app:records:read"]);
    await refuseInsert(ctx, "role_permissions");
    await expect(setRolePermissions(ctx, role, ["app:records:delete"])).rejects.toThrow();
    expect(await permissionsForRoleId(ctx, role.id)).toEqual(["app:records:read"]);
  });
  it("cannot revive an assignment by deleting and re-creating a role key", async () => {
    const { ctx } = await fixture();
    await setUserRoles(ctx, "user_atomic", ["app:admin"]);
    // Simulate a concurrent deletion whose application-level usage check preceded the assignment commit.
    await ctx.db.delete(s.roles).where(eq(s.roles.id, "role_a"));
    await ctx.db.insert(s.roles).values({ id: "role_recreated", key: "app:admin", name: "Recreated", createdAt: Date.now(), updatedAt: Date.now() });
    expect(await rolesForUser(ctx, "user_atomic")).toEqual([]);
  });

});
