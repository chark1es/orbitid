import { mutateAuthorization } from "./authorization-transaction";
// Role/permission resolution used by both APIs.
import { filterAsync } from "../lib/async";
import { and, eq, sql } from "drizzle-orm";
import { ErrorCodes, OrbitError, type PermissionJSON, type RoleJSON } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { first } from "../lib/db";

export type RoleRow = typeof s.roles.$inferSelect;
export type PermissionRow = typeof s.permissions.$inferSelect;
export type MembershipRow = typeof s.organizationMemberships.$inferSelect;

/** System permission keys. */
export const PERMISSIONS = {
  PROFILE_MANAGE: "org:sys_profile:manage",
  PROFILE_DELETE: "org:sys_profile:delete",
  MEMBERSHIPS_READ: "org:sys_memberships:read",
  MEMBERSHIPS_MANAGE: "org:sys_memberships:manage",
  DOMAINS_READ: "org:sys_domains:read",
  DOMAINS_MANAGE: "org:sys_domains:manage",
} as const;

export const ADMIN_ROLE_KEY = "org:admin";
export const MEMBER_ROLE_KEY = "org:member";

/**
 * Role/permission scopes. Organization keys are `org:<feature>[:<permission>]` and are assigned through a
 * membership; instance keys are `app:<feature>[:<permission>]` and are assigned to a user by an operator.
 * The prefix is the source of truth, so no extra column can drift from the key.
 */
export type RoleScope = "organization" | "instance";
export const ORG_KEY_PREFIX = "org:";
export const INSTANCE_KEY_PREFIX = "app:";

export const roleScope = (key: string): RoleScope => (key.startsWith(INSTANCE_KEY_PREFIX) ? "instance" : "organization");
/** The two seeded organization roles. They can neither be edited nor assigned as instance roles. */
export const systemRoleKey = (key: string): boolean => key === ADMIN_ROLE_KEY || key === MEMBER_ROLE_KEY;

export const SYSTEM_PERMISSIONS: { key: string; name: string; description: string }[] = [
  { key: PERMISSIONS.PROFILE_MANAGE, name: "Manage organization profile", description: "Update the organization name, slug, logo and metadata." },
  { key: PERMISSIONS.PROFILE_DELETE, name: "Delete organization", description: "Delete the organization." },
  { key: PERMISSIONS.MEMBERSHIPS_READ, name: "Read organization memberships", description: "View members, invitations, membership requests and roles." },
  { key: PERMISSIONS.MEMBERSHIPS_MANAGE, name: "Manage organization memberships", description: "Add, remove and change the role of members, and manage invitations and membership requests." },
  { key: PERMISSIONS.DOMAINS_READ, name: "Read organization domains", description: "View organization domains." },
  { key: PERMISSIONS.DOMAINS_MANAGE, name: "Manage organization domains", description: "Add, verify, update and remove organization domains." },
];

/** System roles. `org:admin` gets every system permission, `org:member` the read-only ones. */
export const SYSTEM_ROLES: { key: string; name: string; description: string; isCreatorEligible: boolean; permissions: string[] }[] = [
  {
    key: ADMIN_ROLE_KEY,
    name: "Admin",
    description: "Full administrative access to the organization.",
    isCreatorEligible: true,
    permissions: SYSTEM_PERMISSIONS.map((p) => p.key),
  },
  {
    key: MEMBER_ROLE_KEY,
    name: "Member",
    description: "Basic access to the organization.",
    isCreatorEligible: false,
    permissions: [PERMISSIONS.MEMBERSHIPS_READ, PERMISSIONS.DOMAINS_READ],
  },
];

/** Custom role/permission keys are namespaced: `org:` for organization, `app:` for instance-wide. */
export const RESERVED_KEY_PREFIX = "org:sys_";
export const RESERVED_INSTANCE_KEY_PREFIX = "app:sys_";

export async function permissionsForRoleId(ctx: AppContext, roleId: string): Promise<string[]> {
  const rows = (await ctx.db
      .select({ key: s.permissions.key })
      .from(s.rolePermissions)
      .innerJoin(s.permissions, eq(s.permissions.id, s.rolePermissions.permissionId))
      .where(eq(s.rolePermissions.roleId, roleId)));
  return rows.map((r) => r.key).sort();
}

/** Permissions granted by a role key (`org:admin` → all system permissions). */
export async function permissionsForRole(ctx: AppContext, roleKey: string): Promise<string[]> {
  const role = first(await ctx.db.select().from(s.roles).where(eq(s.roles.key, roleKey)));
  return role ? await permissionsForRoleId(ctx, role.id) : [];
}

export async function roleByKey(ctx: AppContext, key: string): Promise<RoleRow | undefined> {
  return first(await ctx.db.select().from(s.roles).where(eq(s.roles.key, key)));
}

export async function roleById(ctx: AppContext, id: string): Promise<RoleRow | undefined> {
  return first(await ctx.db.select().from(s.roles).where(eq(s.roles.id, id)));
}

/** Look up a role by id or key. */
export async function resolveRole(ctx: AppContext, idOrKey: string): Promise<RoleRow | undefined> {
  return await roleById(ctx, idOrKey) ?? await roleByKey(ctx, idOrKey);
}

export function hasPermission(permissions: string[], permission: string): boolean {
  return permissions.includes(permission);
}

export function assertPermission(membership: MembershipRow, permissions: string[], permission: string): void {
  if (!permissions.includes(permission)) {
    throw new OrbitError(403, ErrorCodes.org_permission_required, `You do not have permission to perform this action. Missing permission: ${permission}`, {
      permission,
      role: membership.roleKey,
    });
  }
}

/**
 * A role that can be placed on an organization membership or invitation: it must exist and be an
 * organization role. Instance roles (`app:*`) belong to `user_roles` and are assigned by an operator to a
 * user; putting one on a membership would grant nothing and would leak an instance-scoped key into `org_role`.
 */
export async function assertOrganizationRole(ctx: AppContext, roleKey: string, paramName = "role"): Promise<RoleRow> {
  const role = await roleByKey(ctx, roleKey);
  if (!role) throw new OrbitError(422, ErrorCodes.org_role_not_found, `Role ${roleKey} does not exist`, { param_name: paramName });
  if (roleScope(role.key) !== "organization") {
    throw new OrbitError(
      422,
      ErrorCodes.form_param_value_invalid,
      `${role.key} is an instance role and cannot be assigned to an organization. Assign it to the user instead.`,
      { param_name: paramName },
    );
  }
  return role;
}

export async function isAdminRole(ctx: AppContext, roleKey: string): Promise<boolean> {
  return (await permissionsForRole(ctx, roleKey)).includes(PERMISSIONS.MEMBERSHIPS_MANAGE);
}

export async function adminMemberships(ctx: AppContext, orgId: string): Promise<MembershipRow[]> {
  const rows = (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, orgId)));
  return filterAsync(rows, (m) => isAdminRole(ctx, m.roleKey));
}

/** Whether removing/demoting `membership` would leave the organization without an admin. */
export async function isLastAdmin(ctx: AppContext, membership: MembershipRow): Promise<boolean> {
  if (!await isAdminRole(ctx, membership.roleKey)) return false;
  const admins = await adminMemberships(ctx, membership.organizationId);
  return admins.filter((m) => m.id !== membership.id).length === 0;
}

export async function assertNotLastAdmin(ctx: AppContext, membership: MembershipRow, message = "The last admin of an organization cannot leave or be removed."): Promise<void> {
  if (await isLastAdmin(ctx, membership)) {
    throw new OrbitError(403, ErrorCodes.last_admin_cannot_leave, message, { role: membership.roleKey });
  }
}

/**
 * Custom key syntax for a role or permission. `org:<feature>[:<action>]` is an organization role; the same
 * shape under `app:` is an instance-wide role. `sys_` is reserved in both namespaces for seeded entries.
 *
 * Keys are opaque identifiers: they are compared for equality (and `prefix:*` permissions by prefix), never parsed
 * into route or SQL fragments. Hyphens are therefore allowed — `org:team-lead` is the shape the dashboard's own
 * validator accepts — as are underscores, digits and `:` segments. Reserved prefixes are checked case-insensitively
 * so `org:Sys_admin` cannot slip past the guard.
 */
export function assertCustomKey(key: string, kind: "role" | "permission"): void {
  const scopePrefix = key.startsWith(INSTANCE_KEY_PREFIX) ? INSTANCE_KEY_PREFIX : key.startsWith(ORG_KEY_PREFIX) ? ORG_KEY_PREFIX : null;
  if (!scopePrefix) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `${kind} key must start with "org:" or "app:"`, { param_name: "key" });
  }
  const lowered = key.toLowerCase();
  if (lowered.startsWith(RESERVED_KEY_PREFIX) || lowered.startsWith(RESERVED_INSTANCE_KEY_PREFIX)) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `Keys starting with "org:sys_" or "app:sys_" are reserved for system ${kind}s`, { param_name: "key" });
  }
  if (!key.slice(scopePrefix.length)) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `${kind} key needs a name after "${scopePrefix}"`, { param_name: "key" });
  }
  // Lower-case only, like the dashboard's own validator, so `org:Support` and `org:support` cannot both exist as
  // two roles that read the same. Each `:` segment is `[a-z0-9][a-z0-9_-]*`; a doubled or trailing colon is not a name.
  for (const segment of key.slice(scopePrefix.length).split(":")) {
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(segment)) {
      throw new OrbitError(
        422,
        ErrorCodes.form_param_format_invalid,
        `${kind} key segments must be lowercase letters, digits, "_" or "-", starting with a letter or digit`,
        { param_name: "key" },
      );
    }
  }
}

/**
 * Checks that every permission can be attached to this role *before* anything is written, so a rejected request
 * cannot leave a role row (or a half-replaced permission set) behind. `setRolePermissions` performs the same check
 * as a last line of defence.
 */
export function assertPermissionScopes(roleKey: string, permissions: { key: string }[]): void {
  const roleScopeKind = roleScope(roleKey);
  for (const permission of permissions) {
    if (roleScope(permission.key) !== roleScopeKind) {
      throw new OrbitError(
        422,
        ErrorCodes.form_param_value_invalid,
        `${permission.key} is an ${roleScope(permission.key)} permission; ${roleKey} is an ${roleScopeKind} role`,
        { param_name: "permissions" },
      );
    }
  }
}

/**
 * `is_creator_eligible` only means something for an organization role: it makes the role selectable as
 * `organizations.creatorRole`. An instance role can never be a creator role, so the flag is refused rather than
 * stored and ignored.
 */
export function assertCreatorEligible(roleKey: string, eligible: boolean | undefined): void {
  if (eligible && roleScope(roleKey) !== "organization") {
    throw new OrbitError(
      422,
      ErrorCodes.form_param_value_invalid,
      `${roleKey} is an instance role and cannot be creator eligible; creatorRole must be an organization role`,
      { param_name: "is_creator_eligible" },
    );
  }
}

/** Custom permissions may be attached to system roles; resolve a list of permission keys/ids to rows. */
export async function resolvePermissions(ctx: AppContext, keysOrIds: string[]): Promise<PermissionRow[]> {
  const out: PermissionRow[] = [];
  for (const k of keysOrIds) {
    const row = first(await ctx.db.select().from(s.permissions).where(eq(s.permissions.key, k)))
      ?? first(await ctx.db.select().from(s.permissions).where(eq(s.permissions.id, k)));
    if (!row) throw new OrbitError(422, ErrorCodes.form_param_value_invalid, `Permission ${k} does not exist`, { param_name: "permissions" });
    if (!out.some((p) => p.id === row.id)) out.push(row);
  }
  return out;
}

export function serializePermission(row: PermissionRow): PermissionJSON {
  return {
    object: "permission", id: row.id, key: row.key, name: row.name, description: row.description,
    type: row.type === "system" ? "system" : "user", scope: roleScope(row.key), created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

export async function serializeRole(ctx: AppContext, row: RoleRow): Promise<RoleJSON> {
  const perms = (await ctx.db
      .select({ p: s.permissions })
      .from(s.rolePermissions)
      .innerJoin(s.permissions, eq(s.permissions.id, s.rolePermissions.permissionId))
      .where(eq(s.rolePermissions.roleId, row.id)))
    .map((r) => serializePermission(r.p))
    .sort((a, b) => a.key.localeCompare(b.key));
  return {
    object: "role", id: row.id, key: row.key, name: row.name, description: row.description,
    scope: roleScope(row.key), is_system: row.isSystem,
    is_creator_eligible: row.isCreatorEligible, permissions: perms, created_at: row.createdAt, updated_at: row.updatedAt,
  };
}

export async function membershipCount(ctx: AppContext, orgId: string): Promise<number> {
  return (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, orgId))).length;
}

/** Number of memberships that use a role (role deletion guard). */
export async function roleUsageCount(ctx: AppContext, roleKey: string): Promise<number> {
  return (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.roleKey, roleKey))).length;
}

/** Ensure a role is not referenced by memberships, user assignments or settings before deletion. */
export async function assertRoleDeletable(ctx: AppContext, role: RoleRow): Promise<void> {
  if (role.isSystem) throw new OrbitError(403, ErrorCodes.not_allowed_access, "System roles cannot be deleted");
  const assignments = (await ctx.db.select({ userId: s.userRoles.userId }).from(s.userRoles).where(eq(s.userRoles.roleKey, role.key))).length;
  if (assignments > 0) {
    throw new OrbitError(403, ErrorCodes.not_allowed_access, `Role is assigned to ${assignments} user${assignments === 1 ? "" : "s"} and cannot be deleted`);
  }
  if (roleScope(role.key) === "organization") {
    const assigned = await roleUsageCount(ctx, role.key);
    if (assigned > 0) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, `Role is assigned to ${assigned} organization member${assigned === 1 ? "" : "s"} and cannot be deleted`);
    }
    const organizations = ctx.settings.get().organizations;
    if (role.key === organizations.creatorRole || role.key === organizations.defaultRole) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "Role is the configured creator or default role and cannot be deleted");
    }
    // A pending invitation would accept into a membership whose role no longer exists (no foreign key on
    // `role_key`), leaving an organization member with no permissions at all.
    const invited = (await ctx.db
      .select({ id: s.organizationInvitations.id })
      .from(s.organizationInvitations)
      .where(and(eq(s.organizationInvitations.roleKey, role.key), eq(s.organizationInvitations.status, "pending")))).length;
    if (invited > 0) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, `Role is used by ${invited} pending invitation${invited === 1 ? "" : "s"} and cannot be deleted`);
    }
  }
}

/** Replace the permission set of a role. Caller emits the webhook. */
export async function setRolePermissions(ctx: AppContext, role: RoleRow, permissionKeys: string[]): Promise<void> {
  const perms = await resolvePermissions(ctx, permissionKeys);
  assertPermissionScopes(role.key, perms);
  await mutateAuthorization(ctx,
    sql`update ${s.roles} set updated_at = ${Date.now()} where id = ${role.id}`,
    [sql`delete from ${s.rolePermissions} where role_id = ${role.id}`,
      ...(perms.length ? [sql`insert into ${s.rolePermissions} (role_id, permission_id) values ${sql.join(perms.map((permission) => sql`(${role.id}, ${permission.id})`), sql`, `)}`] : [])],
  );
}

export async function addRolePermission(ctx: AppContext, role: RoleRow, permission: PermissionRow): Promise<void> {
  await mutateAuthorization(ctx,
    sql`update ${s.roles} set updated_at = ${Date.now()} where id = ${role.id}`,
    [sql`insert into ${s.rolePermissions} (role_id, permission_id) values (${role.id}, ${permission.id}) on conflict do nothing`],
  );
}

export async function removeRolePermission(ctx: AppContext, role: RoleRow, permissionId: string): Promise<void> {
  await mutateAuthorization(ctx,
    sql`update ${s.roles} set updated_at = ${Date.now()} where id = ${role.id}`,
    [sql`delete from ${s.rolePermissions} where role_id = ${role.id} and permission_id = ${permissionId}`],
  );
}
