// Single-use / counted operations must decide their outcome in one statement: these tests fire the same
// request many times in parallel and assert that the gate holds.
import { describe, expect, it, vi } from "vitest";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, ID_PREFIX, OrbitError } from "@orbitid/shared";

// vi.mock factories are hoisted above static imports, so the recorder module is loaded dynamically.
vi.mock("../src/services/webhooks", async () => {
  const { events } = await import("./orgs/mocks");
  return {
    emitEvent: async (_ctx: unknown, type: string, data: unknown) => { events.push({ type, data }); },
    startWebhookWorker: () => () => {},
  };
});

import * as s from "../src/db/schema";
import { first } from "../src/lib/db";
import { hit } from "../src/lib/rate-limit";
import { newId } from "../src/lib/ids";
import { randomToken, sha256 } from "../src/lib/crypto";
import { setup } from "./core/helpers";
import { insertUser } from "./machine/helpers";
import { consumeBackupCode, generateBackupCodes } from "../src/services/mfa";
import { checkCode, issueVerification } from "../src/modules/auth/verifications";
import { redeemTicket } from "../src/services/restrictions";
import { takeOAuthState } from "../src/modules/auth/oauth-flow";
import { samlCache } from "../src/services/saml";
import {
  createApplication, exchangeAuthorizationCode, exchangeRefreshToken, findGrantByToken,
  issueAuthorizationCode, issueTokenSet, OAuthError,
} from "../src/services/oidc";
import { recordFailedAttempt } from "../src/services/users";
import {
  api, createOrg, eventsOf, invite, seedAuth, seedUser, setup as setupOrgs,
} from "./orgs/helpers";

const PARALLEL = 12;

const settle = <T>(runs: Promise<T>[]) => Promise.allSettled(runs);
const fulfilled = <T>(results: PromiseSettledResult<T>[]) => results.filter((r): r is PromiseFulfilledResult<T> => r.status === "fulfilled");
const rejected = (results: PromiseSettledResult<unknown>[]) => results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
const orbitCodes = (results: PromiseSettledResult<unknown>[]) =>
  rejected(results).map((result) => (result.reason instanceof OrbitError ? result.reason.code : "not_an_orbit_error"));
const oauthErrors = (results: PromiseSettledResult<unknown>[]) =>
  rejected(results).map((result) => (result.reason instanceof OAuthError ? result.reason.error : "not_an_oauth_error"));

describe("atomic single-use and counted operations", () => {
  it("lets exactly `max` rate-limited requests through in one window", async () => {
    const { ctx } = await setup();
    const results = await settle(Array.from({ length: 15 }, () => hit(ctx, "concurrency:rate", 5, 60_000)));
    expect(fulfilled(results)).toHaveLength(5);
    const denials = rejected(results);
    expect(denials).toHaveLength(10);
    for (const result of denials) {
      expect(result.reason).toBeInstanceOf(OrbitError);
      if (result.reason instanceof OrbitError) expect(result.reason.status).toBe(429);
    }
    expect(orbitCodes(results)).toEqual(Array.from({ length: 10 }, () => ErrorCodes.rate_limit_exceeded));
    const row = first(await ctx.db.select().from(s.rateLimits).where(eq(s.rateLimits.key, "concurrency:rate")));
    expect(row?.count).toBe(15);
  });

  it("never counts more verification attempts than max_attempts", async () => {
    const { ctx } = await setup();
    const issued = await issueVerification(ctx, {
      purpose: "sign_in_first_factor", strategy: "email_code", identifier: "race@example.com",
      ownerId: "sia_concurrency", lifetimeSeconds: 600, maxAttempts: 5,
    });
    const wrong = issued.code === "000000" ? "111111" : "000000";
    // Every request read the same row before any attempt was counted, like parallel HTTP requests do.
    const snapshot = issued.row;
    const results = await settle(Array.from({ length: PARALLEL }, () => checkCode(ctx, snapshot, wrong)));
    expect(fulfilled(results)).toHaveLength(0);
    for (const code of orbitCodes(results)) {
      expect([ErrorCodes.form_code_incorrect, ErrorCodes.too_many_attempts]).toContain(code);
    }
    const row = first(await ctx.db.select().from(s.verifications).where(eq(s.verifications.id, snapshot.id)))!;
    expect(row.attempts).toBe(5);
    await expect(checkCode(ctx, row, issued.code)).rejects.toMatchObject({ code: ErrorCodes.too_many_attempts });
  });

  it("never redeems a removed sign-in ticket, however many callers try", async () => {
    const { ctx } = await setup();
    const user = await insertUser(ctx, { email: "ticket@example.com" });
    const now = Date.now();
    const ticket = `tkt_${randomToken(16)}`;
    await ctx.db.insert(s.signInTokens).values({
      id: newId(ID_PREFIX.signInToken), userId: user.userId, tokenHash: sha256(ticket), status: "pending",
      expiresAt: now + 60_000, createdAt: now, updatedAt: now,
    });
    const results = await settle(Array.from({ length: PARALLEL }, () => redeemTicket(ctx, ticket)));
    expect(fulfilled(results)).toHaveLength(0);
    expect(orbitCodes(results)).toEqual(Array.from({ length: PARALLEL }, () => ErrorCodes.ticket_invalid));
    // The row is untouched: no caller could consume (and therefore use) it.
    expect(first(await ctx.db.select().from(s.signInTokens))!.status).toBe("pending");
  });

  it("spends a backup code exactly once", async () => {
    const { ctx } = await setup();
    const now = Date.now();
    const codes = generateBackupCodes(3);
    await ctx.db.insert(s.users).values({ id: "user_backup", backupCodes: codes.hashed, createdAt: now, updatedAt: now });
    const snapshot = first(await ctx.db.select().from(s.users).where(eq(s.users.id, "user_backup")))!;
    const spent = await settle(Array.from({ length: PARALLEL }, () => consumeBackupCode(ctx, snapshot, codes.plain[0]!)));
    expect(fulfilled(spent).filter((r) => r.value)).toHaveLength(1);
    const row = first(await ctx.db.select().from(s.users).where(eq(s.users.id, "user_backup")))!;
    expect(row.backupCodes).toEqual(codes.hashed.slice(1));
    expect(await consumeBackupCode(ctx, row, codes.plain[0]!)).toBe(false);
  });

  it("consumes an OAuth state exactly once", async () => {
    const { ctx } = await setup();
    const now = Date.now();
    await ctx.db.insert(s.oauthStates).values({
      state: "state_concurrency", provider: "google", codeVerifier: "verifier", nonce: null,
      flow: { kind: "sign_in", clientId: "client_1", redirectUrl: "http://localhost:3000/app", browserHash: "hash" },
      expiresAt: now + 600_000,
    });
    const results = await settle(Array.from({ length: PARALLEL }, () => takeOAuthState(ctx, "state_concurrency", "google")));
    const winners = fulfilled(results);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.value).toMatchObject({ kind: "sign_in", provider: "google", codeVerifier: "verifier" });
    expect(orbitCodes(results)).toEqual(Array.from({ length: PARALLEL - 1 }, () => ErrorCodes.oauth_callback_error));
    expect(await ctx.db.select().from(s.oauthStates).where(eq(s.oauthStates.state, "state_concurrency"))).toHaveLength(0);
  });

  it("lets only one SAML cache request claim a request id", async () => {
    const { ctx } = await setup();
    const cache = samlCache(ctx);
    const { saveIfAbsentAsync, consumeAsync } = cache;
    if (!saveIfAbsentAsync || !consumeAsync) throw new Error("SAML cache provider is missing its atomic operations");
    const results = await settle(Array.from({ length: 8 }, () => saveIfAbsentAsync("_request_1", "value", Date.now() + 60_000)));
    expect(fulfilled(results).filter((r) => r.value)).toHaveLength(1);
    expect(await cache.getAsync("_request_1")).toBe("value");
    const consumed = await settle(Array.from({ length: 8 }, () => consumeAsync("_request_1")));
    expect(fulfilled(consumed).map((r) => r.value).filter((value) => value !== null)).toEqual(["value"]);
  });

  it("replaces a stale SAML cache row and ignores expired ones", async () => {
    const { ctx } = await setup();
    const cache = samlCache(ctx);
    const saveIfAbsentAsync = cache.saveIfAbsentAsync;
    if (!saveIfAbsentAsync) throw new Error("SAML cache provider cannot save atomically");
    expect(await saveIfAbsentAsync("_expired", "old", Date.now() - 1_000)).toBe(true);
    expect(await cache.getAsync("_expired")).toBeNull();
    expect(await saveIfAbsentAsync("_expired", "new", Date.now() + 60_000)).toBe(true);
    expect(await cache.getAsync("_expired")).toBe("new");
  });

  it("exchanges an authorization code exactly once", async () => {
    const { ctx } = await setup();
    const user = await insertUser(ctx);
    const { row: application } = await createApplication(ctx, { name: "Concurrency", redirectUris: ["http://localhost:3000/cb"], pkceRequired: false });
    const code = await issueAuthorizationCode(ctx, { application, userId: user.userId, scopes: ["profile"], redirectUri: "http://localhost:3000/cb" });
    const results = await settle(Array.from({ length: PARALLEL }, () => exchangeAuthorizationCode(ctx, { application, code })));
    const winners = fulfilled(results);
    expect(winners).toHaveLength(1);
    expect(winners[0]!.value.access_token).toMatch(/^oat_/);
    expect(oauthErrors(results)).toEqual(Array.from({ length: PARALLEL - 1 }, () => "invalid_grant"));
    const grants = await ctx.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.kind, "access"));
    expect(grants).toHaveLength(1);
  });

  it("treats a losing parallel refresh as reuse and kills the family", async () => {
    const { ctx } = await setup();
    const user = await insertUser(ctx);
    const userRow = first(await ctx.db.select().from(s.users).where(eq(s.users.id, user.userId)))!;
    const { row: application } = await createApplication(ctx, { name: "Concurrency refresh", redirectUris: ["http://localhost:3000/cb"] });
    const issued = await issueTokenSet(ctx, { application, user: userRow, scopes: ["offline_access"], family: "family_concurrency" });
    const results = await settle(Array.from({ length: PARALLEL }, () => exchangeRefreshToken(ctx, application, issued.refresh_token!)));
    expect(fulfilled(results)).toHaveLength(1);
    expect(oauthErrors(results)).toEqual(Array.from({ length: PARALLEL - 1 }, () => "invalid_grant"));
    const presented = await findGrantByToken(ctx, issued.refresh_token!);
    expect(presented?.revoked).toBe(true);
  });

  it("locks an account after parallel failed passwords", async () => {
    const { ctx } = await setup();
    await ctx.settings.update({ mfa: { maxAttempts: 3 } });
    const user = await insertUser(ctx);
    await Promise.all(Array.from({ length: 10 }, () => recordFailedAttempt(ctx, user.userId)));
    const row = first(await ctx.db.select().from(s.users).where(eq(s.users.id, user.userId)))!;
    expect(row.locked).toBe(true);
    expect(row.lockoutExpiresAt).toBeGreaterThan(Date.now() - 1_000);
  });

  it("accepts an organization invitation once under parallel requests", async () => {
    const { ctx, app } = await setupOrgs();
    const owner = await seedUser(ctx, { email: "owner@concurrency.test" });
    const ownerAuth = await seedAuth(ctx, owner.id);
    const org = await createOrg(app, ownerAuth.cookie, "Concurrency Co");
    const invitee = await seedUser(ctx, { email: "invitee@concurrency.test" });
    const invitation = await invite(app, ownerAuth.cookie, org.id, invitee.email);
    const inviteeAuth = await seedAuth(ctx, invitee.id);
    const results = await Promise.all(Array.from({ length: PARALLEL }, () => api(app, "POST", `/v1/client/me/organization_invitations/${invitation.id}/accept`, { cookie: inviteeAuth.cookie })));
    expect(results.filter((r) => r.status >= 500)).toHaveLength(0);
    // One request wins; the rest either see the finished membership (200) or a no longer pending invitation (409).
    expect(results.filter((r) => r.status === 200).length).toBeGreaterThanOrEqual(1);
    expect(results.every((r) => r.status === 200 || r.status === 409)).toBe(true);
    // Exactly one acceptance: one `organizationInvitation.accepted`, one membership, and (besides the
    // creator) exactly one `organizationMembership.created`, even though every request tried.
    expect(eventsOf("organizationInvitation.accepted")).toHaveLength(1);
    expect(eventsOf("organizationMembership.created")).toHaveLength(2);
    const memberships = await ctx.db.select().from(s.organizationMemberships)
      .where(and(eq(s.organizationMemberships.organizationId, org.id), eq(s.organizationMemberships.userId, invitee.id)));
    expect(memberships).toHaveLength(1);
  });
});
