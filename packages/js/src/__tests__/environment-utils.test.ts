import { describe, expect, it } from "vitest";
import { Environment } from "../resources/environment";
import {
  appendQuery,
  buildRedirectUrl,
  getSafeRedirectUrl,
  isAbsoluteUrl,
  isSafeRedirectUrl,
  toAbsoluteUrl,
  validateRedirectUrl,
} from "../util/url";
import { toPaginatedResponse, toQueryString, toList } from "../util/pagination";
import { decodeJwtPayload, isTokenExpired, tokenExpiresAt } from "../util/jwt";
import { checkReverification, createHasCheck } from "../util/reverification";
import {
  inBrowser,
  isWebAuthnAutofillSupported,
  isWebAuthnPlatformAuthenticatorSupported,
  isWebAuthnSupported,
  isValidBrowserOnline,
} from "../util/browser";
import { environmentJSON, fakeJwt } from "./helpers";

describe("Environment", () => {
  it("exposes camelCase settings and helpers", () => {
    const environment = Environment.fromJSON(environmentJSON());
    expect(environment.authConfig.firstFactors).toContain("password");
    expect(environment.userSettings.attributes.emailAddress.usedForFirstFactor).toBe(true);
    expect(environment.userSettings.enabledFirstFactorIdentifierAttributes).toEqual(["emailAddress", "password"]);
    expect(environment.userSettings.enabledSecondFactorAttributes).toEqual(["authenticatorApp"]);
    expect(environment.userSettings.social.google.strategy).toBe("oauth_google");
    expect(environment.userSettings.socialProviderStrategies).toEqual([
      { strategy: "oauth_google", name: "Google", logoUrl: "https://logo.example.com/google.svg", authenticatable: true },
    ]);
    expect(environment.userSettings.passwordSettings).toMatchObject({ minLength: 10, requireLowercase: true });
    expect(environment.userSettings.signUp.progressive).toBe(true);
    expect(environment.organizationSettings.enabled).toBe(true);
    expect(environment.organizationSettings.defaultRole).toBe("org:member");
    expect(environment.displayConfig.applicationName).toBe("Acme App");
    expect(environment.displayConfig.captchaEnabled).toBe(false);
  });
});

describe("redirect URL helpers", () => {
  const origin = "https://app.example.com";

  it("validates same-origin and allowed-origin redirects", () => {
    expect(isAbsoluteUrl("/dashboard")).toBe(false);
    expect(isAbsoluteUrl("https://app.example.com/x")).toBe(true);
    expect(isSafeRedirectUrl("/dashboard", { origin })).toBe(true);
    expect(isSafeRedirectUrl("https://app.example.com/dashboard", { origin })).toBe(true);
    expect(isSafeRedirectUrl("https://evil.example.com/x", { origin })).toBe(false);
    expect(isSafeRedirectUrl("//evil.example.com/x", { origin })).toBe(false);
    expect(isSafeRedirectUrl("javascript:alert(1)", { origin })).toBe(false);
    expect(isSafeRedirectUrl("https://other.example.com/x", { origin, allowedOrigins: ["https://other.example.com"] })).toBe(true);
    expect(validateRedirectUrl("https://evil.example.com", { origin })).toBeNull();
    expect(validateRedirectUrl("/safe", { origin })).toBe("/safe");
  });

  it("reduces safe absolute URLs to paths and drops unsafe ones", () => {
    expect(getSafeRedirectUrl("https://app.example.com/a?b=1#c", "/", { origin })).toBe("/a?b=1#c");
    expect(getSafeRedirectUrl("https://evil.example.com/a", "/fallback", { origin })).toBe("/fallback");
    expect(getSafeRedirectUrl(null, "/fallback", { origin })).toBe("/fallback");
    expect(toAbsoluteUrl("/x", origin)).toBe("https://app.example.com/x");
  });

  it("builds redirect_url queries", () => {
    expect(buildRedirectUrl("/sign-in", "/dashboard")).toBe("/sign-in?redirect_url=%2Fdashboard");
    expect(buildRedirectUrl("/sign-in?foo=1", "/dashboard")).toBe("/sign-in?foo=1&redirect_url=%2Fdashboard");
    expect(appendQuery("/sign-in#hash", { redirect_url: "/d" })).toBe("/sign-in?redirect_url=%2Fd#hash");
    expect(appendQuery("/x", { a: undefined })).toBe("/x");
  });
});

describe("pagination helpers", () => {
  it("serialises array query params Clerk-style and normalises lists", () => {
    expect(toQueryString({ limit: 10, "email_address[]": ["a@x.com", "b@x.com"], skip: undefined })).toBe(
      "?limit=10&email_address%5B%5D=a%40x.com&email_address%5B%5D=b%40x.com",
    );
    const paginated = toPaginatedResponse({ data: [{ id: 1 }, { id: 2 }], total_count: 42 }, (item) => (item as { id: number }).id);
    expect(paginated).toEqual({ data: [1, 2], totalCount: 42, count: 2 });
    expect(toPaginatedResponse([{ id: 1 }], (item) => (item as { id: number }).id).totalCount).toBe(1);
    expect(toList([{ id: 1 }], (item) => (item as { id: number }).id)).toEqual([1]);
    expect(toList({ data: [{ id: 2 }] }, (item) => (item as { id: number }).id)).toEqual([2]);
  });
});

describe("jwt helpers", () => {
  it("decodes payloads and compensates skew", () => {
    const token = fakeJwt({ org_role: "org:admin" }, { now: 1_700_000_000_000, lifetimeSeconds: 60 });
    expect(decodeJwtPayload(token)?.org_role).toBe("org:admin");
    expect(tokenExpiresAt(token, 1_700_000_000_000)).toBe(1_700_000_060_000);
    expect(isTokenExpired(token, 1_700_000_000_000)).toBe(false);
    expect(isTokenExpired(token, 1_700_000_061_000)).toBe(true);
    expect(decodeJwtPayload("not-a-jwt")).toBeNull();
  });
});

describe("authorization checks", () => {
  const has = createHasCheck({ orgRole: "org:admin", orgPermissions: ["org:sys_memberships:manage", "org:team:read"], fva: [5, 30] });

  it("checks roles, system permissions and custom permissions", () => {
    expect(has({ role: "org:admin" })).toBe(true);
    expect(has({ role: "org:member" })).toBe(false);
    expect(has({ permission: "org:sys_memberships:manage" })).toBe(true);
    expect(has({ permission: "org:team:read" })).toBe(true);
    expect(has({ permission: "org:team:write" })).toBe(false);
    expect(has({ feature: "team", permission: "read" })).toBe(true);
    expect(has({ feature: "team", permission: "write" })).toBe(false);
    expect(createHasCheck({ orgPermissions: ["org:team:*"] })({ permission: "org:team:write" })).toBe(true);
  });

  it("evaluates reverification presets and levels", () => {
    expect(checkReverification({ firstFactor: 5, secondFactor: 9 }, "strict_mfa")).toBe(true);
    expect(checkReverification({ firstFactor: 5, secondFactor: 15 }, "strict_mfa")).toBe(false);
    expect(checkReverification({ firstFactor: 5, secondFactor: -1 }, "strict")).toBe(true);
    expect(checkReverification({ firstFactor: 90, secondFactor: 90 }, "moderate")).toBe(false);
    expect(checkReverification({ firstFactor: 1000, secondFactor: 1000 }, "lax")).toBe(true);
    expect(checkReverification({ firstFactor: 5, secondFactor: -1 }, { level: "second_factor", afterMinutes: 10 })).toBe(false);
    expect(checkReverification({ firstFactor: 5, secondFactor: 4 }, { level: "multi_factor", afterMinutes: 10 })).toBe(true);
    expect(has({ reverification: "moderate" })).toBe(true);
    expect(has({ reverification: "strict_mfa" })).toBe(false);
    expect(createHasCheck({ orgRole: "org:admin", fva: [30, -1] })({ reverification: "strict" })).toBe(false);
  });
});

describe("browser capability helpers", () => {
  it("detects the browser and online state", () => {
    expect(inBrowser).toBe(true);
    expect(isValidBrowserOnline()).toBe(true);
  });

  it("reports WebAuthn support and capability probes", async () => {
    expect(isWebAuthnSupported()).toBe(false);
    expect(await isWebAuthnAutofillSupported()).toBe(false);
    expect(await isWebAuthnPlatformAuthenticatorSupported()).toBe(false);

    Object.defineProperty(window, "PublicKeyCredential", {
      configurable: true,
      value: { isConditionalMediationAvailable: async () => true, isUserVerifyingPlatformAuthenticatorAvailable: async () => true },
    });
    Object.defineProperty(navigator, "credentials", { configurable: true, value: {} });
    try {
      expect(isWebAuthnSupported()).toBe(true);
      expect(await isWebAuthnAutofillSupported()).toBe(true);
      expect(await isWebAuthnPlatformAuthenticatorSupported()).toBe(true);
    } finally {
      Object.defineProperty(window, "PublicKeyCredential", { configurable: true, value: undefined });
      Object.defineProperty(navigator, "credentials", { configurable: true, value: undefined });
    }
  });
});
