import { someAsync } from "../lib/async";
import { and, eq, gt, inArray, isNull, or } from "drizzle-orm";
import { ErrorCodes, OrbitError, ID_PREFIX } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { randomToken, sha256 } from "../lib/crypto";
import { newId } from "../lib/ids";
import { serializeMembership, serializeOrganization } from "../serializers";
import { serializeOrganizationDomain, serializeOrganizationInvitation } from "../modules/orgs/serializers";
import { deleteLogoFile } from "../modules/orgs/assets";
import { emailDomain, normalizeEmail } from "./org-domains";
import { ADMIN_ROLE_KEY, MEMBER_ROLE_KEY, SYSTEM_PERMISSIONS, SYSTEM_ROLES, isAdminRole, permissionsForRole, roleByKey } from "./rbac";
import { emitEvent } from "./webhooks";
import { first } from "../lib/db";

type OrgRow = typeof s.organizations.$inferSelect;
type MembershipRow = typeof s.organizationMemberships.$inferSelect;
type InvitationRow = typeof s.organizationInvitations.$inferSelect;
type DomainRow = typeof s.organizationDomains.$inferSelect;

export const INVITATION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Role + permissions for user in org, or null if not a member. Used when minting session JWTs (org_id, org_role, org_permissions, org_slug). */
export async function getMembershipContext(ctx: AppContext, userId: string, orgId: string): Promise<null | { id: string; orgId: string; slug: string | null; role: string; permissions: string[] }> {
  const membership = first(await ctx.db
      .select()
      .from(s.organizationMemberships)
      .where(and(eq(s.organizationMemberships.organizationId, orgId), eq(s.organizationMemberships.userId, userId))));
  if (!membership) return null;
  const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, orgId)));
  return { id: orgId, orgId, slug: org?.slug ?? null, role: membership.roleKey, permissions: await permissionsForRole(ctx, membership.roleKey) };
}

/** Called by core after a user (with a freshly verified email) is created or verifies an email: accept pending org invitations for that email, apply verified-domain automatic_invitation/automatic_suggestion. */
export async function onUserEmailVerified(ctx: AppContext, userId: string, email: string): Promise<void> {
  const address = email.trim().toLowerCase();
  if (!address) return;
  const now = Date.now();
  const invitations = (await ctx.db
      .select()
      .from(s.organizationInvitations)
      .where(and(eq(s.organizationInvitations.email, address), eq(s.organizationInvitations.status, "pending"))));
  for (const invitation of invitations) {
    if (invitation.expiresAt && invitation.expiresAt <= now) continue;
    try {
      await acceptInvitation(ctx, invitation, userId);
    } catch (err) {
      // A full organization must not break email verification; the invitation stays pending.
      if (!(err instanceof OrbitError && err.code === ErrorCodes.organization_membership_quota_exceeded)) throw err;
    }
  }
  const domain = emailDomain(address);
  if (!domain) return;
  const domains = (await ctx.db
      .select()
      .from(s.organizationDomains)
      .where(and(eq(s.organizationDomains.name, domain), eq(s.organizationDomains.verified, true))));
  for (const row of domains) {
    if (row.enrollmentMode === "automatic_invitation") await applyDomainEnrollment(ctx, row, [userId]);
    // automatic_suggestion needs no write: `suggestedOrganizations` derives the suggestion from the verified email domain.
  }
}

/** Called when a sign-up completes with an org invitation ticket. */
export async function acceptInvitationByTicket(ctx: AppContext, ticket: string, userId: string): Promise<void> {
  const invitation = first(await ctx.db.select().from(s.organizationInvitations).where(eq(s.organizationInvitations.tokenHash, sha256(ticket))));
  if (!invitation) throw new OrbitError(422, ErrorCodes.ticket_invalid, "Organization invitation ticket is invalid");
  if (invitation.status === "accepted") return;
  if (invitation.status !== "pending") throw new OrbitError(422, ErrorCodes.ticket_invalid, "Organization invitation is no longer valid");
  if (invitation.expiresAt && invitation.expiresAt <= Date.now()) throw new OrbitError(422, ErrorCodes.ticket_expired, "Organization invitation has expired");
  await acceptInvitation(ctx, invitation, userId);
}

/** Seed system roles (org:admin, org:member) + system permissions. Idempotent. Called at boot by bootstrap. */
export async function seedRbac(ctx: AppContext): Promise<void> {
  const now = Date.now();
  for (const permission of SYSTEM_PERMISSIONS) {
    const existing = first(await ctx.db.select().from(s.permissions).where(eq(s.permissions.key, permission.key)));
    if (!existing) {
      await ctx.db.insert(s.permissions).values({ id: newId(ID_PREFIX.permission), key: permission.key, name: permission.name, description: permission.description, type: "system", createdAt: now, updatedAt: now });
    } else if (existing.type !== "system") {
      await ctx.db.update(s.permissions).set({ type: "system", updatedAt: now }).where(eq(s.permissions.id, existing.id));
    }
  }
  for (const role of SYSTEM_ROLES) {
    let row = first(await ctx.db.select().from(s.roles).where(eq(s.roles.key, role.key)));
    if (!row) {
      await ctx.db.insert(s.roles).values({ id: newId(ID_PREFIX.role), key: role.key, name: role.name, description: role.description, isCreatorEligible: role.isCreatorEligible, isSystem: true, createdAt: now, updatedAt: now });
      row = first(await ctx.db.select().from(s.roles).where(eq(s.roles.key, role.key)))!;
    } else if (!row.isSystem) {
      await ctx.db.update(s.roles).set({ isSystem: true, updatedAt: now }).where(eq(s.roles.id, row.id));
    }
    const allowed = role.permissions.length ? (await ctx.db.select().from(s.permissions).where(inArray(s.permissions.key, role.permissions))) : [];
    for (const permission of allowed) {
      await ctx.db.insert(s.rolePermissions).values({ roleId: row.id, permissionId: permission.id }).onConflictDoNothing();
    }
  }
}

/** Remove memberships/invitations/requests of a deleted user; promote/delete orgs left without admins. */
export async function onUserDeleted(ctx: AppContext, userId: string): Promise<void> {
  // Callers may run this before or after the user row is deleted (memberships cascade with it).
  const userExists = !!first(await ctx.db.select().from(s.users).where(eq(s.users.id, userId)));
  const memberships = (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.userId, userId)));
  const affected = new Set(memberships.map((m) => m.organizationId));
  for (const membership of memberships) {
    const payload = userExists ? await serializeMembership(ctx, membership, { backend: true }) : null;
    await ctx.db.delete(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id));
    if (payload) await emitEvent(ctx, "organizationMembership.deleted", payload);
  }
  for (const org of (await ctx.db.select().from(s.organizations).where(eq(s.organizations.createdBy, userId)))) affected.add(org.id);
  await ctx.db.delete(s.organizationMembershipRequests).where(eq(s.organizationMembershipRequests.userId, userId));

  for (const orgId of affected) {
    const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, orgId)));
    if (!org) continue;
    const remaining = (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, orgId)));
    if (!remaining.length) {
      const payload = await serializeOrganization(ctx, org, { backend: true });
      deleteLogoFile(ctx, org.imageUrl);
      await ctx.db.delete(s.organizations).where(eq(s.organizations.id, orgId));
      await emitEvent(ctx, "organization.deleted", payload);
      continue;
    }
    const hasAdmin = await someAsync(remaining, (m) => isAdminRole(ctx, m.roleKey));
    if (hasAdmin) continue;
    const promote = [...remaining].sort((a, b) => a.createdAt - b.createdAt)[0]!;
    const roleKey = await creatorRoleKey(ctx);
    await ctx.db.update(s.organizationMemberships).set({ roleKey, updatedAt: Date.now() }).where(eq(s.organizationMemberships.id, promote.id));
    const updated = first(await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.id, promote.id)))!;
    await emitEvent(ctx, "organizationMembership.updated", await serializeMembership(ctx, updated, { backend: true }));
  }
}

// ───────────────────────── helpers used by both APIs ─────────────────────────

export async function creatorRoleKey(ctx: AppContext): Promise<string> {
  const key = ctx.settings.get().organizations.creatorRole;
  return await roleByKey(ctx, key) ? key : ADMIN_ROLE_KEY;
}

export async function defaultRoleKey(ctx: AppContext): Promise<string> {
  const key = ctx.settings.get().organizations.defaultRole;
  return await roleByKey(ctx, key) ? key : MEMBER_ROLE_KEY;
}

export async function assertCanCreateOrganization(ctx: AppContext, user: { id: string; createOrganizationEnabled: boolean; createOrganizationsLimit: number | null }): Promise<void> {
  const orgs = ctx.settings.get().organizations;
  if (!orgs.enabled) throw new OrbitError(403, ErrorCodes.organizations_disabled, "Organizations are not enabled for this instance");
  if (!orgs.creationEnabled || !user.createOrganizationEnabled) {
    throw new OrbitError(403, ErrorCodes.organization_creation_not_allowed, "You are not allowed to create organizations");
  }
  const limit = user.createOrganizationsLimit ?? orgs.maxCreatedOrganizationsPerUser;
  if (limit !== null && limit !== undefined) {
    const created = (await ctx.db.select({ id: s.organizations.id }).from(s.organizations).where(eq(s.organizations.createdBy, user.id))).length;
    if (created >= limit) {
      throw new OrbitError(403, ErrorCodes.organization_creation_not_allowed, `You have reached the maximum of ${limit} organization${limit === 1 ? "" : "s"}`, { limit });
    }
  }
}

export async function assertOrganizationCapacity(ctx: AppContext, org: OrgRow, opts: { includePendingInvitations?: boolean } = {}): Promise<void> {
  const members = (await ctx.db.select({ id: s.organizationMemberships.id }).from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, org.id))).length;
  const pending = opts.includePendingInvitations
    ? (await ctx.db.select({ id: s.organizationInvitations.id }).from(s.organizationInvitations).where(and(eq(s.organizationInvitations.organizationId, org.id), eq(s.organizationInvitations.status, "pending")))).length
    : 0;
  if (members + pending >= org.maxAllowedMemberships) {
    throw new OrbitError(403, ErrorCodes.organization_membership_quota_exceeded, "This organization has reached its maximum number of memberships", {
      max_allowed_memberships: org.maxAllowedMemberships,
    });
  }
}

/** Inserts a membership (idempotent). Emits `organizationMembership.created` only when this call created the row. */
export async function addMembership(ctx: AppContext, input: {
  organizationId: string;
  userId: string;
  roleKey: string;
  publicMetadata?: Record<string, unknown>;
  privateMetadata?: Record<string, unknown>;
}): Promise<MembershipRow> {
  const { membership, created } = await insertMembership(ctx, input);
  if (created) {
    await emitEvent(ctx, "organizationMembership.created", await serializeMembership(ctx, membership, { backend: true }));
  }
  return membership;
}

/**
 * Inserts the membership row, reporting whether this call created it. A crash before the caller's
 * compensation can run leaves the membership in place, which is harmless: the unique index makes a
 * retry reuse it instead of creating a second one.
 */
async function insertMembership(ctx: AppContext, input: {
  organizationId: string;
  userId: string;
  roleKey: string;
  publicMetadata?: Record<string, unknown>;
  privateMetadata?: Record<string, unknown>;
}): Promise<{ membership: MembershipRow; created: boolean }> {
  const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, input.organizationId)));
  if (!org) throw new OrbitError(404, ErrorCodes.organization_not_found, "Organization not found");
  const existing = first(await ctx.db
      .select()
      .from(s.organizationMemberships)
      .where(and(eq(s.organizationMemberships.organizationId, input.organizationId), eq(s.organizationMemberships.userId, input.userId))));
  if (existing) return { membership: existing, created: false };
  await assertOrganizationCapacity(ctx, org);
  const now = Date.now();
  // The unique index is the arbiter: parallel callers cannot create the membership twice.
  const row = first(await ctx.db.insert(s.organizationMemberships).values({
            id: newId(ID_PREFIX.membership), organizationId: input.organizationId, userId: input.userId, roleKey: input.roleKey,
            publicMetadata: input.publicMetadata ?? {}, privateMetadata: input.privateMetadata ?? {}, createdAt: now, updatedAt: now,
          })
    .onConflictDoNothing({ target: [s.organizationMemberships.organizationId, s.organizationMemberships.userId] })
    .returning());
  if (!row) {
    const raced = first(await ctx.db
      .select()
      .from(s.organizationMemberships)
      .where(and(eq(s.organizationMemberships.organizationId, input.organizationId), eq(s.organizationMemberships.userId, input.userId))))!;
    return { membership: raced, created: false };
  }
  return { membership: row, created: true };
}

/**
 * Accepts a pending invitation.
 *
 * The membership is inserted first and the conditional status flip is the gate. That order matters: a
 * process kill between the two writes leaves a harmless extra membership next to a still-pending
 * invitation, which a retry reuses (inserting is idempotent) and completes. The reverse order would
 * leave an accepted invitation without a membership, which no retry could repair.
 */
export async function acceptInvitation(ctx: AppContext, invitation: InvitationRow, userId: string): Promise<MembershipRow | null> {
  const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, invitation.organizationId)));
  if (!org) return null;

  // Insert first, without a webhook: nothing is announced until the invitation is actually consumed.
  const { membership, created } = await insertMembership(ctx, {
    organizationId: invitation.organizationId,
    userId,
    roleKey: invitation.roleKey,
    publicMetadata: invitation.publicMetadata,
  });

  const now = Date.now();
  const accepted = first(await ctx.db.update(s.organizationInvitations).set({ status: "accepted", updatedAt: now })
    .where(and(
      eq(s.organizationInvitations.id, invitation.id),
      eq(s.organizationInvitations.status, "pending"),
      or(isNull(s.organizationInvitations.expiresAt), gt(s.organizationInvitations.expiresAt, now)),
    ))
    .returning());
  if (!accepted) {
    // The conditional update lost, so this call did not consume the invitation. A parallel accept by the
    // same user may have won instead: then its membership is the result, and this call still announces the
    // creation it made (the winner saw a pre-existing row and stays silent).
    const current = first(await ctx.db.select().from(s.organizationInvitations).where(eq(s.organizationInvitations.id, invitation.id)));
    if (current?.status === "accepted") {
      if (created) await emitEvent(ctx, "organizationMembership.created", await serializeMembership(ctx, membership, { backend: true }));
      return first(await ctx.db.select().from(s.organizationMemberships)
        .where(and(eq(s.organizationMemberships.organizationId, invitation.organizationId), eq(s.organizationMemberships.userId, userId)))) ?? null;
    }
    // Revoked or expired: take back exactly the row this call created, and only that row, so a dead
    // invitation never leaves a membership behind and a concurrent winner is never disturbed.
    if (created) {
      await ctx.db.delete(s.organizationMemberships)
        .where(and(eq(s.organizationMemberships.id, membership.id), eq(s.organizationMemberships.userId, userId)));
    }
    return null;
  }

  if (created) await emitEvent(ctx, "organizationMembership.created", await serializeMembership(ctx, membership, { backend: true }));
  await emitEvent(ctx, "organizationInvitation.accepted", await serializeOrganizationInvitation(ctx, accepted, { backend: true }));
  return membership;
}

export interface CreateInvitationInput {
  organization: OrgRow;
  email: string;
  roleKey?: string;
  inviterUserId?: string | null;
  redirectUrl?: string | null;
  publicMetadata?: Record<string, unknown>;
  privateMetadata?: Record<string, unknown>;
  expiresAt?: number | null;
}

/**
 * Creates a pending invitation. Throws 409 `duplicate_record` when the mailbox is already a member or already invited,
 * and 403 `organization_membership_quota_exceeded` when pending invitations + members reach the organization limit.
 * Returns the plaintext ticket (only available once; the DB stores its sha256).
 */
export async function createOrganizationInvitation(ctx: AppContext, input: CreateInvitationInput): Promise<{ invitation: InvitationRow; ticket: string }> {
  const email = normalizeEmail(input.email);
  const roleKey = input.roleKey ?? await defaultRoleKey(ctx);
  const role = await roleByKey(ctx, roleKey);
  if (!role) throw new OrbitError(422, ErrorCodes.org_role_not_found, `Role ${roleKey} does not exist`, { param_name: "role" });
  const member = first(await ctx.db
      .select()
      .from(s.organizationMemberships)
      .innerJoin(s.users, eq(s.users.id, s.organizationMemberships.userId))
      .innerJoin(s.emailAddresses, eq(s.emailAddresses.userId, s.users.id))
      .where(and(eq(s.organizationMemberships.organizationId, input.organization.id), eq(s.emailAddresses.email, email))));
  if (member) throw new OrbitError(409, ErrorCodes.duplicate_record, `${email} is already a member of this organization`);
  const pending = first(await ctx.db
      .select()
      .from(s.organizationInvitations)
      .where(and(eq(s.organizationInvitations.organizationId, input.organization.id), eq(s.organizationInvitations.email, email), eq(s.organizationInvitations.status, "pending"))));
  if (pending) throw new OrbitError(409, ErrorCodes.duplicate_record, `${email} has already been invited to this organization`);
  await assertOrganizationCapacity(ctx, input.organization, { includePendingInvitations: true });

  const now = Date.now();
  const id = newId(ID_PREFIX.invitation);
  const ticket = randomToken(32);
  await ctx.db.insert(s.organizationInvitations).values({
            id,
            organizationId: input.organization.id,
            email,
            roleKey,
            status: "pending",
            tokenHash: sha256(ticket),
            inviterUserId: input.inviterUserId ?? null,
            redirectUrl: input.redirectUrl ?? null,
            publicMetadata: input.publicMetadata ?? {},
            privateMetadata: input.privateMetadata ?? {},
            expiresAt: input.expiresAt ?? now + INVITATION_TTL_MS,
            createdAt: now,
            updatedAt: now,
          });
  const row = first(await ctx.db.select().from(s.organizationInvitations).where(eq(s.organizationInvitations.id, id)))!;
  await emitEvent(ctx, "organizationInvitation.created", await serializeOrganizationInvitation(ctx, row, { backend: true }));
  return { invitation: row, ticket };
}

/** Adds every existing user with a verified email on the domain to the organization (`automatic_invitation`). */
export async function applyDomainEnrollment(ctx: AppContext, domain: DomainRow, extraUserIds: string[] = []): Promise<number> {
  const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, domain.organizationId)));
  if (!org) return 0;
  const suffix = `@${domain.name.toLowerCase()}`;
  const userIds = new Set<string>(extraUserIds);
  for (const row of (await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.verified, true)))) {
    if (row.userId && row.email.toLowerCase().endsWith(suffix)) userIds.add(row.userId);
  }
  const roleKey = await defaultRoleKey(ctx);
  let added = 0;
  for (const userId of userIds) {
    const existing = first(await ctx.db
          .select()
          .from(s.organizationMemberships)
          .where(and(eq(s.organizationMemberships.organizationId, org.id), eq(s.organizationMemberships.userId, userId))));
    if (existing) continue;
    try {
      await addMembership(ctx, { organizationId: org.id, userId, roleKey });
      added++;
    } catch (err) {
      if (err instanceof OrbitError && err.code === ErrorCodes.organization_membership_quota_exceeded) break;
      throw err;
    }
  }
  return added;
}

/** Emits `organizationDomain.*` for a domain row (used by both APIs). */
export async function emitDomainEvent(ctx: AppContext, type: "organizationDomain.created" | "organizationDomain.updated" | "organizationDomain.deleted", domain: DomainRow): Promise<void> {
  await emitEvent(ctx, type, await serializeOrganizationDomain(ctx, domain));
}
