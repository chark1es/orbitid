import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { SESSION_NEVER_EXPIRES_AT } from "@orbitid/shared";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import { dialect } from "../../src/db";
import * as s from "../../src/db/schema";
import { getActiveSigningKey } from "../../src/services/tokens";
import { errorsOf, getClient, setup, signUpUser, testClient } from "./helpers";

/**
 * End-user guarantee: a session stays signed in until the user signs out, an operator revokes it, the user is
 * banned, or the operator explicitly turns on a finite lifetime / inactivity timeout. Nothing else may end it.
 */

const DAY = 86_400_000;

/** A database that survives a context restart, on whichever dialect the suite is running. */
function persistentTarget() {
  const dir = mkdtempSync(join(tmpdir(), "orbitid-persist-"));
  const databaseUrl = dialect === "postgres" ? `pglite:${join(dir, "pg")}` : `sqlite:${join(dir, "orbitid.db")}`;
  return { dir, databaseUrl, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function persistentContext(target: { dir: string; databaseUrl: string }, encryptionKey = "persist-key-".padEnd(32, "x")) {
  return createContext({
    databaseUrl: target.databaseUrl,
    dataDir: target.dir,
    secretKey: "sk_test_persist_session",
    baseUrl: "http://localhost:4000",
    nodeEnv: "test",
    encryptionKey,
  });
}

/** Backend API helper for the routes under test (instance secret key). */
async function backend(ctx: Awaited<ReturnType<typeof setup>>["ctx"], app: ReturnType<typeof createApp>, method: string, path: string, body?: unknown) {
  return app.request(path, {
    method,
    headers: { authorization: `Bearer ${ctx.env.secretKey}`, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("session persistence defaults", () => {
  afterEach(() => vi.useRealTimers());

  it("creates sessions with no maximum lifetime and keeps them alive for a year", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const created = (await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, user.sessionId)))[0]!;

    // Defaults: no absolute lifetime, no inactivity timeout, multi-session allowed.
    expect(ctx.settings.get().session).toMatchObject({ lifetimeSeconds: 0, inactivityTimeoutSeconds: 0, multiSession: true });
    expect(created.expireAt).toBe(SESSION_NEVER_EXPIRES_AT);

    for (const days of [30, 90, 180, 365]) {
      vi.setSystemTime(start + days * DAY);
      const state = await getClient(user.client);
      expect(state.response.sessions.find((session) => session.id === user.sessionId)?.status, `day ${days}`).toBe("active");
      const minted = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
      expect(minted.jwt.split(".")).toHaveLength(3);
    }
  });

  it("enforces a raw legacy 7-day deadline as an explicit per-session cap when no upgrade ran", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    // A row written by an older release has a concrete seven-day `expire_at`. The settings upgrade converts that
    // legacy deadline to the sentinel (covered in settings-migration.test.ts); if that upgrade did not run, the
    // stored value is an explicit cap and is enforced rather than silently ignored.
    await ctx.db.update(s.sessions).set({ expireAt: start + 7 * DAY }).where(eq(s.sessions.id, user.sessionId));

    vi.setSystemTime(start + 8 * DAY);
    const state = await getClient(user.client);
    expect(state.response.sessions.find((session) => session.id === user.sessionId)).toBeUndefined();
    const minted = await user.client.request(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    expect(minted.status).toBe(401);
  });

  it("counts a token refresh as user activity so retention cannot delete an active guest", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    // Simulate a user who signed in long ago and has only refreshed tokens since (no explicit touch).
    await ctx.db.update(s.users).set({ lastActiveAt: start - 10 * DAY }).where(eq(s.users.id, user.userId));

    vi.setSystemTime(start + 60_000);
    const minted = await user.client.request(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    expect(minted.status).toBe(200);
    const stored = (await ctx.db.select().from(s.users).where(eq(s.users.id, user.userId)))[0]!;
    expect(stored.lastActiveAt).toBe(start + 60_000);
  });

  it("honours an opt-in maximum lifetime", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const { app, ctx } = await setup();
    await ctx.settings.update({ session: { lifetimeSeconds: 3_600 } });
    const user = await signUpUser(app);

    vi.setSystemTime(start + 3_601_000);
    const state = await getClient(user.client);
    expect(state.response.sessions).toHaveLength(0);
    const refused = await user.client.request(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    expect(refused.status).toBe(401);
  });

  it("slides an opt-in inactivity timeout on token refresh, then expires only when idle", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.UTC(2026, 0, 1);
    vi.setSystemTime(start);
    const { app, ctx } = await setup();
    await ctx.settings.update({ session: { inactivityTimeoutSeconds: 3_600 } });
    const user = await signUpUser(app);

    // Activity every 45 minutes for three hours keeps the session alive (the token refresh is activity).
    for (const minutes of [45, 90, 135, 180]) {
      vi.setSystemTime(start + minutes * 60_000);
      const minted = await user.client.request(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
      expect(minted.status, `minute ${minutes}`).toBe(200);
    }
    const lastActivity = start + 180 * 60_000;

    // Two hours with no activity: the configured idle timeout ends it.
    vi.setSystemTime(lastActivity + 2 * 3_600_000);
    const idle = await user.client.request(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    expect(idle.status).toBe(401);
  });
});

describe("session persistence across a restart", () => {
  it("keeps the client, session and signing key across a new context on the same database", async () => {
    const target = persistentTarget();
    try {
      const first = await persistentContext(target);
      const app = createApp(first);
      const user = await signUpUser(app);
      const cookie = user.client.cookie!;
      const kid = (await first.db.select().from(s.signingKeys).where(eq(s.signingKeys.active, true)))[0]!.kid;
      const oldToken = (await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} })).jwt;
      await first.close();

      const second = await persistentContext(target);
      const app2 = createApp(second);
      const restored = testClient(app2, cookie);
      const state = await restored.json<{ response: { sessions: { id: string; status: string }[] } }>("/v1/client");
      expect(state.response.sessions.find((session) => session.id === user.sessionId)?.status).toBe("active");

      // The JWKS still answers with the same key, the pre-restart token still verifies, and a new refresh works.
      const jwks = (await (await app2.request("/.well-known/jwks.json")).json()) as { keys: JWK[] };
      expect(jwks.keys.some((key) => key.kid === kid)).toBe(true);
      await expect(jwtVerify(oldToken, createLocalJWKSet(jwks), { issuer: second.env.baseUrl })).resolves.toBeTruthy();
      const refreshed = await restored.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
      await expect(jwtVerify(refreshed.jwt, createLocalJWKSet(jwks), { issuer: second.env.baseUrl })).resolves.toBeTruthy();
      await second.close();
    } finally {
      target.cleanup();
    }
  });

  it("fails loudly when ORBITID_ENCRYPTION_KEY no longer decrypts the stored signing key", async () => {
    const target = persistentTarget();
    try {
      const first = await persistentContext(target);
      await getActiveSigningKey(first); // persist an encrypted key
      await first.close();

      await expect(persistentContext(target, "a-different-key-".padEnd(32, "y"))).rejects.toThrow(/ORBITID_ENCRYPTION_KEY/);
    } finally {
      target.cleanup();
    }
  });
});

describe("nothing else ends a session", () => {
  it("keeps sessions when an operator changes instance roles", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const role = await backend(ctx, app, "POST", "/v1/roles", { key: "app:persist", name: "Persist" });
    expect(role.status).toBe(200);
    const assigned = await backend(ctx, app, "PUT", `/v1/users/${user.userId}/roles`, { roles: ["app:persist"] });
    expect(assigned.status).toBe(200);

    const stored = (await ctx.db.select().from(s.sessions).where(eq(s.sessions.id, user.sessionId)))[0]!;
    expect(stored.status).toBe("active");
    const minted = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    const jwks = (await (await app.request("/.well-known/jwks.json")).json()) as { keys: JWK[] };
    const { payload } = await jwtVerify(minted.jwt, createLocalJWKSet(jwks), { issuer: ctx.env.baseUrl });
    expect(payload.roles).toEqual(["app:persist"]);
  });

  it("does not sign out other devices on a password change unless asked", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const second = await user.client.json<{ response: { created_session_id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    const activeCount = async () => (await ctx.db.select().from(s.sessions).where(eq(s.sessions.userId, user.userId))).filter((row) => row.status === "active").length;
    expect(await activeCount()).toBe(2);

    const changed = await user.client.json("/v1/client/me/change_password", {
      method: "POST",
      body: { current_password: user.password, new_password: "N3wPersist!23" },
    });
    expect(errorsOf(changed)).toEqual([]);
    expect(await activeCount()).toBe(2);

    // Opt-in still works, and never ends the session that asked.
    await user.client.json("/v1/client/me/change_password", {
      method: "POST",
      body: { current_password: "N3wPersist!23", new_password: "N3wPersist!45", sign_out_of_other_sessions: true },
    });
    const rows = await ctx.db.select().from(s.sessions).where(eq(s.sessions.userId, user.userId));
    const current = rows.find((row) => row.id === second.response.created_session_id)!;
    const previous = rows.find((row) => row.id === user.sessionId)!;
    expect(current.status).toBe("active");
    expect(previous.status).toBe("revoked");
  });

  it("allows a second account by default and enforces single-session mode only when opted in", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const second = await user.client.json<{ response: { created_session_id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, password: user.password },
    });
    expect(second.response.created_session_id).toBeTruthy();
    const state = await getClient(user.client);
    expect(state.response.sessions.filter((session) => session.status === "active")).toHaveLength(2);

    await ctx.settings.update({ session: { multiSession: false } });
    const refused = await user.client.json("/v1/client/sign_ins", { body: { identifier: user.email, password: user.password } });
    expect(errorsOf(refused)[0]?.code).toBe("identifier_already_signed_in");
  });

  it("clears the client's active-session pointer when an operator revokes its session", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const revoked = await backend(ctx, app, "POST", `/v1/sessions/${user.sessionId}/revoke`);
    expect(revoked.status).toBe(200);
    const client = (await ctx.db.select().from(s.clients))[0]!;
    expect(client.lastActiveSessionId).toBeNull();
    const state = await getClient(user.client);
    expect(state.response.sessions.find((session) => session.id === user.sessionId)?.status).toBe("revoked");
  });
});

describe("browser client cookie", () => {
  const previous = process.env.ORBITID_TRUST_PROXY;
  afterEach(() => {
    if (previous === undefined) delete process.env.ORBITID_TRUST_PROXY;
    else process.env.ORBITID_TRUST_PROXY = previous;
  });

  it("refuses a rotated client token without overwriting the live cookie", async () => {
    const { app } = await setup();
    await signUpUser(app); // rotates the cookie to a new client token
    const staleTab = testClient(app, "__client=token-from-before-the-sign-in");
    const staleWrite = await staleTab.request("/v1/client/sessions/sess_1/tokens", { method: "POST", body: {} });
    expect(staleWrite.status).toBe(401);
    expect(staleWrite.headers.getSetCookie().some((line) => line.startsWith("__client="))).toBe(false);

    // Only the SDK's bootstrap is allowed to create a replacement client for an unknown token.
    const bootstrap = await staleTab.request("/v1/client");
    expect(bootstrap.status).toBe(200);
    expect(bootstrap.headers.getSetCookie().some((line) => line.startsWith("__client="))).toBe(true);
  });

  it("is a long-lived httpOnly Lax cookie, not a session cookie", async () => {
    const { app } = await setup();
    const response = await testClient(app).request("/v1/client");
    const cookie = response.headers.getSetCookie().find((line) => line.startsWith("__client="))!;
    expect(cookie).toContain("Max-Age=34560000");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    // A plain-http localhost instance cannot use a Secure cookie.
    expect(cookie).not.toContain("Secure");
  });

  it("adds Secure behind a trusted TLS-terminating proxy", async () => {
    process.env.ORBITID_TRUST_PROXY = "1";
    const { app } = await setup();
    const response = await app.request("/v1/client", { headers: { "x-forwarded-proto": "https", "x-forwarded-for": "203.0.113.9" } });
    const cookie = response.headers.getSetCookie().find((line) => line.startsWith("__client="))!;
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("Max-Age=34560000");
  });
});
