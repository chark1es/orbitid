// Role/permission resolution used by both APIs.
import { filterAsync } from "../lib/async";
import { and, eq } from "drizzle-orm";
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

/** Custom role/permission keys are `org:<...>`; `org:sys_` is reserved for system entries. */
export const RESERVED_KEY_PREFIX = "org:sys_";

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

export async function assertAssignableRole(ctx: AppContext, roleKey: string): Promise<RoleRow> {
  const role = await roleByKey(ctx, roleKey);
  if (!role) throw new OrbitError(422, ErrorCodes.org_role_not_found, `Role ${roleKey} does not exist`, { param_name: "role" });
  return role;
}

/** A role counts as "admin" when it can manage memberships. Used for last-admin protection. */
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

export function assertCustomKey(key: string, kind: "role" | "permission"): void {
  if (!key.startsWith("org:")) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `${kind} key must start with "org:"`, { param_name: "key" });
  }
  if (key.startsWith(RESERVED_KEY_PREFIX)) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `Keys starting with "${RESERVED_KEY_PREFIX}" are reserved for system ${kind}s`, { param_name: "key" });
  }
  if (!/^org:[a-zA-Z0-9_-]+(:[a-zA-Z0-9_-]+)*$/.test(key)) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `${kind} key may only contain letters, digits, "_" and ":" segments`, { param_name: "key" });
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
    type: row.type === "system" ? "system" : "user", created_at: row.createdAt, updated_at: row.updatedAt,
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

/** Ensure a role is not referenced by orgs/settings before deletion. */
export async function assertRoleDeletable(ctx: AppContext, role: RoleRow): Promise<void> {
  if (role.isSystem) throw new OrbitError(403, ErrorCodes.not_allowed_access, "System roles cannot be deleted");
  const assigned = await roleUsageCount(ctx, role.key);
  if (assigned > 0) {
    throw new OrbitError(403, ErrorCodes.not_allowed_access, `Role is assigned to ${assigned} organization member${assigned === 1 ? "" : "s"} and cannot be deleted`);
  }
  const creatorRole = ctx.settings.get().organizations.creatorRole;
  if (role.isCreatorEligible && creatorRole === role.key) {
    throw new OrbitError(403, ErrorCodes.not_allowed_access, "Role is the configured creator role and cannot be deleted");
  }
}

/** Replace the permission set of a role. Caller emits the webhook. */
export async function setRolePermissions(ctx: AppContext, role: RoleRow, permissionKeys: string[]): Promise<void> {
  const perms = await resolvePermissions(ctx, permissionKeys);
  await ctx.db.delete(s.rolePermissions).where(eq(s.rolePermissions.roleId, role.id));
  for (const p of perms) await ctx.db.insert(s.rolePermissions).values({ roleId: role.id, permissionId: p.id }).onConflictDoNothing();
  await ctx.db.update(s.roles).set({ updatedAt: Date.now() }).where(eq(s.roles.id, role.id));
}

export async function addRolePermission(ctx: AppContext, role: RoleRow, permission: PermissionRow): Promise<void> {
  await ctx.db.insert(s.rolePermissions).values({ roleId: role.id, permissionId: permission.id }).onConflictDoNothing();
  await ctx.db.update(s.roles).set({ updatedAt: Date.now() }).where(eq(s.roles.id, role.id));
}

export async function removeRolePermission(ctx: AppContext, role: RoleRow, permissionId: string): Promise<void> {
  await ctx.db.delete(s.rolePermissions).where(and(eq(s.rolePermissions.roleId, role.id), eq(s.rolePermissions.permissionId, permissionId)));
  await ctx.db.update(s.roles).set({ updatedAt: Date.now() }).where(eq(s.roles.id, role.id));
}
