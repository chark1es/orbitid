// Frontend API organizations (mounted at /v1/client)
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Hono } from "hono";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError, ID_PREFIX } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { safeEqual, sha256 } from "../lib/crypto";
import { newId } from "../lib/ids";
import { filterAsync } from "../lib/async";
import { parseBody } from "../lib/http";
import { validateRedirectUrl } from "./auth/redirects";
import { emitEvent } from "../services/webhooks";
import { sendEmail } from "../services/mail";
import { serializeMembership, serializeOrganization } from "../serializers";
import {
  addMembership, acceptInvitation, applyDomainEnrollment, assertOrganizationCapacity, assertCanCreateOrganization,
  createOrganizationInvitation, creatorRoleKey, defaultRoleKey, emitDomainEvent,
} from "../services/orgs";
import {
  deletePendingForDomain, emailDomain, findDomain, findDomainByName, hasSuggestionForOrganization,
  normalizeDomain, normalizeEmail, suggestedOrganizations, userVerifiedEmails,
} from "../services/org-domains";
import { assertAssignableRole, assertNotLastAdmin, isAdminRole, isLastAdmin, roleByKey, PERMISSIONS } from "../services/rbac";
import { resolveCaller, tryResolveCaller } from "./orgs/auth";
import {
  deletedObject, fapiList, findMembership, invitationUrl, listParams, orgAccess, page,
  requireDomainsEnabled, requireMembership, requireMembershipRequestsEnabled, requireOrganization, requireOrganizationsEnabled,
  resolveSlug, sortRows, type OrganizationRow,
} from "./orgs/shared";
import { deleteLogoFile, logoContentType, readLogoPayload, storeLogo, uploadDir } from "./orgs/assets";
import {
  orgIdFromSuggestionId, serializeMembershipRequest, serializeOrganizationDomain, serializeOrganizationInvitation, serializeRole, serializeSuggestion,
} from "./orgs/serializers";
import { first } from "../lib/db";

const emailList = z.array(z.string().min(3));

/** Rejects addresses already members or already invited, so bulk sends stay idempotent. */
async function dedupeRecipients(ctx: AppContext, org: OrganizationRow, emails: string[]): Promise<string[]> {
  const members = new Set<string>();
  for (const row of (await ctx.db
      .select({ email: s.emailAddresses.email })
      .from(s.organizationMemberships)
      .innerJoin(s.users, eq(s.users.id, s.organizationMemberships.userId))
      .innerJoin(s.emailAddresses, eq(s.emailAddresses.userId, s.users.id))
      .where(eq(s.organizationMemberships.organizationId, org.id)))) members.add(row.email.toLowerCase());
  const pending = new Set(
    (await ctx.db
            .select()
            .from(s.organizationInvitations)
            .where(and(eq(s.organizationInvitations.organizationId, org.id), eq(s.organizationInvitations.status, "pending"))))
      .map((r) => r.email.toLowerCase()),
  );
  return [...new Set(emails.map((e) => e.trim().toLowerCase()))].filter((e) => !members.has(e) && !pending.has(e));
}

export default function routes(ctx: AppContext) {
  const app = new Hono();

  const emitOrg = async (type: "organization.created" | "organization.updated" | "organization.deleted", org: OrganizationRow) => {
    await emitEvent(ctx, type, await serializeOrganization(ctx, org, { backend: true }));
  };

  // ─────────── public: logo files ───────────
  app.get("/organization_logos/:file", (c) => {
    const file = c.req.param("file");
    if (!/^[A-Za-z0-9_.-]+$/.test(file) || file.includes("..")) return c.json({ errors: [{ code: ErrorCodes.resource_not_found, message: "Not found" }] }, 404);
    try {
      const bytes = readFileSync(resolve(uploadDir(ctx), file));
      return new Response(new Uint8Array(bytes), {
        status: 200,
        headers: {
          "content-type": logoContentType(file),
          "x-content-type-options": "nosniff",
          "content-security-policy": "sandbox",
          "cache-control": "public, max-age=31536000, immutable",
        },
      });
    } catch {
      return c.json({ errors: [{ code: ErrorCodes.resource_not_found, message: "Not found" }] }, 404);
    }
  });

  // ─────────── public: invitation acceptance link (from the invitation email) ───────────
  app.get("/organization_invitations/accept", async (c) => {
    const ticket = c.req.query("ticket");
    if (!ticket) throw new OrbitError(400, ErrorCodes.form_param_missing, "ticket is missing", { param_name: "ticket" });
    const invitation = first(await ctx.db.select().from(s.organizationInvitations).where(eq(s.organizationInvitations.tokenHash, sha256(ticket))));
    if (!invitation) throw new OrbitError(422, ErrorCodes.ticket_invalid, "Organization invitation ticket is invalid");
    if (invitation.status === "revoked") throw new OrbitError(422, ErrorCodes.ticket_invalid, "Organization invitation has been revoked");
    if (invitation.status === "pending") {
      if (invitation.expiresAt && invitation.expiresAt <= Date.now()) throw new OrbitError(422, ErrorCodes.ticket_expired, "Organization invitation has expired");
      const caller = await tryResolveCaller(ctx, c);
      if (caller && (await userVerifiedEmails(ctx, caller.userId)).includes(invitation.email.toLowerCase())) {
        await acceptInvitation(ctx, invitation, caller.userId);
      }
    }
    const requested = validateRedirectUrl(ctx, c.req.query("redirect_url") || invitation.redirectUrl);
    const target = new URL(requested ?? (ctx.settings.get().application.homeUrl || ctx.env.baseUrl));
    // No `__orbit_ticket` here: the SDK would present it as a sign-in ticket, which it is not. A signed-out invitee
    // signs up or in normally, and verifying the invited address joins the organization.
    return c.redirect(target.toString(), 302);
  });

  // ─────────── current user ───────────
  app.get("/me/organization_memberships", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const session = first(await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, caller.sessionId)));
    const activeOrgId = session?.lastActiveOrganizationId ?? null;
    const membershipRows = await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.userId, caller.userId));
    const rows = (await Promise.all(membershipRows.map((row) => serializeMembership(ctx, row))))
      .sort((a, b) => {
        if (a.organization.id === activeOrgId) return -1;
        if (b.organization.id === activeOrgId) return 1;
        return b.created_at - a.created_at;
      });
    const params = listParams(c);
    if (params.paginated) {
      const { items, total } = page(rows, params);
      return c.json({ data: items, total_count: total });
    }
    return c.json({ response: rows });
  });

  app.post("/me/organization_memberships", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const body = await parseBody(c, z.object({ organization_id: z.string().min(1) }));
    const org = await requireOrganization(ctx, body.organization_id);
    if (first(await ctx.db.select().from(s.organizationMemberships).where(and(eq(s.organizationMemberships.organizationId, org.id), eq(s.organizationMemberships.userId, caller.userId))))) {
      throw new OrbitError(409, ErrorCodes.duplicate_record, "You are already a member of this organization");
    }
    if (!await hasSuggestionForOrganization(ctx, caller.userId, org.id)) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "This organization cannot be joined directly");
    }
    const membership = await addMembership(ctx, { organizationId: org.id, userId: caller.userId, roleKey: await defaultRoleKey(ctx) });
    return c.json({ response: await serializeMembership(ctx, membership) });
  });

  app.delete("/me/organization_memberships/:orgId", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const org = await requireOrganization(ctx, c.req.param("orgId"));
    const membership = await requireMembership(ctx, org, caller.userId);
    await assertNotLastAdmin(ctx, membership, "You are the last admin of this organization and cannot leave it");
    const payload = await serializeMembership(ctx, membership, { backend: true });
    await ctx.db.delete(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id));
    await emitEvent(ctx, "organizationMembership.deleted", payload);
    return c.json({ response: deletedObject("organization_membership", membership.id) });
  });

  app.get("/me/organization_invitations", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const emails = await userVerifiedEmails(ctx, caller.userId);
    if (!emails.length) return c.json({ response: [] });
    const now = Date.now();
    const rows = (await Promise.all((await ctx.db
              .select()
              .from(s.organizationInvitations))
          .filter((r) => r.status === "pending" && emails.includes(r.email.toLowerCase()) && (!r.expiresAt || r.expiresAt > now))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((row) => serializeOrganizationInvitation(ctx, row))));
    return c.json({ response: rows });
  });

  app.post("/me/organization_invitations/:id/accept", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const invitation = first(await ctx.db.select().from(s.organizationInvitations).where(eq(s.organizationInvitations.id, c.req.param("id"))));
    if (!invitation) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization invitation not found");
    if (!(await userVerifiedEmails(ctx, caller.userId)).includes(invitation.email.toLowerCase())) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "This invitation is addressed to a different email address");
    }
    if (invitation.status !== "pending") throw new OrbitError(409, ErrorCodes.duplicate_record, `Invitation is ${invitation.status}`);
    if (invitation.expiresAt && invitation.expiresAt <= Date.now()) throw new OrbitError(422, ErrorCodes.ticket_expired, "Organization invitation has expired");
    const membership = await acceptInvitation(ctx, invitation, caller.userId);
    if (!membership) throw new OrbitError(409, ErrorCodes.duplicate_record, "Invitation is no longer pending");
    return c.json({ response: await serializeMembership(ctx, membership) });
  });

  app.get("/me/organization_suggestions", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const rows = (await Promise.all((await suggestedOrganizations(ctx, caller.userId)).map(({ organization, domain }) => serializeSuggestion(ctx, organization, domain))));
    return c.json({ response: rows });
  });

  app.post("/me/organization_suggestions/:id/accept", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const orgId = orgIdFromSuggestionId(c.req.param("id"));
    if (!orgId) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization suggestion not found");
    const org = await requireOrganization(ctx, orgId);
    if (!await hasSuggestionForOrganization(ctx, caller.userId, org.id)) {
      throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization suggestion not found");
    }
    const membership = await addMembership(ctx, { organizationId: org.id, userId: caller.userId, roleKey: await defaultRoleKey(ctx) });
    return c.json({ response: await serializeMembership(ctx, membership) });
  });

  // ─────────── organizations ───────────
  app.post("/organizations", async (c) => {
    requireOrganizationsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    await assertCanCreateOrganization(ctx, caller.user);
    const body = await parseBody(c, z.object({
      name: z.string().trim().min(1).max(256),
      slug: z.string().trim().min(1).max(50).optional(),
    }));
    const settings = ctx.settings.get();
    const now = Date.now();
    const id = newId(ID_PREFIX.org);
    await ctx.db.insert(s.organizations).values({
                  id,
                  name: body.name,
                  slug: await resolveSlug(ctx, settings.organizations.slugEnabled ? body.slug : undefined, body.name),
                  maxAllowedMemberships: settings.organizations.maxAllowedMemberships,
                  adminDeleteEnabled: settings.organizations.adminDeleteEnabled,
                  createdBy: caller.userId,
                  createdAt: now,
                  updatedAt: now,
                });
    const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, id)))!;
    await addMembership(ctx, { organizationId: org.id, userId: caller.userId, roleKey: await creatorRoleKey(ctx) });
    await emitOrg("organization.created", org);
    return c.json({ response: await serializeOrganization(ctx, org) }, 200);
  });

  app.get("/organizations/:id", async (c) => {
    const { org } = await orgAccess(ctx, c);
    return c.json({ response: await serializeOrganization(ctx, org) });
  });

  app.patch("/organizations/:id", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.PROFILE_MANAGE);
    const body = await parseBody(c, z.object({
      name: z.string().trim().min(1).max(256).optional(),
      slug: z.string().trim().min(1).max(50).optional(),
    }));
    const settings = ctx.settings.get();
    const patch: Partial<typeof s.organizations.$inferInsert> = { updatedAt: Date.now() };
    if (body.name !== undefined) patch.name = body.name;
    if (body.slug !== undefined) patch.slug = settings.organizations.slugEnabled ? await resolveSlug(ctx, body.slug, body.name ?? org.name, org.id) : org.slug;
    await ctx.db.update(s.organizations).set(patch).where(eq(s.organizations.id, org.id));
    const updated = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, org.id)))!;
    await emitOrg("organization.updated", updated);
    return c.json({ response: await serializeOrganization(ctx, updated) });
  });

  app.delete("/organizations/:id", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.PROFILE_DELETE);
    if (!org.adminDeleteEnabled) throw new OrbitError(403, ErrorCodes.not_allowed_access, "Deleting this organization is disabled for admins");
    const payload = await serializeOrganization(ctx, org, { backend: true });
    deleteLogoFile(ctx, org.imageUrl);
    await ctx.db.delete(s.organizations).where(eq(s.organizations.id, org.id));
    await emitEvent(ctx, "organization.deleted", payload);
    return c.json({ response: deletedObject("organization", org.id) });
  });

  app.put("/organizations/:id/logo", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.PROFILE_MANAGE);
    const { data, mime } = await readLogoPayload(c);
    const file = storeLogo(ctx, org.id, data, mime);
    deleteLogoFile(ctx, org.imageUrl);
    const imageUrl = `${ctx.env.baseUrl}/v1/client/organization_logos/${file}`;
    await ctx.db.update(s.organizations).set({ imageUrl, hasImage: true, updatedAt: Date.now() }).where(eq(s.organizations.id, org.id));
    const updated = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, org.id)))!;
    await emitOrg("organization.updated", updated);
    return c.json({ response: await serializeOrganization(ctx, updated) });
  });

  app.delete("/organizations/:id/logo", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.PROFILE_MANAGE);
    deleteLogoFile(ctx, org.imageUrl);
    await ctx.db.update(s.organizations).set({ imageUrl: null, hasImage: false, updatedAt: Date.now() }).where(eq(s.organizations.id, org.id));
    const updated = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, org.id)))!;
    await emitOrg("organization.updated", updated);
    return c.json({ response: await serializeOrganization(ctx, updated) });
  });

  // ─────────── memberships ───────────
  app.get("/organizations/:id/memberships", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_READ);
    const params = listParams(c);
    const role = c.req.query("role");
    let rows = (await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, org.id)));
    if (role) rows = await filterAsync(rows, async (r) => r.roleKey === role || ((await roleByKey(ctx, r.roleKey))?.name ?? "").toLowerCase() === role.toLowerCase());
    const serialized = await Promise.all(rows.map((row) => serializeMembership(ctx, row)));
    const filtered = params.query
      ? serialized.filter((m) =>
        [m.public_user_data.identifier, m.public_user_data.first_name, m.public_user_data.last_name, m.public_user_data.user_id]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(params.query!)))
      : serialized;
    const rows2 = sortRows(filtered, params.orderBy ?? "-created_at", {
      created_at: (m) => m.created_at, updated_at: (m) => m.updated_at, role: (m) => m.role,
    });
    if (params.paginated) {
      const { items, total } = page(rows2, params);
      return c.json({ data: items, total_count: total });
    }
    return c.json({ response: rows2 });
  });

  app.patch("/organizations/:id/memberships/:userId", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const body = await parseBody(c, z.object({ role: z.string().min(1) }));
    const membership = await requireMembership(ctx, org, c.req.param("userId"));
    const role = await assertAssignableRole(ctx, body.role);
    if (role.key === membership.roleKey) return c.json({ response: await serializeMembership(ctx, membership) });
    if (await isLastAdmin(ctx, membership) && !await isAdminRole(ctx, role.key)) {
      throw new OrbitError(403, ErrorCodes.last_admin_cannot_leave, "The last admin of an organization cannot be demoted", { role: membership.roleKey });
    }
    await ctx.db.update(s.organizationMemberships).set({ roleKey: role.key, updatedAt: Date.now() }).where(eq(s.organizationMemberships.id, membership.id));
    const updated = first(await ctx.db.select().from(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id)))!;
    await emitEvent(ctx, "organizationMembership.updated", await serializeMembership(ctx, updated, { backend: true }));
    return c.json({ response: await serializeMembership(ctx, updated) });
  });

  app.delete("/organizations/:id/memberships/:userId", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const membership = await requireMembership(ctx, org, c.req.param("userId"));
    await assertNotLastAdmin(ctx, membership);
    const payload = await serializeMembership(ctx, membership, { backend: true });
    await ctx.db.delete(s.organizationMemberships).where(eq(s.organizationMemberships.id, membership.id));
    await emitEvent(ctx, "organizationMembership.deleted", payload);
    return c.json({ response: deletedObject("organization_membership", membership.id) });
  });

  // ─────────── invitations ───────────
  app.get("/organizations/:id/invitations", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_READ);
    const params = listParams(c);
    const status = c.req.query("status");
    const rows = (await ctx.db.select().from(s.organizationInvitations).where(eq(s.organizationInvitations.organizationId, org.id)));
    let serialized = await Promise.all(rows.map((row) => serializeOrganizationInvitation(ctx, row)));
    if (status) serialized = serialized.filter((r) => r.status === status);
    if (params.query) serialized = serialized.filter((r) => r.email_address.includes(params.query!));
    serialized = sortRows(serialized, params.orderBy ?? "-created_at", {
      created_at: (r) => r.created_at, updated_at: (r) => r.updated_at, email_address: (r) => r.email_address,
    });
    if (params.paginated) {
      const { items, total } = page(serialized, params);
      return c.json({ data: items, total_count: total });
    }
    return c.json({ response: serialized });
  });

  app.post("/organizations/:id/invitations", async (c) => {
    const { org, caller } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const body = await parseBody(c, z.object({
      email_address: z.string().optional(),
      email_addresses: emailList.optional(),
      role: z.string().optional(),
      redirect_url: z.string().optional(),
      expires_in_days: z.coerce.number().int().min(1).max(365).optional(),
    }));
    const bulk = body.email_addresses !== undefined;
    const emails = (body.email_addresses ?? (body.email_address ? [body.email_address] : [])).map(normalizeEmail);
    if (!emails.length) throw new OrbitError(422, ErrorCodes.form_param_missing, "email_address or email_addresses is required", { param_name: "email_address" });
    if (body.role) await assertAssignableRole(ctx, body.role);
    // Members and already-invited mailboxes are skipped so bulk calls stay idempotent.
    const recipients = await dedupeRecipients(ctx, org, emails);
    if (!bulk && !recipients.length) throw new OrbitError(409, ErrorCodes.duplicate_record, `${emails[0]} is already a member or has already been invited`);
    const inviter = [caller.user.firstName, caller.user.lastName].filter(Boolean).join(" ") || caller.user.username || caller.user.id;
    const created = [];
    for (const email of recipients) {
      const { invitation, ticket } = await createOrganizationInvitation(ctx, {
        organization: org,
        email,
        roleKey: body.role,
        inviterUserId: caller.userId,
        redirectUrl: validateRedirectUrl(ctx, body.redirect_url),
        expiresAt: body.expires_in_days ? Date.now() + body.expires_in_days * 24 * 60 * 60 * 1000 : null,
      });
      await sendEmail(ctx, {
        to: email,
        template: "organization_invitation",
        vars: {
          organization_name: org.name,
          organization_slug: org.slug ?? "",
          inviter_name: inviter,
          email_address: email,
          role: invitation.roleKey,
          invitation_url: invitationUrl(ctx, ticket),
          expires_in_days: body.expires_in_days ?? 30,
        },
      });
      created.push(await serializeOrganizationInvitation(ctx, invitation));
    }
    return c.json({ response: bulk ? created : created[0] });
  });

  app.post("/organizations/:id/invitations/:invId/revoke", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const invitation = first(await ctx.db
          .select()
          .from(s.organizationInvitations)
          .where(and(eq(s.organizationInvitations.organizationId, org.id), eq(s.organizationInvitations.id, c.req.param("invId")))));
    if (!invitation) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization invitation not found");
    const now = Date.now();
    const revoked = first(await ctx.db.update(s.organizationInvitations).set({ status: "revoked", updatedAt: now })
      .where(and(eq(s.organizationInvitations.id, invitation.id), eq(s.organizationInvitations.status, "pending")))
      .returning());
    if (!revoked) throw new OrbitError(409, ErrorCodes.duplicate_record, `Invitation is ${invitation.status}`);
    await emitEvent(ctx, "organizationInvitation.revoked", await serializeOrganizationInvitation(ctx, revoked, { backend: true }));
    return c.json({ response: await serializeOrganizationInvitation(ctx, revoked) });
  });

  // ─────────── domains ───────────
  app.get("/organizations/:id/domains", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.DOMAINS_READ);
    requireDomainsEnabled(ctx);
    const rows = (await Promise.all((await ctx.db.select().from(s.organizationDomains).where(eq(s.organizationDomains.organizationId, org.id)))
          .map((row) => serializeOrganizationDomain(ctx, row))));
    return fapiList(c, rows);
  });

  app.post("/organizations/:id/domains", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.DOMAINS_MANAGE);
    requireDomainsEnabled(ctx);
    const body = await parseBody(c, z.object({
      name: z.string().min(1),
      enrollment_mode: z.enum(["manual_invitation", "automatic_invitation", "automatic_suggestion"]).optional(),
    }));
    const name = normalizeDomain(body.name);
    if (await findDomainByName(ctx, org.id, name)) throw new OrbitError(409, ErrorCodes.duplicate_record, `${name} is already a domain of this organization`);
    const now = Date.now();
    const id = newId(ID_PREFIX.domain);
    await ctx.db.insert(s.organizationDomains).values({
                  id, organizationId: org.id, name, enrollmentMode: body.enrollment_mode ?? "manual_invitation", verified: false, createdAt: now, updatedAt: now,
                });
    const row = first(await ctx.db.select().from(s.organizationDomains).where(eq(s.organizationDomains.id, id)))!;
    await emitDomainEvent(ctx, "organizationDomain.created", row);
    return c.json({ response: await serializeOrganizationDomain(ctx, row) });
  });

  app.get("/organizations/:id/domains/:did", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.DOMAINS_READ);
    requireDomainsEnabled(ctx);
    const row = await findDomain(ctx, org.id, c.req.param("did"));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization domain not found");
    return c.json({ response: await serializeOrganizationDomain(ctx, row) });
  });

  app.delete("/organizations/:id/domains/:did", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.DOMAINS_MANAGE);
    requireDomainsEnabled(ctx);
    const row = await findDomain(ctx, org.id, c.req.param("did"));
    if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization domain not found");
    const payload = await serializeOrganizationDomain(ctx, row);
    await ctx.db.delete(s.organizationDomains).where(eq(s.organizationDomains.id, row.id));
    await emitEvent(ctx, "organizationDomain.deleted", payload);
    return c.json({ response: deletedObject("organization_domain", row.id) });
  });

  app.post("/organizations/:id/domains/:did/prepare_affiliation_verification", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.DOMAINS_MANAGE);
    requireDomainsEnabled(ctx);
    const domain = await findDomain(ctx, org.id, c.req.param("did"));
    if (!domain) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization domain not found");
    const body = await parseBody(c, z.object({ affiliation_email_address: z.string().min(3) }));
    const email = normalizeEmail(body.affiliation_email_address);
    if (emailDomain(email) !== domain.name) {
      throw new OrbitError(422, ErrorCodes.form_param_value_invalid, `Affiliation email address must belong to ${domain.name}`, { param_name: "affiliation_email_address" });
    }
    const settings = ctx.settings.get();
    const now = Date.now();
    const code = Array.from({ length: settings.email.codeLength }, () => Math.floor(Math.random() * 10)).join("");
    await ctx.db.insert(s.verifications).values({
                  id: newId(ID_PREFIX.verification), purpose: "org_domain", strategy: "email_code", identifier: email, ownerId: domain.id,
                  codeHash: sha256(code), attempts: 0, maxAttempts: 5, expiresAt: now + settings.email.codeLifetimeSeconds * 1000, createdAt: now,
                });
    await ctx.db.update(s.organizationDomains).set({ affiliationEmailAddress: email, updatedAt: now }).where(eq(s.organizationDomains.id, domain.id));
    const updated = first(await ctx.db.select().from(s.organizationDomains).where(eq(s.organizationDomains.id, domain.id)))!;
    await sendEmail(ctx, {
      to: email,
      template: "domain_verification_code",
      vars: { code, domain: domain.name, organization_name: org.name, expires_in_minutes: Math.round(settings.email.codeLifetimeSeconds / 60) },
    });
    return c.json({ response: await serializeOrganizationDomain(ctx, updated) });
  });

  app.post("/organizations/:id/domains/:did/attempt_affiliation_verification", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.DOMAINS_MANAGE);
    requireDomainsEnabled(ctx);
    const domain = await findDomain(ctx, org.id, c.req.param("did"));
    if (!domain) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization domain not found");
    const body = await parseBody(c, z.object({ code: z.string().min(1) }));
    const verification = (await ctx.db
          .select()
          .from(s.verifications)
          .where(and(eq(s.verifications.ownerId, domain.id), eq(s.verifications.purpose, "org_domain"))))
      .sort((a, b) => b.createdAt - a.createdAt)[0];
    if (!verification || verification.verifiedAt) {
      throw new OrbitError(422, ErrorCodes.verification_failed, "Start domain verification first");
    }
    if (verification.expiresAt <= Date.now()) throw new OrbitError(422, ErrorCodes.verification_expired, "Verification code has expired");
    if (verification.attempts >= verification.maxAttempts) throw new OrbitError(429, ErrorCodes.too_many_attempts, "Too many attempts. Request a new code.");
    await ctx.db.update(s.verifications).set({ attempts: verification.attempts + 1 }).where(eq(s.verifications.id, verification.id));
    if (!verification.codeHash || !safeEqual(sha256(body.code.trim()), verification.codeHash)) {
      throw new OrbitError(422, ErrorCodes.form_code_incorrect, "Verification code is incorrect", { param_name: "code" });
    }
    const now = Date.now();
    await ctx.db.update(s.verifications).set({ verifiedAt: now, consumedAt: now }).where(eq(s.verifications.id, verification.id));
    await ctx.db.update(s.organizationDomains).set({ verified: true, updatedAt: now }).where(eq(s.organizationDomains.id, domain.id));
    const updated = first(await ctx.db.select().from(s.organizationDomains).where(eq(s.organizationDomains.id, domain.id)))!;
    if (updated.enrollmentMode === "automatic_invitation") await applyDomainEnrollment(ctx, updated);
    await emitDomainEvent(ctx, "organizationDomain.updated", updated);
    return c.json({ response: await serializeOrganizationDomain(ctx, updated) });
  });

  app.post("/organizations/:id/domains/:did/update_enrollment_mode", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.DOMAINS_MANAGE);
    requireDomainsEnabled(ctx);
    const domain = await findDomain(ctx, org.id, c.req.param("did"));
    if (!domain) throw new OrbitError(404, ErrorCodes.resource_not_found, "Organization domain not found");
    const body = await parseBody(c, z.object({
      enrollment_mode: z.enum(["manual_invitation", "automatic_invitation", "automatic_suggestion"]),
      delete_pending: z.boolean().optional(),
    }));
    if (body.delete_pending) {
      for (const invitation of await deletePendingForDomain(ctx, org.id, domain.name)) {
        await emitEvent(ctx, "organizationInvitation.revoked", await serializeOrganizationInvitation(ctx, invitation, { backend: true }));
      }
    }
    await ctx.db.update(s.organizationDomains).set({ enrollmentMode: body.enrollment_mode, updatedAt: Date.now() }).where(eq(s.organizationDomains.id, domain.id));
    const updated = first(await ctx.db.select().from(s.organizationDomains).where(eq(s.organizationDomains.id, domain.id)))!;
    if (updated.verified && updated.enrollmentMode === "automatic_invitation") await applyDomainEnrollment(ctx, updated);
    await emitDomainEvent(ctx, "organizationDomain.updated", updated);
    return c.json({ response: await serializeOrganizationDomain(ctx, updated) });
  });

  // ─────────── membership requests ───────────
  app.post("/organizations/:id/membership_requests", async (c) => {
    requireOrganizationsEnabled(ctx);
    requireMembershipRequestsEnabled(ctx);
    const caller = await resolveCaller(ctx, c);
    const org = await requireOrganization(ctx, c.req.param("id"));
    if (await findMembership(ctx, org.id, caller.userId)) throw new OrbitError(409, ErrorCodes.duplicate_record, "You are already a member of this organization");
    const existing = first(await ctx.db
          .select()
          .from(s.organizationMembershipRequests)
          .where(and(eq(s.organizationMembershipRequests.organizationId, org.id), eq(s.organizationMembershipRequests.userId, caller.userId), eq(s.organizationMembershipRequests.status, "pending"))));
    if (existing) return c.json({ response: await serializeMembershipRequest(ctx, existing) });
    if (!await hasSuggestionForOrganization(ctx, caller.userId, org.id)) {
      throw new OrbitError(403, ErrorCodes.not_allowed_access, "Your verified email domain does not allow joining this organization");
    }
    const now = Date.now();
    const id = newId(ID_PREFIX.request);
    await ctx.db.insert(s.organizationMembershipRequests).values({ id, organizationId: org.id, userId: caller.userId, status: "pending", createdAt: now, updatedAt: now });
    const row = first(await ctx.db.select().from(s.organizationMembershipRequests).where(eq(s.organizationMembershipRequests.id, id)))!;
    return c.json({ response: await serializeMembershipRequest(ctx, row) });
  });

  app.get("/organizations/:id/membership_requests", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_READ);
    const status = c.req.query("status");
    const rows = (await Promise.all((await ctx.db.select().from(s.organizationMembershipRequests).where(eq(s.organizationMembershipRequests.organizationId, org.id)))
          .filter((r) => !status || r.status === status)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((row) => serializeMembershipRequest(ctx, row))));
    return fapiList(c, rows);
  });

  app.post("/organizations/:id/membership_requests/:rid/accept", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const request = await findMembershipRequest(ctx, org.id, c.req.param("rid"));
    if (request.status !== "pending") throw new OrbitError(409, ErrorCodes.duplicate_record, `Membership request is ${request.status}`);
    await assertOrganizationCapacity(ctx, org);
    const membership = await addMembership(ctx, { organizationId: org.id, userId: request.userId, roleKey: await defaultRoleKey(ctx) });
    await ctx.db.update(s.organizationMembershipRequests).set({ status: "accepted", updatedAt: Date.now() }).where(eq(s.organizationMembershipRequests.id, request.id));
    return c.json({ response: await serializeMembership(ctx, membership) });
  });

  app.post("/organizations/:id/membership_requests/:rid/reject", async (c) => {
    const { org } = await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_MANAGE);
    const request = await findMembershipRequest(ctx, org.id, c.req.param("rid"));
    if (request.status !== "pending") throw new OrbitError(409, ErrorCodes.duplicate_record, `Membership request is ${request.status}`);
    await ctx.db.update(s.organizationMembershipRequests).set({ status: "rejected", updatedAt: Date.now() }).where(eq(s.organizationMembershipRequests.id, request.id));
    const updated = first(await ctx.db.select().from(s.organizationMembershipRequests).where(eq(s.organizationMembershipRequests.id, request.id)))!;
    return c.json({ response: await serializeMembershipRequest(ctx, updated) });
  });

  // ─────────── roles (role dropdown of the OrganizationProfile) ───────────
  app.get("/organizations/:id/roles", async (c) => {
    await orgAccess(ctx, c, PERMISSIONS.MEMBERSHIPS_READ);
    const rows = (await Promise.all((await ctx.db.select().from(s.roles))
          .sort((a, b) => Number(b.isSystem) - Number(a.isSystem) || a.key.localeCompare(b.key))
          .map((row) => serializeRole(ctx, row))));
    return c.json({ response: rows });
  });

  return app;
}

async function findMembershipRequest(ctx: AppContext, orgId: string, id: string) {
  const row = first(await ctx.db
      .select()
      .from(s.organizationMembershipRequests)
      .where(and(eq(s.organizationMembershipRequests.organizationId, orgId), eq(s.organizationMembershipRequests.id, id))));
  if (!row) throw new OrbitError(404, ErrorCodes.resource_not_found, "Membership request not found");
  return row;
}
