import { and, count, eq, inArray, sql } from "drizzle-orm";
import type {
  EmailAddressJSON, ExternalAccountJSON, OrganizationJSON, OrganizationMembershipJSON, PasskeyJSON, PhoneNumberJSON, SessionJSON, UserJSON, VerificationJSON,
} from "@orbitid/shared";
import type { AppContext } from "./context";
import * as s from "./db/schema";
import { first } from "./lib/db";

type UserRow = typeof s.users.$inferSelect;
/** Low-chroma tints, so a list of people reads as one set instead of a rainbow. */
const AVATAR_TINTS = ["#d9d4cc", "#cfd3d6", "#d6d0c4", "#c9cfc8", "#d8cfd0", "#cbd0d9"];

const initialsOf = (seed: string): string => {
  const words = seed.split("@")[0]!.split(/[\s._-]+/);
  const letters = words.map((w) => /[\p{L}\p{N}]/u.exec(w)?.[0]?.toUpperCase() ?? "").filter(Boolean).slice(0, 2).join("");
  return letters || "?";
};

/** A generated initials image, made here. Nothing is fetched from a third party. */
export const DEFAULT_AVATAR = (seed: string): string => {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" fill="${AVATAR_TINTS[hash % AVATAR_TINTS.length]}"/><text x="32" y="32" dy=".35em" text-anchor="middle" font-family="Helvetica, Arial, sans-serif" font-size="26" font-weight="600" fill="#2a2623">${initialsOf(seed)}</text></svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
};

export const verifiedVerification = (strategy: string, at: number | null): VerificationJSON => ({ status: "verified", strategy, attempts: null, expire_at: null });
const unverified = (strategy: string): VerificationJSON => ({ status: "unverified", strategy, attempts: 0, expire_at: null });

export function serializeEmail(e: typeof s.emailAddresses.$inferSelect): EmailAddressJSON {
  return {
    object: "email_address", id: e.id, email_address: e.email,
    verification: e.verified ? verifiedVerification(e.verifiedStrategy ?? "email_code", e.verifiedAt) : unverified("email_code"),
    linked_to: [], reserved: e.reserved, created_at: e.createdAt, updated_at: e.updatedAt,
  };
}
export function serializePhone(p: typeof s.phoneNumbers.$inferSelect): PhoneNumberJSON {
  return {
    object: "phone_number", id: p.id, phone_number: p.phone, reserved_for_second_factor: p.reservedForSecondFactor, default_second_factor: p.defaultSecondFactor,
    verification: p.verified ? verifiedVerification("phone_code", p.verifiedAt) : unverified("phone_code"), linked_to: [], created_at: p.createdAt, updated_at: p.updatedAt,
  };
}
export function serializeExternalAccount(x: typeof s.externalAccounts.$inferSelect): ExternalAccountJSON {
  return {
    object: "external_account", id: x.id, provider: x.provider, provider_user_id: x.providerUserId, identification_id: x.id, email_address: x.emailAddress,
    first_name: x.firstName, last_name: x.lastName, username: x.username, image_url: x.imageUrl, avatar_url: x.imageUrl, approved_scopes: x.approvedScopes,
    public_metadata: x.publicMetadata, label: null, verification: verifiedVerification(`from_oauth_${x.provider}`, x.createdAt), created_at: x.createdAt, updated_at: x.updatedAt,
  };
}
export function serializePasskey(p: typeof s.passkeys.$inferSelect): PasskeyJSON {
  return { object: "passkey", id: p.id, name: p.name, verification: verifiedVerification("passkey", p.createdAt), last_used_at: p.lastUsedAt, created_at: p.createdAt, updated_at: p.updatedAt };
}

/** `backend: true` includes private_metadata. */
export async function serializeUser(ctx: AppContext, u: UserRow, opts: { backend?: boolean } = {}): Promise<UserJSON> {
  const emails = (await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.userId, u.id)));
  const phones = (await ctx.db.select().from(s.phoneNumbers).where(eq(s.phoneNumbers.userId, u.id)));
  const externals = (await ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.userId, u.id)));
  const pks = (await ctx.db.select().from(s.passkeys).where(eq(s.passkeys.userId, u.id)));
  const st = ctx.settings.get();
  const lockedNow = u.locked && (!u.lockoutExpiresAt || u.lockoutExpiresAt > Date.now());
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || emails[0]?.email || u.id;
  const json: UserJSON = {
    object: "user", id: u.id, external_id: u.externalId, username: u.username, first_name: u.firstName, last_name: u.lastName,
    image_url: u.imageUrl ?? DEFAULT_AVATAR(name), has_image: u.hasImage,
    primary_email_address_id: u.primaryEmailAddressId, primary_phone_number_id: u.primaryPhoneNumberId,
    password_enabled: !!u.passwordHash, totp_enabled: u.totpVerified, backup_code_enabled: !!u.backupCodes?.length,
    two_factor_enabled: u.totpVerified || phones.some((p) => p.reservedForSecondFactor && p.verified),
    passkeys: pks.map(serializePasskey), email_addresses: emails.map(serializeEmail), phone_numbers: phones.map(serializePhone), external_accounts: externals.map(serializeExternalAccount),
    public_metadata: u.publicMetadata, unsafe_metadata: u.unsafeMetadata,
    banned: u.banned, locked: lockedNow, lockout_expires_in_seconds: lockedNow && u.lockoutExpiresAt ? Math.ceil((u.lockoutExpiresAt - Date.now()) / 1000) : null,
    verification_attempts_remaining: Math.max(0, st.mfa.maxAttempts - u.failedAttempts),
    delete_self_enabled: u.deleteSelfEnabled, create_organization_enabled: u.createOrganizationEnabled, create_organizations_limit: u.createOrganizationsLimit,
    last_sign_in_at: u.lastSignInAt, last_active_at: u.lastActiveAt, legal_accepted_at: u.legalAcceptedAt, created_at: u.createdAt, updated_at: u.updatedAt,
  };
  if (opts.backend) json.private_metadata = u.privateMetadata;
  return json;
}

export async function publicUserData(ctx: AppContext, u: UserRow) {
  const email = u.primaryEmailAddressId ? first(await ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.id, u.primaryEmailAddressId))) : undefined;
  const name = [u.firstName, u.lastName].filter(Boolean).join(" ") || u.username || email?.email || u.id;
  return { user_id: u.id, first_name: u.firstName, last_name: u.lastName, image_url: u.imageUrl ?? DEFAULT_AVATAR(name), has_image: u.hasImage, identifier: email?.email ?? u.username ?? "" };
}

export async function serializeSession(ctx: AppContext, r: typeof s.sessions.$inferSelect, opts: { withUser?: boolean; lastToken?: string | null } = {}): Promise<SessionJSON> {
  const u = first(await ctx.db.select().from(s.users).where(eq(s.users.id, r.userId)));
  const mins = (t: number | null) => (t ? Math.floor((Date.now() - t) / 60000) : -1);
  return {
    object: "session", id: r.id, status: r.status as SessionJSON["status"], expire_at: r.expireAt, abandon_at: r.abandonAt, last_active_at: r.lastActiveAt,
    last_active_organization_id: r.lastActiveOrganizationId, actor: (r.actor as SessionJSON["actor"]) ?? null,
    user: opts.withUser && u ? await serializeUser(ctx, u) : null, public_user_data: u ? await publicUserData(ctx, u) : null,
    factor_verification_age: [mins(r.firstFactorVerifiedAt), mins(r.secondFactorVerifiedAt)],
    sign_in_method: (r.authMethod as SessionJSON["sign_in_method"]) ?? null,
    last_active_token: opts.lastToken ? { object: "token", jwt: opts.lastToken } : null,
    latest_activity: { id: r.id, is_mobile: /mobile/i.test(r.userAgent ?? ""), ip_address: r.ip ?? "", city: r.city, country: r.country, browser_name: r.userAgent?.split(" ").pop()?.split("/")[0] ?? "", browser_version: r.userAgent?.split("/").pop() ?? "", device_type: "" },
    created_at: r.createdAt, updated_at: r.updatedAt,
  };
}

export async function serializeOrganization(ctx: AppContext, o: typeof s.organizations.$inferSelect, opts: { backend?: boolean; counts?: boolean } = {}): Promise<OrganizationJSON> {
  const json: OrganizationJSON = {
    object: "organization", id: o.id, name: o.name, slug: o.slug ?? "", image_url: o.imageUrl ?? DEFAULT_AVATAR(o.name), has_image: o.hasImage,
    max_allowed_memberships: o.maxAllowedMemberships, admin_delete_enabled: o.adminDeleteEnabled, public_metadata: o.publicMetadata, created_by: o.createdBy,
    created_at: o.createdAt, updated_at: o.updatedAt,
  };
  if (opts.counts !== false) {
    json.members_count = first(await ctx.db.select({ n: count() }).from(s.organizationMemberships).where(eq(s.organizationMemberships.organizationId, o.id)))?.n ?? 0;
    json.pending_invitations_count = first(await ctx.db.select({ n: count() }).from(s.organizationInvitations).where(and(eq(s.organizationInvitations.organizationId, o.id), eq(s.organizationInvitations.status, "pending"))))?.n ?? 0;
  }
  if (opts.backend) json.private_metadata = o.privateMetadata;
  return json;
}

/** Permissions granted by a role key (`org:admin` → ["org:sys_profile:manage", ...]). */
export async function permissionsForRole(ctx: AppContext, roleKey: string): Promise<string[]> {
  const role = first(await ctx.db.select().from(s.roles).where(eq(s.roles.key, roleKey)));
  if (!role) return [];
  const rp = (await ctx.db.select({ pid: s.rolePermissions.permissionId }).from(s.rolePermissions).where(eq(s.rolePermissions.roleId, role.id)));
  if (!rp.length) return [];
  return (await ctx.db.select({ key: s.permissions.key }).from(s.permissions).where(inArray(s.permissions.id, rp.map((r) => r.pid)))).map((p) => p.key);
}

export async function serializeMembership(ctx: AppContext, m: typeof s.organizationMemberships.$inferSelect, opts: { backend?: boolean } = {}): Promise<OrganizationMembershipJSON> {
  const org = first(await ctx.db.select().from(s.organizations).where(eq(s.organizations.id, m.organizationId)))!;
  const user = first(await ctx.db.select().from(s.users).where(eq(s.users.id, m.userId)))!;
  const role = first(await ctx.db.select().from(s.roles).where(eq(s.roles.key, m.roleKey)));
  const json: OrganizationMembershipJSON = {
    object: "organization_membership", id: m.id, role: m.roleKey, role_name: role?.name ?? m.roleKey, permissions: await permissionsForRole(ctx, m.roleKey),
    public_metadata: m.publicMetadata, organization: await serializeOrganization(ctx, org, { backend: opts.backend }), public_user_data: await publicUserData(ctx, user),
    created_at: m.createdAt, updated_at: m.updatedAt,
  };
  if (opts.backend) json.private_metadata = m.privateMetadata;
  return json;
}
