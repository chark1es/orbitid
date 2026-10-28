// Shared fixtures for the W4 (machine) test suite: real app on an in-memory DB, rows inserted directly.
import { eq } from "drizzle-orm";
import { COOKIES, ID_PREFIX } from "@orbitid/shared";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import type { AppContext } from "../../src/context";
import * as s from "../../src/db/schema";
import { randomToken, sha256 } from "../../src/lib/crypto";
import { newId } from "../../src/lib/ids";

export const SECRET_KEY = "sk_test_w4_machine_secret";
export const BASE_URL = "http://localhost:4000";

export async function setup() {
  const ctx = await createContext({ databasePath: ":memory:", secretKey: SECRET_KEY, baseUrl: BASE_URL });
  return { ctx, app: createApp(ctx), secret: SECRET_KEY, baseUrl: BASE_URL };
}

export const authHeaders = (secret = SECRET_KEY) => ({ authorization: `Bearer ${secret}`, "content-type": "application/json" });

export function insertUser(ctx: AppContext, opts: { email?: string | null; firstName?: string; lastName?: string; username?: string } = {}) {
  const now = Date.now();
  const id = newId(ID_PREFIX.user);
  const email = opts.email === undefined ? "user@example.com" : opts.email;
  ctx.db.insert(s.users).values({
    id,
    username: opts.username ?? null,
    usernameLower: opts.username?.toLowerCase() ?? null,
    firstName: opts.firstName ?? "Ada",
    lastName: opts.lastName ?? "Lovelace",
    publicMetadata: {},
    privateMetadata: {},
    unsafeMetadata: {},
    createdAt: now,
    updatedAt: now,
  }).run();
  let emailId: string | null = null;
  if (email) {
    emailId = newId(ID_PREFIX.email);
    ctx.db.insert(s.emailAddresses).values({
      id: emailId, userId: id, email: email.toLowerCase(), verified: true, verifiedAt: now, verifiedStrategy: "email_code",
      reserved: false, createdAt: now, updatedAt: now,
    }).run();
    ctx.db.update(s.users).set({ primaryEmailAddressId: emailId }).where(eq(s.users.id, id)).run();
  }
  return { userId: id, emailId, email };
}

export function insertClientSession(ctx: AppContext, userId: string, opts: { token?: string } = {}) {
  const now = Date.now();
  const token = opts.token ?? randomToken(32);
  const clientId = newId(ID_PREFIX.client);
  const sessionId = newId(ID_PREFIX.session);
  ctx.db.insert(s.clients).values({ id: clientId, tokenHash: sha256(token), lastActiveSessionId: sessionId, ip: null, userAgent: "vitest", createdAt: now, updatedAt: now }).run();
  ctx.db.insert(s.sessions).values({
    id: sessionId, clientId, userId, status: "active", lastActiveAt: now, lastActiveOrganizationId: null,
    expireAt: now + 24 * 60 * 60 * 1000, abandonAt: now + 7 * 24 * 60 * 60 * 1000,
    actor: null, firstFactorVerifiedAt: now, secondFactorVerifiedAt: null, ip: null, userAgent: "vitest", city: null, country: null,
    createdAt: now, updatedAt: now,
  }).run();
  return { clientId, sessionId, token, cookie: `${COOKIES.client}=${token}` };
}

export function insertClient(ctx: AppContext) {
  const now = Date.now();
  const token = randomToken(32);
  const id = newId(ID_PREFIX.client);
  ctx.db.insert(s.clients).values({ id, tokenHash: sha256(token), lastActiveSessionId: null, ip: null, userAgent: "vitest", createdAt: now, updatedAt: now }).run();
  return { clientId: id, token };
}

export function insertOrganization(ctx: AppContext, name = "Acme") {
  const now = Date.now();
  const id = newId(ID_PREFIX.org);
  ctx.db.insert(s.organizations).values({
    id, name, slug: `${name.toLowerCase()}-${Math.random().toString(36).slice(2, 8)}`, imageUrl: null, hasImage: false,
    maxAllowedMemberships: 5, adminDeleteEnabled: true, publicMetadata: {}, privateMetadata: {}, createdBy: null,
    createdAt: now, updatedAt: now,
  }).run();
  return { orgId: id };
}

export function addMembership(ctx: AppContext, orgId: string, userId: string, roleKey: string) {
  const now = Date.now();
  const id = newId(ID_PREFIX.membership);
  ctx.db.insert(s.organizationMemberships).values({
    id, organizationId: orgId, userId, roleKey, publicMetadata: {}, privateMetadata: {}, createdAt: now, updatedAt: now,
  }).run();
  return id;
}

/** Grants `permissionKeys` to `roleKey` (creates the role and permissions when missing). */
export function grantPermissions(ctx: AppContext, roleKey: string, permissionKeys: string[]) {
  const now = Date.now();
  const role = ctx.db.select().from(s.roles).where(eq(s.roles.key, roleKey)).get()
    ?? (() => {
      const row = { id: newId(ID_PREFIX.role), key: roleKey, name: roleKey, description: "", isCreatorEligible: false, isSystem: false, createdAt: now, updatedAt: now };
      ctx.db.insert(s.roles).values(row).run();
      return row;
    })();
  for (const key of permissionKeys) {
    const permission = ctx.db.select().from(s.permissions).where(eq(s.permissions.key, key)).get()
      ?? (() => {
        const row = { id: newId(ID_PREFIX.permission), key, name: key, description: "", type: "user", createdAt: now, updatedAt: now };
        ctx.db.insert(s.permissions).values(row).run();
        return row;
      })();
    ctx.db.insert(s.rolePermissions).values({ roleId: role.id, permissionId: permission.id }).onConflictDoNothing().run();
  }
  return role;
}
