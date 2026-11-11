// Interop negatives and refresh-token rotation semantics.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { decodeJwt } from "jose";
import { createHash, randomBytes } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { createApplication } from "../../src/services/oidc";
import { sha256 } from "../../src/lib/crypto";
import { insertClientSession, insertUser } from "../machine/helpers";
import { startOidcServer, type OidcTestServer } from "../support/oidc-server";

const REDIRECT_URI = "http://localhost:3000/callback";
const verifier = () => randomBytes(32).toString("base64url");
const challengeFor = (value: string) => createHash("sha256").update(value).digest("base64url");
const basic = (clientId: string, secret: string) => `Basic ${Buffer.from(`${clientId}:${secret}`).toString("base64")}`;

describe("OIDC interop — negatives and refresh rotation", () => {
  let s: OidcTestServer;
  let user: Awaited<ReturnType<typeof insertUser>>;
  let session: Awaited<ReturnType<typeof insertClientSession>>;

  beforeAll(async () => {
    s = await startOidcServer();
  });
  afterAll(async () => {
    await s.close();
  });
  beforeEach(async () => {
    const suffix = randomBytes(4).toString("hex");
    user = await insertUser(s.ctx, { username: `ada-${suffix}`, email: `ada-${suffix}@example.com` });
    session = await insertClientSession(s.ctx, user.userId);
  });

  async function app(overrides: Record<string, unknown> = {}) {
    const created = await createApplication(s.ctx, {
      name: "Client", redirectUris: [REDIRECT_URI], scopes: "openid profile email offline_access",
      consentScreenEnabled: false, ...overrides,
    });
    return { clientId: created.row.clientId, secret: created.clientSecret!, id: created.row.id };
  }

  async function codeFor(clientId: string, params: Record<string, string> = {}, pkce?: string) {
    const query: Record<string, string> = {
      client_id: clientId, redirect_uri: REDIRECT_URI, response_type: "code", scope: params.scope ?? "openid profile email offline_access", ...params,
    };
    if (pkce) {
      query.code_challenge = challengeFor(pkce);
      query.code_challenge_method = "S256";
    }
    const response = await fetch(`${s.baseUrl}/oauth/authorize?${new URLSearchParams(query)}`, { redirect: "manual", headers: { cookie: session.cookie } });
    expect(response.status).toBe(302);
    return new URL(response.headers.get("location")!).searchParams.get("code")!;
  }

  async function token(form: Record<string, string>, headers: Record<string, string> = {}) {
    return fetch(`${s.baseUrl}/oauth/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
      body: new URLSearchParams(form).toString(),
    });
  }

  it("rejects a reused code, an expired code, a wrong redirect URI and a wrong secret", async () => {
    const client = await app();
    const code = await codeFor(client.clientId);
    const first = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }, { authorization: basic(client.clientId, client.secret) });
    expect(first.status).toBe(200);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect((await first.clone().json() as Record<string, string>).token_type).toBe("Bearer");
    const replay = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }, { authorization: basic(client.clientId, client.secret) });
    expect(replay.status).toBe(400);
    expect((await replay.json() as Record<string, string>).error).toBe("invalid_grant");

    const expiredCode = await codeFor(client.clientId);
    await s.ctx.db.update(schema.oauthGrants).set({ expiresAt: Date.now() - 1 }).where(eq(schema.oauthGrants.tokenHash, sha256(expiredCode)));
    const expired = await token({ grant_type: "authorization_code", code: expiredCode, redirect_uri: REDIRECT_URI }, { authorization: basic(client.clientId, client.secret) });
    expect(expired.status).toBe(400);

    const wrongRedirect = await codeFor(client.clientId);
    const redirect = await token({ grant_type: "authorization_code", code: wrongRedirect, redirect_uri: "http://localhost:3000/other" }, { authorization: basic(client.clientId, client.secret) });
    expect(redirect.status).toBe(400);
    expect((await redirect.json() as Record<string, string>).error).toBe("invalid_grant");

    const wrongSecret = await token({ grant_type: "authorization_code", code: await codeFor(client.clientId), redirect_uri: REDIRECT_URI }, { authorization: basic(client.clientId, "wrong") });
    expect(wrongSecret.status).toBe(401);
    expect(wrongSecret.headers.get("www-authenticate")).toContain("Basic");
  });

  it("rejects a PKCE mismatch without burning the code", async () => {
    const client = await app({ pkceRequired: true });
    const pkce = verifier();
    const code = await codeFor(client.clientId, {}, pkce);
    const mismatch = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: "wrong" }, { authorization: basic(client.clientId, client.secret) });
    expect(mismatch.status).toBe(400);
    expect((await mismatch.json() as Record<string, string>).error).toBe("invalid_grant");
    const ok = await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI, code_verifier: pkce }, { authorization: basic(client.clientId, client.secret) });
    expect(ok.status).toBe(200);
  });

  it("refuses refresh scope escalation and a refresh token presented by another client", async () => {
    const client = await app();
    const code = await codeFor(client.clientId);
    const tokens = await (await token({ grant_type: "authorization_code", code, redirect_uri: REDIRECT_URI }, { authorization: basic(client.clientId, client.secret) })).json() as Record<string, string>;

    const escalated = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, scope: "openid admin" }, { authorization: basic(client.clientId, client.secret) });
    expect(escalated.status).toBe(400);
    expect((await escalated.json() as Record<string, string>).error).toBe("invalid_scope");

    const narrowed = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token!, scope: "openid email" }, { authorization: basic(client.clientId, client.secret) });
    expect(narrowed.status).toBe(200);
    expect((await narrowed.json() as Record<string, string>).scope).toBe("openid email");

    const other = await app({ name: "Other" });
    const foreign = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token! }, { authorization: basic(other.clientId, other.secret) });
    expect(foreign.status).toBe(400);
    expect((await foreign.json() as Record<string, string>).error).toBe("invalid_grant");
  });

  it("tolerates a retry of a rotated refresh token inside the grace window", async () => {
    const client = await app();
    const tokens = await (await token({ grant_type: "authorization_code", code: await codeFor(client.clientId), redirect_uri: REDIRECT_URI }, { authorization: basic(client.clientId, client.secret) })).json() as Record<string, string>;
    const first = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token! }, { authorization: basic(client.clientId, client.secret) });
    expect(first.status).toBe(200);
    const rotated = await first.json() as Record<string, string>;

    // The response was "lost": the same token is retried immediately, as a client would.
    const retried = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token! }, { authorization: basic(client.clientId, client.secret) });
    expect(retried.status).toBe(200);
    const retriedTokens = await retried.json() as Record<string, string>;
    expect(retriedTokens.refresh_token).toMatch(/^ort_/);

    // Both the previous replacement and the retry's replacement remain usable inside the window.
    const fromRotated = await token({ grant_type: "refresh_token", refresh_token: rotated.refresh_token! }, { authorization: basic(client.clientId, client.secret) });
    expect(fromRotated.status).toBe(200);
  });

  it("revokes the family when a rotated token is replayed after the grace window", async () => {
    const client = await app();
    const tokens = await (await token({ grant_type: "authorization_code", code: await codeFor(client.clientId), redirect_uri: REDIRECT_URI }, { authorization: basic(client.clientId, client.secret) })).json() as Record<string, string>;
    const rotated = await (await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token! }, { authorization: basic(client.clientId, client.secret) })).json() as Record<string, string>;

    // Age the consumption time of every refresh row in this application past the retry window. (The window is
    // measured from the original consumption, never from the successor's creation.)
    await s.ctx.db.update(schema.oauthGrants).set({ consumedAt: Date.now() - 60_000 })
      .where(and(eq(schema.oauthGrants.kind, "refresh"), eq(schema.oauthGrants.applicationId, client.id)));
    const replay = await token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token! }, { authorization: basic(client.clientId, client.secret) });
    expect(replay.status).toBe(400);
    expect((await replay.json() as Record<string, string>).error).toBe("invalid_grant");

    const dead = await token({ grant_type: "refresh_token", refresh_token: rotated.refresh_token! }, { authorization: basic(client.clientId, client.secret) });
    expect(dead.status).toBe(400);
    const rows = await s.ctx.db.select().from(schema.oauthGrants).where(and(eq(schema.oauthGrants.kind, "refresh"), eq(schema.oauthGrants.applicationId, client.id))).orderBy(desc(schema.oauthGrants.createdAt));
    expect(rows.every((row) => row.revoked)).toBe(true);
  });

  it("does not let a concurrent pair of refreshes destroy the grant", async () => {
    const client = await app();
    const tokens = await (await token({ grant_type: "authorization_code", code: await codeFor(client.clientId), redirect_uri: REDIRECT_URI }, { authorization: basic(client.clientId, client.secret) })).json() as Record<string, string>;
    const [a, b] = await Promise.all([
      token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token! }, { authorization: basic(client.clientId, client.secret) }),
      token({ grant_type: "refresh_token", refresh_token: tokens.refresh_token! }, { authorization: basic(client.clientId, client.secret) }),
    ]);
    expect([a.status, b.status]).toEqual(expect.arrayContaining([200]));
    const winner = a.status === 200 ? await a.json() as Record<string, string> : await b.json() as Record<string, string>;
    const survivor = await token({ grant_type: "refresh_token", refresh_token: winner.refresh_token! }, { authorization: basic(client.clientId, client.secret) });
    expect(survivor.status).toBe(200);
  });

  it("validates ID token claims and userinfo POST body tokens", async () => {
    const client = await app();
    const tokens = await (await token({ grant_type: "authorization_code", code: await codeFor(client.clientId), redirect_uri: REDIRECT_URI }, { authorization: basic(client.clientId, client.secret) })).json() as Record<string, string>;
    const claims = decodeJwt(tokens.id_token);
    expect(claims.iss).toBe(s.baseUrl);
    expect(claims.aud).toBe(client.clientId);
    expect(claims.azp).toBe(client.clientId);
    expect(claims.sub).toBe(user.userId);
    expect(typeof claims.exp).toBe("number");

    const viaBody = await fetch(`${s.baseUrl}/oauth/userinfo`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ access_token: tokens.access_token }).toString(),
    });
    expect(viaBody.status).toBe(200);
    expect((await viaBody.json() as Record<string, string>).sub).toBe(user.userId);

    const viaGetQuery = await fetch(`${s.baseUrl}/oauth/userinfo?access_token=${encodeURIComponent(tokens.access_token)}`);
    expect(viaGetQuery.status).toBe(200);

    const bad = await fetch(`${s.baseUrl}/oauth/userinfo`, { headers: { authorization: "Bearer oat_nope" } });
    expect(bad.status).toBe(401);
    expect(bad.headers.get("www-authenticate")).toContain("Bearer");
  });
});
