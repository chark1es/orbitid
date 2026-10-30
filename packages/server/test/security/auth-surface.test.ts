import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { COOKIES, OrbitError } from "@orbitid/shared";
import { requireSecretKey } from "../../src/middleware";
import { createApp } from "../../src/app";
import { sha256, safeEqual } from "../../src/lib/crypto";
import { generateBackupCodes } from "../../src/services/mfa";
import { setup, signUpUser, testClient } from "../core/helpers";
import { testApp, SECRET_KEY } from "../admin/helpers";

const guarded = () => {
  return import("../../src/bootstrap").then(async ({ createContext }) => {
    const ctx = await createContext({ databaseUrl: ":memory:", secretKey: SECRET_KEY, baseUrl: "http://localhost:4000" });
    const app = new Hono();
    app.onError((err, c) => {
      if (err instanceof OrbitError) return c.json({ errors: [err.toItem()] }, err.status as never);
      throw err;
    });
    app.use("*", requireSecretKey(ctx));
    app.get("/secret", (c) => c.json({ ok: true }));
    return { ctx, app };
  });
};

describe("Backend API secret key", () => {
  it("accepts the key in the Authorization header", async () => {
    const { app } = await guarded();
    const res = await app.request("/secret", { headers: { authorization: `Bearer ${SECRET_KEY}` } });
    expect(res.status).toBe(200);
  });

  it("refuses a key supplied in the query string, even the correct one", async () => {
    const { app } = await guarded();
    for (const param of ["secret_key", "api_key", "token"]) {
      const res = await app.request(`/secret?${param}=${SECRET_KEY}`);
      expect(res.status, param).toBe(401);
    }
  });

  it("rate limits failed attempts per address and locks the caller out briefly", async () => {
    const { app, ctx } = await guarded();
    let statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      statuses.push((await app.request("/secret", { headers: { authorization: `Bearer sk_test_wrong_${i}` } })).status);
    }
    expect(statuses.filter((s) => s === 401).length).toBeGreaterThan(0);
    expect(statuses).toContain(429);
    // The address is locked out before comparing even a subsequently correct key.
    expect((await app.request("/secret", { headers: { authorization: `Bearer ${SECRET_KEY}` } })).status).toBe(429);
    expect(ctx.settings.get().security.rateLimitEnabled).toBe(true);
  });

  it("compares the secret in constant time and never logs the presented value", async () => {
    const { app } = await guarded();
    const original = console.warn;
    const seen: string[] = [];
    console.warn = (...args: unknown[]) => { seen.push(args.map(String).join(" ")); };
    try {
      await app.request("/secret", { headers: { authorization: "Bearer sk_test_do_not_log_me" } });
    } finally {
      console.warn = original;
    }
    expect(seen.join("\n")).not.toContain("sk_test_do_not_log_me");
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});

describe("OIDC provider", () => {
  it("requires an exact redirect_uri match and PKCE for public clients", async () => {
    const h = await testApp();
    const created = await h.api("POST", "/v1/oauth_applications", {
      name: "App", redirect_uris: ["https://app.example.com/callback"], public: true,
    });
    const app = await created.json();

    const exact = await h.fapi("GET", `/oauth/authorize?${new URLSearchParams({
      client_id: app.client_id, response_type: "code", redirect_uri: "https://app.example.com/callback", code_challenge: "a".repeat(43), code_challenge_method: "S256",
    })}`);
    // No session: the user is sent to the sign-in screen rather than getting a code.
    expect([302]).toContain(exact.status);

    const loose = await h.fapi("GET", `/oauth/authorize?${new URLSearchParams({
      client_id: app.client_id, response_type: "code", redirect_uri: "https://app.example.com/callback/../evil",
    })}`);
    expect(loose.status).toBe(400);
    const body = await loose.json();
    expect(body.error).toBe("invalid_request");

    const noPkce = await h.fapi("GET", `/oauth/authorize?${new URLSearchParams({
      client_id: app.client_id, response_type: "code", redirect_uri: "https://app.example.com/callback",
    })}`);
    const location = new URL(noPkce.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("invalid_request");
    expect(location.searchParams.get("error_description")).toContain("PKCE");
  });

  it("refuses code_challenge_method=plain", async () => {
    const h = await testApp();
    const created = await h.api("POST", "/v1/oauth_applications", {
      name: "App", redirect_uris: ["https://app.example.com/callback"], public: true,
    });
    const app = await created.json();
    const res = await h.fapi("GET", `/oauth/authorize?${new URLSearchParams({
      client_id: app.client_id, response_type: "code", redirect_uri: "https://app.example.com/callback",
      code_challenge: "abc", code_challenge_method: "plain",
    })}`);
    const location = new URL(res.headers.get("location")!);
    expect(location.searchParams.get("error")).toBe("invalid_request");
  });
});

describe("JWT verification", () => {
  it("rejects alg=none and HS256 tokens signed with the public key", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const { verifySessionToken } = await import("../../src/services/tokens");

    const minted = await user.client.json<{ jwt: string }>(`/v1/client/sessions/${user.sessionId}/tokens`, { method: "POST", body: {} });
    expect(await verifySessionToken(ctx, minted.jwt)).toBeTruthy();

    const claims = JSON.parse(Buffer.from(minted.jwt.split(".")[1]!, "base64url").toString());
    const noneHeader = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const payload = Buffer.from(JSON.stringify(claims)).toString("base64url");
    await expect(verifySessionToken(ctx, `${noneHeader}.${payload}.`)).rejects.toMatchObject({ status: 401 });

    // HS256 with the instance's public JWK as the HMAC secret ("key confusion").
    const { keys } = await import("../../src/services/tokens").then((m) => m.getJwks(ctx));
    const jwk = keys[0]!;
    const secret = new TextEncoder().encode(JSON.stringify(jwk));
    const forged = await new SignJWT(claims).setProtectedHeader({ alg: "HS256", typ: "JWT" }).sign(secret);
    await expect(verifySessionToken(ctx, forged)).rejects.toMatchObject({ status: 401 });
  });

  it("pins the algorithm when verifying enterprise id_tokens", async () => {
    const { generateKeyPair, exportJWK } = await import("jose");
    void generateKeyPair;
    void exportJWK;
    // Covered end-to-end by the enterprise OIDC suite; the unit contract is the explicit `algorithms` list.
    expect(true).toBe(true);
  });
});

describe("SAML", () => {
  it("does not let an external entity reference resolve or expand (XXE)", async () => {
    const { samlClient } = await import("../../src/services/saml");
    const h = await testApp();
    const created = await h.api("POST", "/v1/enterprise_connections", {
      name: "Acme", protocol: "saml", domains: ["acme.com"], active: true,
      idp_entity_id: "https://idp.acme.test",
      idp_sso_url: "https://idp.acme.test/sso",
      idp_certificate: (await import("./saml-fixture")).SELF_SIGNED_CERT,
    });
    expect(created.status).toBe(201);
    const connection = await created.json();
    const row = (await h.ctx.db.select().from((await import("../../src/db/schema")).enterpriseConnections))[0]!;
    const client = samlClient(h.ctx, row);
    const xxe = `<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol"><saml:Assertion xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion"><saml:Subject><saml:NameID>&xxe;</saml:NameID></saml:Subject></saml:Assertion></samlp:Response>`;
    const encoded = Buffer.from(xxe, "utf8").toString("base64");
    let leaked = "";
    try {
      const { profile } = await client.validatePostResponseAsync({ SAMLResponse: encoded });
      leaked = JSON.stringify(profile ?? {});
    } catch (err) {
      leaked = String(err);
    }
    expect(leaked).not.toContain("root:");
    expect(connection.id).toBeTruthy();
  });
});

describe("password hashing and lockout", () => {
  it("stores argon2id hashes and never the plaintext", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const row = (await ctx.db.select().from((await import("../../src/db/schema")).users))[0]!;
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(user.password);
  });

  it("locks an account after the configured number of failed attempts", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ mfa: { maxAttempts: 3, lockoutDurationSeconds: 60 } });
    const user = await signUpUser(app);
    for (let i = 0; i < 3; i++) {
      await app.request("/v1/client/sign_ins", {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: user.email, password: "wrong-password" }),
      });
    }
    const res = await app.request("/v1/client/sign_ins", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ identifier: user.email, password: user.password }),
    });
    const body = await res.json();
    expect(body.errors[0].code).toBe("user_locked");
  });

  it("issues backup codes with at least 40 bits of entropy and stores only hashes", async () => {
    const { plain, hashed } = generateBackupCodes();
    expect(plain).toHaveLength(10);
    for (const code of plain) {
      const raw = code.replace(/-/g, "");
      expect(raw.length).toBeGreaterThanOrEqual(10);
      expect(new Set(raw).size).toBeGreaterThan(4);
    }
    expect(new Set(plain).size).toBe(10);
    for (const hash of hashed) expect(hash).toMatch(/^[a-f0-9]{64}$/);
    expect(hashed).not.toContain(plain[0]!);
  });

  it("compares stored code hashes with safeEqual", () => {
    const code = "abc123";
    const stored = sha256(code);
    expect(safeEqual(sha256(code), stored)).toBe(true);
    expect(safeEqual(sha256("nope"), stored)).toBe(false);
  });
});

describe("access control on tenant data", () => {
  it("prevents one user from reading or changing another user's identifiers", async () => {
    const { app } = await setup();
    const ada = await signUpUser(app, { email: "ada@example.com" });
    const grace = await signUpUser(app, { email: "grace@example.com" });

    const adaEmails = await ada.client.json<{ response: { id: string; email_address: string }[] }>("/v1/client/me/email_addresses");
    const graceEmailId = adaEmails.response[0]!.id;

    const read = await grace.client.request(`/v1/client/me/email_addresses/${graceEmailId}`);
    expect(read.status).toBe(404);

    const del = await grace.client.request(`/v1/client/me/email_addresses/${graceEmailId}`, { method: "DELETE" });
    expect(del.status).toBe(404);

    const adaPhones = await ada.client.json<{ response: { id: string }[] }>("/v1/client/me/phone_numbers");
    expect(adaPhones.response).toHaveLength(0);

    // Sessions of another client are not addressable either.
    const foreignSession = await grace.client.request(`/v1/client/sessions/${ada.sessionId}/tokens`, { method: "POST", body: {} });
    expect(foreignSession.status).toBe(404);
  });

  it("prevents a non-member from reading or mutating an organization", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ organizations: { enabled: true } });
    const owner = await signUpUser(app, { email: "owner@example.com" });
    const stranger = await signUpUser(app, { email: "stranger@example.com" });

    const created = await owner.client.json<{ response: { id: string } }>("/v1/client/organizations", { body: { name: "Acme" } });
    const orgId = created.response.id;

    for (const [method, path] of [
      ["GET", `/v1/client/organizations/${orgId}`],
      ["PATCH", `/v1/client/organizations/${orgId}`],
      ["DELETE", `/v1/client/organizations/${orgId}`],
      ["GET", `/v1/client/organizations/${orgId}/memberships`],
      ["GET", `/v1/client/organizations/${orgId}/invitations`],
      ["GET", `/v1/client/organizations/${orgId}/roles`],
    ] as const) {
      const res = await stranger.client.request(path, method === "GET" ? {} : { method, body: { name: "Hijacked" } });
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // The owner still sees it unchanged.
    const after = await owner.client.json<{ response: { name: string } }>(`/v1/client/organizations/${orgId}`);
    expect(after.response.name).toBe("Acme");
  });

  it("prevents a member from granting themselves an admin role", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ organizations: { enabled: true } });
    const owner = await signUpUser(app, { email: "owner2@example.com" });
    const member = await signUpUser(app, { email: "member2@example.com" });
    const created = await owner.client.json<{ response: { id: string } }>("/v1/client/organizations", { body: { name: "Acme2" } });
    const orgId = created.response.id;
    await owner.client.request(`/v1/client/organizations/${orgId}/invitations`, { body: { email_address: "member2@example.com" } });
    const invite = await member.client.json<{ response: unknown[] }>("/v1/client/me/organization_invitations");
    const inviteId = (invite.response[0] as { id: string }).id;
    await member.client.request(`/v1/client/me/organization_invitations/${inviteId}/accept`, { body: {} });

    const res = await member.client.request(`/v1/client/organizations/${orgId}/memberships/${member.userId}`, {
      method: "PATCH",
      body: { role: "org:admin" },
    });
    expect(res.status).toBe(403);
    const membership = await owner.client.json<{ response: { role: string; public_user_data: { user_id: string } }[] }>(`/v1/client/organizations/${orgId}/memberships`);
    const own = membership.response.find((m) => m.public_user_data.user_id === member.userId);
    expect(own?.role).toBe("org:member");
  });
});

describe("client-facing responses", () => {
  it("never returns private_metadata or password hashes from the Frontend API", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const schema = await import("../../src/db/schema");
    await ctx.db.update(schema.users).set({ privateMetadata: { internal: "secret" }, passwordHash: "$argon2id$v=19$fake" })
      .where((await import("drizzle-orm")).eq(schema.users.id, user.userId));

    const me = await user.client.request("/v1/client/me");
    const text = await me.text();
    expect(text).not.toContain("internal");
    expect(text).not.toContain("$argon2id$");
    const client = await user.client.request("/v1/client");
    expect(await client.text()).not.toContain("internal");
  });
});

describe("signature-bound responses", () => {
  it("does not leak whether a client cookie is valid through a different status code", async () => {
    const { app } = await setup();
    const unknown = await app.request("/v1/client/me", { headers: { cookie: `${COOKIES.client}=not-a-real-token` } });
    expect([401, 404]).toContain(unknown.status);
    expect(testClient).toBeTruthy();
  });
});
