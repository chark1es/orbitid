import { beforeAll, describe, expect, it, vi } from "vitest";
import { exportSPKI, generateKeyPair, SignJWT, type KeyLike } from "jose";
import { encodePublishableKey, type SessionClaims } from "@orbitid/shared";
import { buildAuthObject, createClaimsHasCheck } from "../src/auth-object";
import { authenticateRequest, parseCookie } from "../src/authenticate-request";

const ISSUER = "https://auth.example.com";

let privateKey: KeyLike;
let publicKeyPem: string;

beforeAll(async () => {
  const pair = await generateKeyPair("RS256");
  privateKey = pair.privateKey;
  publicKeyPem = await exportSPKI(pair.publicKey);
});

async function sign(overrides: { expiresAt?: number | string; key?: KeyLike } = {}): Promise<string> {
  return new SignJWT({ sid: "sess_1", org_role: "org:admin", org_permissions: ["org:sys_memberships:manage", "org:team:read"], fva: [5, 30], sts: "active" })
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(ISSUER)
    .setSubject("user_1")
    .setIssuedAt()
    .setExpirationTime(overrides.expiresAt ?? "5m")
    .sign(overrides.key ?? privateKey);
}

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://app.example.com/dashboard", { headers });
}

describe("buildAuthObject", () => {
  const claims: SessionClaims = {
    iss: ISSUER,
    sub: "user_1",
    sid: "sess_1",
    iat: Math.floor(Date.now() / 1000),
    nbf: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + 60,
    org_id: "org_1",
    org_slug: "acme",
    org_role: "org:admin",
    org_permissions: ["org:sys_memberships:manage", "org:team:read"],
    act: { sub: "admin_1" },
    fva: [5, 30],
    sts: "active",
  };
  const auth = buildAuthObject(claims, async () => "token", { signInUrl: "/sign-in" });

  it("maps claims to the AuthObject", () => {
    expect(auth.userId).toBe("user_1");
    expect(auth.sessionId).toBe("sess_1");
    expect(auth.orgId).toBe("org_1");
    expect(auth.orgSlug).toBe("acme");
    expect(auth.orgRole).toBe("org:admin");
    expect(auth.orgPermissions).toEqual(["org:sys_memberships:manage", "org:team:read"]);
    expect(auth.actor).toEqual({ sub: "admin_1" });
    expect(auth.sessionClaims).toBe(claims);
    expect(auth.sessionStatus).toBe("active");
    expect(auth.isAuthenticated).toBe(true);
  });

  it("implements has() for roles, permissions, features and reverification", () => {
    expect(auth.has({ role: "org:admin" })).toBe(true);
    expect(auth.has({ role: "org:member" })).toBe(false);
    expect(auth.has({ permission: "org:sys_memberships:manage" })).toBe(true);
    expect(auth.has({ permission: "org:sys_profile:delete" })).toBe(false);
    expect(auth.has({ feature: "team", permission: "read" })).toBe(true);
    expect(auth.has({ feature: "team", permission: "write" })).toBe(false);
    expect(auth.has({ reverification: "moderate" })).toBe(true);
    expect(auth.has({ reverification: "strict_mfa" })).toBe(false);
    expect(createClaimsHasCheck({ ...claims, org_permissions: ["org:billing:*"] })({ permission: "org:billing:manage" })).toBe(true);
  });

  it("produces a signed-out AuthObject and a sign-in redirect", async () => {
    const signedOut = buildAuthObject(null, async () => null, { signInUrl: "/sign-in" });
    expect(signedOut.userId).toBeNull();
    expect(signedOut.orgRole).toBeNull();
    expect(signedOut.sessionStatus).toBeNull();
    expect(signedOut.isAuthenticated).toBe(false);
    expect(signedOut.has({ role: "org:admin" })).toBe(false);

    const redirect = auth.redirectToSignIn({ returnBackUrl: "/dashboard" }) as Response;
    expect(redirect.status).toBe(307);
    expect(redirect.headers.get("Location")).toBe("/sign-in?redirect_url=%2Fdashboard");
  });
});

describe("authenticateRequest", () => {
  const baseOptions = () => ({ jwtKey: publicKeyPem, issuer: ISSUER });

  it("authenticates a Bearer token", async () => {
    const token = await sign();
    const state = await authenticateRequest(requestWith({ authorization: `Bearer ${token}` }), baseOptions());
    expect(state.status).toBe("signed-in");
    expect(state.reason).toBeNull();
    expect(state.token).toBe(token);
    expect(state.headers["Cache-Control"]).toBe("private, no-store");
    expect(state.toAuth().userId).toBe("user_1");
    expect(state.toAuth().orgRole).toBe("org:admin");
  });

  it("authenticates a __session cookie with __client_uat", async () => {
    const token = await sign();
    const state = await authenticateRequest(requestWith({ cookie: `__session=${token}; __client_uat=1700000000` }), baseOptions());
    expect(state.status).toBe("signed-in");
    expect(state.toAuth().has({ permission: "org:sys_memberships:manage" })).toBe(true);
  });

  it("short-circuits signed-out visitors with __client_uat=0", async () => {
    expect((await authenticateRequest(requestWith({}), baseOptions())).reason).toBe("no-session-token");
    expect((await authenticateRequest(requestWith({ cookie: "__client_uat=0" }), baseOptions())).reason).toBe("client-uat-zero");
    const token = await sign();
    const state = await authenticateRequest(requestWith({ cookie: `__session=${token}; __client_uat=0` }), baseOptions());
    expect(state.status).toBe("signed-out");
    expect(state.reason).toBe("client-uat-zero");
    expect(state.token).toBeNull();
  });

  it("flags refreshable sessions and invalid tokens", async () => {
    const expired = await sign({ expiresAt: Math.floor(Date.now() / 1000) - 10 });
    const refresh = await authenticateRequest(requestWith({ cookie: `__session=${expired}; __client_uat=1700000000` }), baseOptions());
    expect(refresh.status).toBe("signed-out");
    expect(refresh.reason).toBe("session-token-expired-refresh-needed");
    expect(refresh.handshakeUrl).toBeNull();

    const expiredWithoutClient = await authenticateRequest(requestWith({ cookie: `__session=${expired}` }), baseOptions());
    expect(expiredWithoutClient.reason).toBe("session-token-expired");

    const missing = await authenticateRequest(requestWith({ cookie: "__client_uat=1700000000" }), baseOptions());
    expect(missing.reason).toBe("session-token-missing-refresh-needed");

    const invalid = await authenticateRequest(requestWith({ cookie: "__session=garbage.token.value; __client_uat=1700000000" }), baseOptions());
    expect(invalid.reason).toBe("session-token-invalid");
    expect(invalid.toAuth().isAuthenticated).toBe(false);
  });

  it("offers a handshake URL when a live client holds a dead token", async () => {
    const expired = await sign({ expiresAt: Math.floor(Date.now() / 1000) - 10 });
    const options = { ...baseOptions(), apiUrl: "https://auth.example.com" };

    const expiredState = await authenticateRequest(requestWith({ cookie: `__session=${expired}; __client_uat=1700000000` }), options);
    expect(expiredState.reason).toBe("session-token-expired");
    expect(expiredState.handshakeUrl).toBe(
      `https://auth.example.com/v1/client/handshake?redirect_url=${encodeURIComponent("https://app.example.com/dashboard")}`,
    );

    const missingState = await authenticateRequest(requestWith({ cookie: "__client_uat=1700000000" }), options);
    expect(missingState.reason).toBe("session-token-missing-refresh-needed");
    expect(missingState.handshakeUrl).toContain("/v1/client/handshake?redirect_url=");

    const invalidState = await authenticateRequest(requestWith({ cookie: "__session=garbage.token.value; __client_uat=1700000000" }), options);
    expect(invalidState.reason).toBe("session-token-invalid");
    expect(invalidState.handshakeUrl).toContain("/v1/client/handshake?redirect_url=");
  });

  it("builds the handshake URL from the publishable key and `returnBackUrl`", async () => {
    const expired = await sign({ expiresAt: Math.floor(Date.now() / 1000) - 10 });
    const { encodePublishableKey } = await import("@orbitid/shared");
    const state = await authenticateRequest(requestWith({ cookie: `__session=${expired}; __client_uat=1700000000` }), {
      ...baseOptions(),
      publishableKey: encodePublishableKey("https://auth.example.com", "test"),
      returnBackUrl: "https://app.example.com/settings?tab=2",
    });
    expect(state.handshakeUrl).toBe(
      `https://auth.example.com/v1/client/handshake?redirect_url=${encodeURIComponent("https://app.example.com/settings?tab=2")}`,
    );
  });

  it("never suggests a handshake without an API URL or for a bearer token", async () => {
    const expired = await sign({ expiresAt: Math.floor(Date.now() / 1000) - 10 });
    // No apiUrl / publishableKey → nothing to point at.
    const noApi = await authenticateRequest(requestWith({ cookie: `__session=${expired}; __client_uat=1700000000` }), baseOptions());
    expect(noApi.handshakeUrl).toBeNull();

    // A Bearer caller can mint another token itself, and a handshake would be a useless redirect.
    const bearerState = await authenticateRequest(requestWith({ authorization: `Bearer ${expired}`, cookie: "__client_uat=1700000000" }), {
      ...baseOptions(),
      apiUrl: "https://auth.example.com",
    });
    expect(bearerState.handshakeUrl).toBeNull();
  });

  it("never suggests a handshake for a signed-in request or a signed-out browser", async () => {
    const token = await sign();
    const options = { ...baseOptions(), apiUrl: "https://auth.example.com" };
    expect((await authenticateRequest(requestWith({ authorization: `Bearer ${token}` }), options)).handshakeUrl).toBeNull();
    expect((await authenticateRequest(requestWith({ cookie: "__client_uat=0" }), options)).handshakeUrl).toBeNull();
    expect((await authenticateRequest(requestWith({}), options)).handshakeUrl).toBeNull();
  });

  it("mints refreshed tokens through the Backend API for toAuth().getToken", async () => {
    const token = await sign();
    const backendFetch = vi.fn(async (input: string, init?: RequestInit) => {
      expect(input).toBe("https://auth.example.com/v1/sessions/sess_1/tokens");
      expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer sk_test_123");
      return new Response(JSON.stringify({ jwt: "refreshed.jwt" }), { status: 200 });
    });
    const state = await authenticateRequest(requestWith({ authorization: `Bearer ${token}` }), {
      ...baseOptions(),
      secretKey: "sk_test_123",
      apiUrl: "https://auth.example.com",
      fetch: backendFetch,
    });
    expect(await state.toAuth().getToken()).toBe("refreshed.jwt");

    const templateFetch = vi.fn(async (input: string) => {
      expect(input).toBe("https://auth.example.com/v1/sessions/sess_1/tokens/custom");
      return new Response(JSON.stringify({ jwt: "custom.jwt" }), { status: 200 });
    });
    const templateState = await authenticateRequest(requestWith({ authorization: `Bearer ${token}` }), {
      ...baseOptions(),
      secretKey: "sk_test_123",
      apiUrl: "https://auth.example.com",
      fetch: templateFetch,
    });
    expect(await templateState.toAuth().getToken({ template: "custom" })).toBe("custom.jwt");
  });

  it("returns null tokens without backend credentials and parses cookies safely", async () => {
    const token = await sign();
    const state = await authenticateRequest(requestWith({ authorization: `Bearer ${token}` }), baseOptions());
    expect(await state.toAuth().getToken()).toBeNull();
    expect(parseCookie("__session=a%20b; other=x", "__session")).toBe("a b");
    expect(parseCookie(null, "__session")).toBeNull();
  });
});

describe("authenticateRequest issuer", () => {
  const PUBLISHABLE_KEY = encodePublishableKey("https://auth.example.com");

  it("accepts tokens issued for the public URL when apiUrl is an internal address", async () => {
    const token = await sign();
    const result = await authenticateRequest(requestWith({ authorization: `Bearer ${token}` }), {
      jwtKey: publicKeyPem,
      apiUrl: "http://orbitid:4000",
      publishableKey: PUBLISHABLE_KEY,
    });
    expect(result.status).toBe("signed-in");
  });

  it("rejects a token from another issuer", async () => {
    const foreign = await new SignJWT({ sid: "sess_1" })
      .setProtectedHeader({ alg: "RS256" })
      .setIssuer("https://evil.example")
      .setSubject("user_1")
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(privateKey);
    const result = await authenticateRequest(requestWith({ authorization: `Bearer ${foreign}` }), {
      jwtKey: publicKeyPem,
      apiUrl: "http://orbitid:4000",
      publishableKey: PUBLISHABLE_KEY,
    });
    expect(result.status).not.toBe("signed-in");
  });
});
