import type { Kit } from "../kit";
import { sql } from "drizzle-orm";
import { tableBuilders, type Meta } from "./columns";
import type { IdentityTables } from "./identity";

export type OrganizationsTables = ReturnType<typeof organizationsTables>;

export function organizationsTables(kit: Kit, users: IdentityTables["users"]) {
  const { table, text, int, bool, json, index, uniqueIndex, primaryKey, ts, created } = tableBuilders(kit);

  const organizations = table("organizations", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").unique(),
    imageUrl: text("image_url"),
    hasImage: bool("has_image").notNull().default(false),
    maxAllowedMemberships: int("max_allowed_memberships").notNull().default(5),
    adminDeleteEnabled: bool("admin_delete_enabled").notNull().default(true),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    privateMetadata: json<Meta>("private_metadata").notNull().$defaultFn(() => ({})),
    createdBy: text("created_by"),
    ...created(),
  });
  /** Instance-wide custom roles. System roles `org:admin` and `org:member` are seeded. */
  const roles = table("roles", {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(), // "org:admin"
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isCreatorEligible: bool("is_creator_eligible").notNull().default(false),
    isSystem: bool("is_system").notNull().default(false),
    ...created(),
  });
  const permissions = table("permissions", {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(), // "org:billing:manage"
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    type: text("type").notNull().default("user"), // system | user
    ...created(),
  });
  const rolePermissions = table("role_permissions", {
    roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
    permissionId: text("permission_id").notNull().references(() => permissions.id, { onDelete: "cascade" }),
  }, (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })]);

  /**
   * Instance-wide role assignments (`app:support`). Written only by the Backend API; a user's session token
   * carries the resulting `roles` / `role_permissions` claims. Organization roles stay on the membership row.
   */
  const userRoles = table("user_roles", {
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull().references(() => roles.key, { onDelete: "cascade" }),
    ...created(),
  }, (t) => [primaryKey({ columns: [t.userId, t.roleKey] }), index("ur_role_idx").on(t.roleKey)]);

  const organizationMemberships = table("organization_memberships", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull(),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    privateMetadata: json<Meta>("private_metadata").notNull().$defaultFn(() => ({})),
    ...created(),
  }, (t) => [uniqueIndex("om_org_user").on(t.organizationId, t.userId), index("om_user_idx").on(t.userId)]);

  const organizationInvitations = table("organization_invitations", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    roleKey: text("role_key").notNull(),
    status: text("status").notNull().default("pending"),
    tokenHash: text("token_hash").notNull().unique(),
    inviterUserId: text("inviter_user_id"),
    redirectUrl: text("redirect_url"),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    privateMetadata: json<Meta>("private_metadata").notNull().$defaultFn(() => ({})),
    expiresAt: int("expires_at"),
    ...created(),
  }, (t) => [index("oi_org_idx").on(t.organizationId), index("oi_email_idx").on(t.email)]);

  const organizationDomains = table("organization_domains", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enrollmentMode: text("enrollment_mode").notNull().default("manual_invitation"),
    verified: bool("verified").notNull().default(false),
    affiliationEmailAddress: text("affiliation_email_address"),
    ...created(),
  }, (t) => [uniqueIndex("od_org_name").on(t.organizationId, t.name)]);

  const organizationMembershipRequests = table("organization_membership_requests", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    ...created(),
  });

  // ───────────── instance-level access control ─────────────
  const invitations = table("invitations", {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    status: text("status").notNull().default("pending"),
    tokenHash: text("token_hash").notNull().unique(),
    redirectUrl: text("redirect_url"),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    expiresAt: int("expires_at"),
    ...created(),
  });
  const waitlistEntries = table("waitlist_entries", {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    status: text("status").notNull().default("pending"),
    invitationId: text("invitation_id"),
    ...created(),
  });
  const allowlistIdentifiers = table("allowlist_identifiers", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull().unique(), // email, phone, or "@domain.com" / "*@domain.com"
    identifierType: text("identifier_type").notNull(),
    invitationId: text("invitation_id"),
    ...created(),
  });
  const blocklistIdentifiers = table("blocklist_identifiers", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull().unique(),
    identifierType: text("identifier_type").notNull(),
    ...created(),
  });

  return { organizations, roles, permissions, rolePermissions, userRoles, organizationMemberships, organizationInvitations, organizationDomains, organizationMembershipRequests, invitations, waitlistEntries, allowlistIdentifiers, blocklistIdentifiers };
}
