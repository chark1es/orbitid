import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import type { InstanceSettings, OrganizationJSON, OrganizationMembershipJSON, OrganizationInvitationJSON } from "@orbitid/shared";
import { ID_PREFIX } from "@orbitid/shared";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import type { AppContext } from "../../src/context";
import type { DeepPartial } from "../../src/context";
import * as s from "../../src/db/schema";
import { randomToken, sha256 } from "../../src/lib/crypto";
import { newId } from "../../src/lib/ids";
import { events, mailOutbox } from "./mocks";

export const SECRET_KEY = "sk_test_testsecret";
export const BASE_URL = "http://localhost:4000";

export { mailOutbox, events } from "./mocks";

export function resetRecorders(): void {
  mailOutbox.length = 0;
  events.length = 0;
}

export function eventsOf(type: string): unknown[] {
  return events.filter((e) => e.type === type).map((e) => e.data);
}

export function lastMail(template?: string) {
  const list = template ? mailOutbox.filter((m) => m.template === template) : mailOutbox;
  return list[list.length - 1];
}

export interface TestHarness {
  ctx: AppContext;
  app: Hono;
}

export async function setup(opts: {
  organizations?: DeepPartial<InstanceSettings["organizations"]>;
  settings?: DeepPartial<InstanceSettings>;
} = {}): Promise<TestHarness> {
  resetRecorders();
  const ctx = await createContext({
    databasePath: ":memory:",
    secretKey: SECRET_KEY,
    baseUrl: BASE_URL,
    dataDir: mkdtempSync(join(tmpdir(), "orbitid-orgs-")),
  });
  await ctx.settings.update({
    organizations: { enabled: true, creationEnabled: true, domainsEnabled: true, membershipRequestsEnabled: true, ...opts.organizations },
    ...opts.settings,
  });
  return { ctx, app: createApp(ctx) };
}

export interface SeedUserOptions {
  email?: string;
  verified?: boolean;
  firstName?: string;
  lastName?: string;
  username?: string;
  createOrganizationEnabled?: boolean;
  createOrganizationsLimit?: number | null;
}

export function seedUser(ctx: AppContext, opts: SeedUserOptions = {}) {
  const now = Date.now();
  const id = newId(ID_PREFIX.user);
  const email = (opts.email ?? "user@example.com").toLowerCase();
  ctx.db.insert(s.users).values({
    id, firstName: opts.firstName ?? "Ada", lastName: opts.lastName ?? "Lovelace", username: opts.username ?? null,
    createOrganizationEnabled: opts.createOrganizationEnabled ?? true,
    createOrganizationsLimit: opts.createOrganizationsLimit ?? null,
    createdAt: now, updatedAt: now,
  }).run();
  const emailId = newId(ID_PREFIX.email);
  ctx.db.insert(s.emailAddresses).values({
    id: emailId, userId: id, email, verified: opts.verified ?? true,
    verifiedAt: opts.verified === false ? null : now, verifiedStrategy: opts.verified === false ? null : "email_code",
    createdAt: now, updatedAt: now,
  }).run();
  ctx.db.update(s.users).set({ primaryEmailAddressId: emailId }).where(eq(s.users.id, id)).run();
  return { id, email, emailId };
}

export function seedAuth(ctx: AppContext, userId: string, opts: { activeOrganizationId?: string } = {}) {
  const now = Date.now();
  const token = randomToken(24);
  const clientId = newId(ID_PREFIX.client);
  const sessionId = newId(ID_PREFIX.session);
  ctx.db.insert(s.clients).values({ id: clientId, tokenHash: sha256(token), lastActiveSessionId: sessionId, createdAt: now, updatedAt: now }).run();
  ctx.db.insert(s.sessions).values({
    id: sessionId, clientId, userId, status: "active",
    expireAt: now + 24 * 60 * 60 * 1000, abandonAt: now + 24 * 60 * 60 * 1000, lastActiveAt: now,
    lastActiveOrganizationId: opts.activeOrganizationId ?? null, createdAt: now, updatedAt: now,
  }).run();
  return { token, clientId, sessionId, cookie: `__client=${token}` };
}

export interface ApiOptions {
  cookie?: string;
  body?: unknown;
  backend?: boolean;
  headers?: Record<string, string>;
}

export async function api<T = unknown>(app: Hono, method: string, path: string, opts: ApiOptions = {}) {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (opts.cookie) headers.cookie = opts.cookie;
  if (opts.backend) headers.authorization = `Bearer ${SECRET_KEY}`;
  if (opts.body !== undefined) headers["content-type"] = "application/json";
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  // Test helper: responses are trusted instance JSON, no schema needed here.
  let body: T | null = null;
  try { body = text ? (JSON.parse(text) as T) : null; } catch { body = text as unknown as T; }
  return { status: res.status, body: body as T, headers: res.headers, res };
}

export function backend<T = unknown>(app: Hono, method: string, path: string, body?: unknown) {
  return api<T>(app, method, path, { backend: true, body });
}

export function errorCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || !("errors" in body)) return undefined;
  const errors = body.errors;
  if (!Array.isArray(errors) || !errors.length) return undefined;
  const first = errors[0];
  return first && typeof first === "object" && "code" in first && typeof first.code === "string" ? first.code : undefined;
}

/** Creates an organization through the Frontend API and returns its JSON. */
export async function createOrg(app: Hono, cookie: string, name = "Acme", slug?: string) {
  const res = await api<{ response: OrganizationJSON }>(app, "POST", "/v1/client/organizations", { cookie, body: { name, ...(slug ? { slug } : {}) } });
  if (res.status !== 200) throw new Error(`createOrg failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.response;
}

/** Invites `email` from the Frontend API and returns the invitation JSON. */
export async function invite(app: Hono, cookie: string, orgId: string, email: string, role?: string) {
  const res = await api<{ response: OrganizationInvitationJSON }>(app, "POST", `/v1/client/organizations/${orgId}/invitations`, {
    cookie, body: { email_address: email, ...(role ? { role } : {}) },
  });
  if (res.status !== 200) throw new Error(`invite failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.response;
}

export async function memberships(app: Hono, cookie: string, orgId: string): Promise<OrganizationMembershipJSON[]> {
  const res = await api<{ response: OrganizationMembershipJSON[] }>(app, "GET", `/v1/client/organizations/${orgId}/memberships`, { cookie });
  if (res.status !== 200) throw new Error(`memberships failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.response;
}

export function membershipFor(list: OrganizationMembershipJSON[], userId: string) {
  return list.find((m) => m.public_user_data.user_id === userId);
}
