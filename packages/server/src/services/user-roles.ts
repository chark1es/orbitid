// Instance-wide custom roles: assignments (`user_roles`) and the claims they produce.
//
// Organization roles live on `organizationMemberships.roleKey` and gate organization endpoints. Instance roles
// are assigned to a user by an operator through the Backend API and travel in the session token as `roles`
// and `role_permissions`. Nothing a signed-in user can write (profile metadata, client state, a request body)
// reaches these claims: only an operator's Backend API call creates the rows.
import { asc, eq, inArray, sql } from "drizzle-orm";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { mutateAuthorization } from "./authorization-transaction";
import { permissionsForRoleIds, roleByKey, roleScope, systemRoleKey } from "./rbac";

/** Every assignment row for a user, sorted by key. */
export async function userRoleRows(ctx: AppContext, userId: string) {
  return ctx.db.select().from(s.userRoles).where(eq(s.userRoles.userId, userId)).orderBy(asc(s.userRoles.roleKey));
}

/** The instance role keys assigned to `userId`. */
export async function rolesForUser(ctx: AppContext, userId: string): Promise<string[]> {
  return (await userRoleRows(ctx, userId)).map((row) => row.roleKey);
}

/**
 * Role keys + the union of their permissions, for the session token and `UserJSON`. A role that was deleted
 * (or is not an instance role) is dropped here rather than being carried into a token.
 */
export async function roleClaimsForUser(ctx: AppContext, userId: string): Promise<{ roles: string[]; permissions: string[] }> {
  const keys = await rolesForUser(ctx, userId);
  if (!keys.length) return { roles: [], permissions: [] };
  const stored = await ctx.db.select().from(s.roles).where(inArray(s.roles.key, keys));
  const byKey = new Map(stored.map((role) => [role.key, role]));
  const active: string[] = [];
  for (const key of keys) {
    const role = byKey.get(key);
    if (role && roleScope(role.key) === "instance") active.push(key);
  }
  // One IN query for every assigned role, not one query per role.
  const byRoleId = await permissionsForRoleIds(ctx, active.map((key) => byKey.get(key)!.id));
  const permissions = new Set<string>();
  for (const key of active) {
    for (const permission of byRoleId.get(byKey.get(key)!.id) ?? []) permissions.add(permission);
  }
  return { roles: active.sort(), permissions: [...permissions].sort() };
}

/** Replaces the instance roles of a user. Throws when a key is not an instance role. */
export async function setUserRoles(ctx: AppContext, userId: string, roleKeys: string[]): Promise<string[]> {
  const unique = [...new Set(roleKeys)];
  for (const key of unique) {
    const role = await roleByKey(ctx, key);
    if (!role) throw new OrbitError(422, ErrorCodes.org_role_not_found, `Role ${key} does not exist`, { param_name: "roles" });
    if (roleScope(role.key) !== "instance") {
      throw new OrbitError(
        422,
        ErrorCodes.form_param_value_invalid,
        `${key} is an organization role. Assign it through an organization membership, not through the user's instance roles.`,
        { param_name: "roles" },
      );
    }
    if (systemRoleKey(role.key)) throw new OrbitError(422, ErrorCodes.form_param_value_invalid, `${key} is a system role and cannot be assigned as an instance role`, { param_name: "roles" });
  }
  const now = Date.now();
  await mutateAuthorization(ctx,
    sql`update ${s.users} set updated_at = updated_at where id = ${userId}`,
    [sql`delete from ${s.userRoles} where user_id = ${userId}`,
      ...(unique.length ? [sql`insert into ${s.userRoles} (user_id, role_key, created_at, updated_at) values ${sql.join(unique.map((roleKey) => sql`(${userId}, ${roleKey}, ${now}, ${now})`), sql`, `)}`] : [])],
  );
  return unique.sort();
}

/** How many users hold `roleKey` (role deletion guard). */
export async function roleAssignmentCount(ctx: AppContext, roleKey: string): Promise<number> {
  return (await ctx.db.select({ userId: s.userRoles.userId }).from(s.userRoles).where(eq(s.userRoles.roleKey, roleKey))).length;
}
