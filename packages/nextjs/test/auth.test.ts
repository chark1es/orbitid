import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getTestKeys, signExpiredToken, signTestToken } from "./helpers";

const headerStore = vi.hoisted(() => new Map<string, string>());

vi.mock("next/headers", () => ({
  headers: () => new Headers(Array.from(headerStore)),
  cookies: () => ({
    get: (name: string) => {
      const value = headerStore.get(name);
      return value === undefined ? undefined : { name, value };
    },
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
    error.digest = `NEXT_REDIRECT;push;${url};307;`;
    throw error;
  },
  notFound: () => {
    const error = new Error("NEXT_NOT_FOUND") as Error & { digest: string };
    error.digest = "NEXT_NOT_FOUND";
    throw error;
  },
}));

import { auth, getAuth, redirectToSignIn } from "../src/server-auth";

function setForwardedAuth(token: string | null, status = "signed-in", url = "https://app.test/dashboard") {
  headerStore.set("x-orbitid-auth-status", status);
  if (token) headerStore.set("x-orbitid-auth-token", token);
  headerStore.set("x-orbitid-auth-url", url);
}

async function captureError(action: () => Promise<unknown>): Promise<Error & { digest?: string }> {
  try {
    await action();
  } catch (error) {
    return error as Error & { digest?: string };
  }
  throw new Error("Expected the action to throw");
}

const originalEnv = { ...process.env };

beforeEach(() => {
  headerStore.clear();
  delete process.env.ORBITID_JWT_KEY;
  delete process.env.ORBITID_SECRET_KEY;
  delete process.env.NEXT_PUBLIC_ORBITID_SIGN_IN_URL;
  delete process.env.NEXT_PUBLIC_ORBITID_SIGN_UP_URL;
});

afterEach(() => {
  process.env = { ...originalEnv };
});

describe("auth()", () => {
  it("maps middleware-forwarded claims to the AuthObject", async () => {
    const token = await signTestToken({
      sub: "user_1",
      sid: "sess_1",
      org_id: "org_1",
      org_slug: "acme",
      org_role: "org:admin",
      org_permissions: ["org:sys_memberships:manage"],
    });
    setForwardedAuth(token);

    const result = await auth();
    expect(result.isAuthenticated).toBe(true);
    expect(result.userId).toBe("user_1");
    expect(result.sessionId).toBe("sess_1");
    expect(result.orgId).toBe("org_1");
    expect(result.orgSlug).toBe("acme");
    expect(result.orgRole).toBe("org:admin");
    expect(result.sessionStatus).toBe("active");
    expect(await result.getToken()).toBe(token);
    expect(result.has({ role: "org:admin" })).toBe(true);
    expect(result.has({ permission: "org:sys_memberships:manage" })).toBe(true);
    expect(result.has({ permission: "org:sys_domains:manage" })).toBe(false);
  });

  it("exposes the actor and custom claims", async () => {
    const token = await signTestToken({
      sub: "user_1",
      act: { sub: "admin_1", sid: "sess_admin" },
      fea: ["premium"],
      custom: "value",
    });
    setForwardedAuth(token);
    const result = await auth();
    expect(result.actor).toEqual({ sub: "admin_1", sid: "sess_admin" });
    expect(result.has({ feature: "premium" })).toBe(true);
    expect(result.has({ feature: "gold" })).toBe(false);
    expect(result.sessionClaims?.custom).toBe("value");
  });

  it("evaluates reverification windows from fva", async () => {
    setForwardedAuth(await signTestToken({ fva: [2, 1] }));
    const result = await auth();
    expect(result.has({ reverification: { level: "multi_factor", afterMinutes: 5 } })).toBe(true);
    expect(result.has({ reverification: { level: "multi_factor", afterMinutes: 1 } })).toBe(false);
    expect(result.has({ reverification: "lax" })).toBe(true);
  });

  it("is signed out without middleware headers or token", async () => {
    const result = await auth();
    expect(result.isAuthenticated).toBe(false);
    expect(result.userId).toBeNull();
    expect(result.has({ role: "org:admin" })).toBe(false);
    expect(await result.getToken()).toBeNull();
  });

  it("treats handshake as signed out so the client can refresh", async () => {
    headerStore.set("x-orbitid-auth-status", "handshake");
    headerStore.set("x-orbitid-auth-reason", "session-token-expired");
    const result = await auth();
    expect(result.isAuthenticated).toBe(false);
    expect(result.userId).toBeNull();
  });
});

describe("auth().protect()", () => {
  it("returns the auth object when checks pass", async () => {
    setForwardedAuth(await signTestToken({ org_role: "org:admin" }));
    const result = await auth();
    await expect(result.protect({ role: "org:admin" })).resolves.toBe(result);
    await expect(result.protect()).resolves.toBe(result);
  });

  it("throws notFound() when a signed-in user fails the role check", async () => {
    setForwardedAuth(await signTestToken({ org_role: "org:member" }));
    const result = await auth();
    const error = await captureError(() => result.protect({ role: "org:admin" }));
    expect(error.digest).toBe("NEXT_NOT_FOUND");
  });

  it("supports a custom has callback", async () => {
    setForwardedAuth(await signTestToken({ sub: "user_1" }));
    const result = await auth();
    await expect(
      result.protect({ has: (current) => current.userId === "user_1" }),
    ).resolves.toBe(result);
    const error = await captureError(() =>
      result.protect({ has: (current) => current.userId === "nope" }),
    );
    expect(error.digest).toBe("NEXT_NOT_FOUND");
  });

  it("redirects to unauthorizedUrl", async () => {
    setForwardedAuth(await signTestToken({ org_role: "org:member" }));
    const result = await auth();
    const error = await captureError(() =>
      result.protect({ role: "org:admin", unauthorizedUrl: "/no-access" }),
    );
    expect(error.digest).toContain("/no-access");
  });

  it("redirects signed-out users to sign-in with redirect_url", async () => {
    headerStore.set("x-orbitid-auth-status", "signed-out");
    headerStore.set("x-orbitid-auth-url", "https://app.test/dashboard/settings");
    const result = await auth();
    const error = await captureError(() => result.protect());
    expect(error.digest).toContain("/sign-in");
    expect(error.digest).toContain(
      encodeURIComponent("https://app.test/dashboard/settings"),
    );
  });

  it("can throw instead of redirecting when unauthenticated", async () => {
    const result = await auth();
    const error = await captureError(() => result.protect({ unauthenticated: "throw" }));
    expect(error.message).toContain("Not authenticated");
    expect(error.digest).toBeUndefined();
  });
});

describe("getAuth()", () => {
  it("verifies the __session cookie for Pages Router requests", async () => {
    process.env.ORBITID_JWT_KEY = (await getTestKeys()).publicKeyPem;
    const token = await signTestToken({ sub: "user_pages" });
    const result = await getAuth({
      headers: { cookie: `__session=${token}`, host: "app.test" },
      url: "/api/me",
    });
    expect(result.userId).toBe("user_pages");
    expect(result.isAuthenticated).toBe(true);
  });

  it("verifies a Bearer token", async () => {
    process.env.ORBITID_JWT_KEY = (await getTestKeys()).publicKeyPem;
    const token = await signTestToken({ sub: "user_bearer" });
    const result = await getAuth({ headers: { authorization: `Bearer ${token}` } });
    expect(result.userId).toBe("user_bearer");
  });

  it("accepts a GetServerSideProps context", async () => {
    process.env.ORBITID_JWT_KEY = (await getTestKeys()).publicKeyPem;
    const token = await signTestToken();
    const result = await getAuth({ req: { headers: { cookie: `__session=${token}` } } });
    expect(result.isAuthenticated).toBe(true);
  });

  it("is signed out for an expired token", async () => {
    process.env.ORBITID_JWT_KEY = (await getTestKeys()).publicKeyPem;
    const result = await getAuth({
      headers: { cookie: `__session=${await signExpiredToken()}` },
    });
    expect(result.isAuthenticated).toBe(false);
    expect(result.userId).toBeNull();
  });
});

describe("redirectToSignIn()", () => {
  it("redirects to the configured sign-in URL", () => {
    process.env.NEXT_PUBLIC_ORBITID_SIGN_IN_URL = "/login";
    const error = (() => {
      try {
        redirectToSignIn({ returnBackUrl: "/dashboard" });
      } catch (caught) {
        return caught as Error & { digest?: string };
      }
      throw new Error("expected redirect");
    })();
    expect(error.digest).toContain("/login");
    expect(error.digest).toContain(encodeURIComponent("/dashboard"));
  });
});
