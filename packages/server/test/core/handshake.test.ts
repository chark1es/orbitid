import { describe, expect, it, vi } from "vitest";
import { createLocalJWKSet, jwtVerify, type JWK } from "jose";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { HANDSHAKE_SIGNED_OUT, HANDSHAKE_TRANSIENT } from "../../src/modules/handshake";
import * as sessions from "../../src/services/sessions";
import { getClient, setup, signUpUser, testClient, type TestClient } from "./helpers";

const APP = "https://app.example.com";

/** Instance whose app origin is `APP` (the API itself stays http://localhost:4000). */
async function setupApp() {
  const harness = await setup();
  await harness.ctx.settings.update({
    application: { homeUrl: APP, allowedOrigins: [APP], allowedRedirectOrigins: [], developmentMode: false },
  });
  return harness;
}

function handshake(client: TestClient, redirectUrl: string | null) {
  const query = redirectUrl === null ? "" : `?redirect_url=${encodeURIComponent(redirectUrl)}`;
  return client.request(`/v1/client/handshake${query}`, { headers: { accept: "text/html" } });
}

/** The `__orbit_handshake` value the API put on the `Location` header. */
function handshakeValue(response: Response): string | null {
  const location = response.headers.get("location");
  if (!location) return null;
  return new URL(location).searchParams.get("__orbit_handshake");
}

async function jwks(app: Awaited<ReturnType<typeof setup>>["app"]) {
  return (await (await app.request("/.well-known/jwks.json")).json()) as { keys: JWK[] };
}

describe("GET /v1/client/handshake", () => {
  it("mints a fresh session token for the client's active session and redirects back", async () => {
    const { app, ctx } = await setupApp();
    const user = await signUpUser(app);
    const response = await handshake(user.client, `${APP}/dashboard?tab=1`);

    expect(response.status).toBe(302);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");

    const location = new URL(response.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(`${APP}/dashboard`);
    expect(location.searchParams.get("tab")).toBe("1");
    const token = location.searchParams.get("__orbit_handshake");
    expect(token).toBeTruthy();
    expect(token).not.toBe("signed_out");

    // It is a real session token for that session and app, and it verifies against the public JWKS.
    const { payload } = await jwtVerify(token!, createLocalJWKSet(await jwks(app)), { issuer: ctx.env.baseUrl });
    expect(payload.sub).toBe(user.userId);
    expect(payload.sid).toBe(user.sessionId);
    expect(payload.sts).toBe("active");
    expect(payload.azp).toBe(APP);
    expect(payload.exp! - payload.iat!).toBe(60);
  });

  it("honours custom session claims like the token endpoint", async () => {
    const { app, ctx } = await setupApp();
    await ctx.settings.update({ session: { customClaims: { plan: "pro", email: "{{user.primary_email_address}}" } } });
    const user = await signUpUser(app);
    const token = handshakeValue(await handshake(user.client, `${APP}/dashboard`))!;

    const { payload } = await jwtVerify(token, createLocalJWKSet(await jwks(app)), { issuer: ctx.env.baseUrl });
    expect(payload.plan).toBe("pro");
    expect(payload.email).toBe(user.email);
  });

  it("redirects with signed_out when there is no client cookie", async () => {
    const { app } = await setupApp();
    const response = await handshake(testClient(app), `${APP}/dashboard`);
    expect(response.status).toBe(302);
    expect(handshakeValue(response)).toBe("signed_out");
    expect(new URL(response.headers.get("location")!).origin).toBe(APP);
  });

  it("redirects with signed_out when the client has no session", async () => {
    const { app } = await setupApp();
    const client = testClient(app);
    await getClient(client); // creates the client + cookie, signs nobody in
    const response = await handshake(client, `${APP}/dashboard`);
    expect(handshakeValue(response)).toBe("signed_out");
  });

  it("redirects with signed_out for an expired session", async () => {
    const { app, ctx } = await setupApp();
    // A finite lifetime is opt-in now (0 means no maximum), so an expiry test has to ask for one.
    await ctx.settings.update({ session: { lifetimeSeconds: 3_600 } });
    const user = await signUpUser(app);
    const past = Date.now() - 60_000;
    await ctx.db.update(schema.sessions).set({ expireAt: past }).where(eq(schema.sessions.id, user.sessionId));

    const response = await handshake(user.client, `${APP}/dashboard`);
    expect(handshakeValue(response)).toBe("signed_out");
    expect((await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, user.sessionId)))[0]?.status).toBe("expired");
  });

  it("redirects with signed_out for an idle session", async () => {
    const { app, ctx } = await setupApp();
    await ctx.settings.update({ session: { inactivityTimeoutSeconds: 60 } });
    const user = await signUpUser(app);
    await ctx.db.update(schema.sessions)
      .set({ lastActiveAt: Date.now() - 120_000 })
      .where(eq(schema.sessions.id, user.sessionId));

    expect(handshakeValue(await handshake(user.client, `${APP}/dashboard`))).toBe("signed_out");
  });

  it("mints a pending session token for a pending (MFA enrolment) session instead of signing it out", async () => {
    const { app, ctx } = await setupApp();
    await ctx.settings.update({ mfa: { required: true }, attributes: { authenticatorApp: { enabled: true } } });
    const user = await signUpUser(app);
    const stored = (await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, user.sessionId)))[0];
    expect(stored?.status).toBe("pending");

    const token = handshakeValue(await handshake(user.client, `${APP}/dashboard`));
    expect(token).toBeTruthy();
    expect(token).not.toBe(HANDSHAKE_SIGNED_OUT);
    expect(token).not.toBe(HANDSHAKE_TRANSIENT);
    const { payload } = await jwtVerify(token!, createLocalJWKSet(await jwks(app)), { issuer: ctx.env.baseUrl });
    expect(payload.sid).toBe(user.sessionId);
    expect(payload.sts).toBe("pending");
    // Still pending: a handshake is not an MFA bypass.
    expect((await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, user.sessionId)))[0]?.status).toBe("pending");
  });

  it.each([
    ["protocol-relative", "//evil.example/x"],
    ["javascript", "javascript:alert(document.cookie)"],
    ["data", "data:text/html,<script>alert(1)</script>"],
    ["userinfo", "https://app.example.com@evil.example/x"],
    ["userinfo on an allowed origin", "https://user:pass@app.example.com/x"],
    ["other origin", "https://evil.example/x"],
    ["backslash escape", "/\\evil.example/x"],
  ])("rejects %s redirect_url variants", async (_name, value) => {
    const { app } = await setupApp();
    const user = await signUpUser(app);
    const response = await handshake(user.client, value);
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
  });

  it("requires redirect_url", async () => {
    const { app } = await setupApp();
    const user = await signUpUser(app);
    for (const value of [null, ""]) {
      const response = await handshake(user.client, value);
      expect(response.status).toBe(400);
    }
  });

  it("accepts a relative path, another application origin and the API's own origin, but not a redirect-only origin", async () => {
    const { app, ctx } = await setupApp();
    await ctx.settings.update({ application: { allowedOrigins: [APP, "https://admin.example.com"], allowedRedirectOrigins: ["https://partner.example.com"] } });
    const user = await signUpUser(app);

    const relative = new URL((await handshake(user.client, "/after-login")).headers.get("location")!);
    expect(relative.toString().startsWith(`${APP}/after-login`)).toBe(true);

    const allowed = new URL((await handshake(user.client, "https://admin.example.com/x")).headers.get("location")!);
    expect(allowed.origin).toBe("https://admin.example.com");

    const apiOrigin = new URL((await handshake(user.client, `${ctx.env.baseUrl}/dashboard`)).headers.get("location")!);
    expect(apiOrigin.origin).toBe(ctx.env.baseUrl);

    // A place users may be redirected to after sign-in is not trusted with a session token.
    expect((await handshake(user.client, "https://partner.example.com/x")).status).toBe(400);
  });

  it("rate-limits the endpoint", async () => {
    const { app } = await setupApp();
    const client = testClient(app);
    let limited: Response | null = null;
    // 600 handshakes per address per minute: a restored browser can replay one per tab, and an office may
    // share an address, so the budget is deliberately far above a human navigation rate.
    for (let i = 0; i < 620; i++) {
      const response = await handshake(client, `${APP}/dashboard`);
      if (response.status === 429) { limited = response; break; }
    }
    expect(limited?.status).toBe(429);
  });

  it("answers an infrastructure failure with a retriable marker, never signed_out", async () => {
    const { app, ctx } = await setupApp();
    const user = await signUpUser(app);
    // Make a newer active signing key unreadable: the same failure class as a changed ORBITID_ENCRYPTION_KEY or a
    // database error while minting. Minting throws, but the session itself is perfectly alive.
    await ctx.db.insert(schema.signingKeys).values({
      kid: "broken-key", alg: "RS256", publicJwk: { kty: "RSA", kid: "broken-key", alg: "RS256", use: "sig" },
      privateJwkEnc: "v1.bad.bad.bad", active: true, createdAt: Date.now() + 1_000,
    });

    const response = await handshake(user.client, `${APP}/dashboard`);
    expect(response.status).toBe(302);
    expect(handshakeValue(response)).toBe(HANDSHAKE_TRANSIENT);
    expect(handshakeValue(response)).not.toBe(HANDSHAKE_SIGNED_OUT);
    expect(response.headers.get("retry-after")).toBe("5");
    // The browser's credentials must survive: a broken key is not a sign-out.
    const stored = (await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, user.sessionId)))[0]!;
    expect(stored.status).toBe("active");
  });

  it("does not fail the handshake when the activity write fails", async () => {
    const { app } = await setupApp();
    const user = await signUpUser(app);
    const spy = vi.spyOn(sessions, "slideSessionActivity").mockRejectedValueOnce(new Error("database is busy"));
    try {
      const response = await handshake(user.client, `${APP}/dashboard`);
      const token = handshakeValue(response);
      expect(response.status).toBe(302);
      expect(token).toBeTruthy();
      expect(token).not.toBe(HANDSHAKE_SIGNED_OUT);
      expect(token).not.toBe(HANDSHAKE_TRANSIENT);
    } finally {
      spy.mockRestore();
    }
  });
});
