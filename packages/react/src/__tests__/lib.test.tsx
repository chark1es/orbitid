import { describe, expect, it, vi } from "vitest";
import { act, renderHook } from "@testing-library/react";
import { checkHas, createAuthState } from "../provider/auth";
import type { OrganizationResource, SessionResource } from "../provider/types";
import { createTranslator } from "../localization/translate";
import { enUS } from "../localization/enUS";
import {
  appendRedirectParam,
  buildComponentUrl,
  isValidRedirectUrl,
  resolveComponentUrl,
  resolveRedirectUrl,
} from "../lib/redirects";
import {
  getErrorMessage,
  handleOrbitError,
  isReverificationError,
  mapFieldErrors,
} from "../lib/errors";
import { decodeJwt } from "../lib/jwt";
import { useCountdown } from "../lib/useCountdown";
import { withPublicUserDataAliases } from "../lib/resources";
import { fakeSession, fakeUser, makeJwt, sessionClaims } from "./helpers";

const t = createTranslator(enUS);

describe("has()", () => {
  const context = {
    isSignedIn: true,
    orgRole: "org:admin",
    orgPermissions: ["org:sys_memberships:manage"],
    features: ["premium"],
    factorVerificationAge: [5, 3] as [number, number],
  };

  it("checks roles, permissions, features and conditions", () => {
    expect(checkHas({ role: "org:admin" }, context)).toBe(true);
    expect(checkHas({ role: "org:member" }, context)).toBe(false);
    expect(checkHas({ permission: "org:sys_memberships:manage" }, context)).toBe(true);
    expect(checkHas({ permission: "org:sys_domains:manage" }, context)).toBe(false);
    expect(checkHas({ feature: "premium" }, context)).toBe(true);
    expect(checkHas({ feature: "beta" }, context)).toBe(false);
    expect(checkHas({ condition: true }, context)).toBe(true);
    expect(checkHas({ condition: false }, context)).toBe(false);
  });

  it("checks instance grants separately from organization membership", () => {
    const instanceContext = { ...context, orgRole: null, orgPermissions: [], roles: ["app:support"], rolePermissions: ["app:reports:*"] };
    expect(checkHas({ role: "app:support" }, instanceContext)).toBe(true);
    expect(checkHas({ permission: "app:reports:read" }, instanceContext)).toBe(true);
    expect(checkHas({ permission: "app:users:delete" }, instanceContext)).toBe(false);
    expect(checkHas({ role: "org:admin" }, instanceContext)).toBe(false);
    expect(checkHas({ role: "app:support" }, { ...instanceContext, isSignedIn: false })).toBe(false);
    expect(checkHas({ permission: "org:reports:read" }, { ...instanceContext, rolePermissions: ["org:reports:*"] })).toBe(false);
  });

  it("takes instance grants from session claims and ignores metadata", () => {
    const state = createAuthState({ loaded: true, session: fakeSession(), user: null, organization: null, instance: null,
      claims: sessionClaims({ roles: ["app:support"], role_permissions: ["app:reports:read"] }) });
    expect(state.roles).toEqual(["app:support"]);
    expect(state.rolePermissions).toEqual(["app:reports:read"]);
    expect(state.has({ role: "app:support" })).toBe(true);
    expect(state.has({ permission: "app:reports:read" })).toBe(true);
    const metadataOnly = createAuthState({ loaded: true, session: fakeSession(), organization: null, instance: null,
      user: fakeUser({ publicMetadata: { roles: ["app:support"], role_permissions: ["app:reports:read"] }, unsafeMetadata: { roles: ["app:support"] } }),
      claims: sessionClaims() });
    expect(metadataOnly.roles).toEqual([]);
    expect(metadataOnly.has({ role: "app:support" })).toBe(false);
    expect(metadataOnly.has({ permission: "app:reports:read" })).toBe(false);
  });

  it("checks reverification presets and custom levels", () => {
    expect(checkHas({ reverification: "strict_mfa" }, context)).toBe(true);
    expect(checkHas({ reverification: "strict" }, context)).toBe(true);

    const staleSecondFactor = { ...context, factorVerificationAge: [5, 60] as [number, number] };
    expect(checkHas({ reverification: "strict_mfa" }, staleSecondFactor)).toBe(false);
    expect(checkHas({ reverification: "strict" }, staleSecondFactor)).toBe(true);
    expect(checkHas({ reverification: { level: "second_factor", afterMinutes: 10 } }, staleSecondFactor)).toBe(false);
    expect(checkHas({ reverification: { level: "second_factor", afterMinutes: 90 } }, staleSecondFactor)).toBe(true);

    const neverVerified = { ...context, factorVerificationAge: [-1, -1] as [number, number] };
    expect(checkHas({ reverification: "lax" }, neverVerified)).toBe(false);
    expect(checkHas({ reverification: "strict" }, { ...context, factorVerificationAge: null })).toBe(false);
  });

  it("is false when signed out and rejects ambiguous calls", () => {
    expect(checkHas({ role: "org:admin" }, { ...context, isSignedIn: false })).toBe(false);
    expect(checkHas({}, context)).toBe(false);
    expect(() => checkHas({ role: "org:admin", permission: "x" }, context)).toThrow(/exactly one/);
  });
});

describe("createAuthState", () => {
  it("derives auth fields from session claims", () => {
    const state = createAuthState({
      loaded: true,
      session: fakeSession({ lastActiveToken: { object: "token", jwt: makeJwt(sessionClaims({ org_role: "org:admin" })) } }),
      user: null,
      organization: null,
      claims: sessionClaims({
        org_id: "org_1",
        org_role: "org:admin",
        org_permissions: ["org:sys_memberships:manage"],
        act: { sub: "admin_1" },
        fva: [1, 1],
      }),
      instance: null,
    });

    expect(state).toMatchObject({
      isLoaded: true,
      isSignedIn: true,
      userId: "user_1",
      sessionId: "sess_1",
      orgId: "org_1",
      orgRole: "org:admin",
      actor: { sub: "admin_1" },
    });
    expect(state.has({ permission: "org:sys_memberships:manage" })).toBe(true);
    expect(state.has({ reverification: "strict_mfa" })).toBe(true);
  });

  it("falls back to the session/organization when no claims are available", () => {
    const session = {
      id: "sess_2",
      status: "active",
      publicUserData: { user_id: "user_2" },
      lastActiveOrganizationId: "org_2",
      getToken: async () => "",
    } as unknown as SessionResource;

    const state = createAuthState({
      loaded: true,
      session,
      user: null,
      organization: { id: "org_2", slug: "beta" } as unknown as OrganizationResource,
      claims: null,
      instance: null,
    });

    expect(state.userId).toBe("user_2");
    expect(state.orgId).toBe("org_2");
    expect(state.orgSlug).toBe("beta");
    expect(state.orgRole).toBeNull();
    expect(state.isSignedIn).toBe(true);
  });

  it("reports isSignedIn as undefined until loaded", () => {
    const state = createAuthState({
      loaded: false,
      session: null,
      user: null,
      organization: null,
      claims: null,
      instance: null,
    });
    expect(state.isSignedIn).toBeUndefined();
    expect(state.isLoaded).toBe(false);
  });
});

describe("redirect helpers", () => {
  it("applies redirect precedence and validates origins", () => {
    const allowlist = { origin: "https://app.example.com", allowedRedirectOrigins: ["https://trusted.dev", /\.corp\.com$/] };

    expect(
      resolveRedirectUrl({
        redirectUrl: "https://evil.dev",
        forceRedirectUrl: "/forced",
        fallbackRedirectUrl: "/fallback",
        ...allowlist,
      }),
    ).toBe("/forced");
    expect(resolveRedirectUrl({ redirectUrl: "/after", fallbackRedirectUrl: "/fallback", ...allowlist })).toBe("/after");
    expect(resolveRedirectUrl({ redirectUrl: "https://evil.dev", fallbackRedirectUrl: "/fallback", ...allowlist })).toBe(
      "/fallback",
    );
    expect(resolveRedirectUrl({ ...allowlist })).toBeUndefined();
    expect(resolveRedirectUrl({ defaultRedirectUrl: "/home", ...allowlist })).toBe("/home");

    expect(isValidRedirectUrl("https://app.example.com/x", allowlist)).toBe(true);
    expect(isValidRedirectUrl("https://trusted.dev/x", allowlist)).toBe(true);
    expect(isValidRedirectUrl("https://team.corp.com/x", allowlist)).toBe(true);
    expect(isValidRedirectUrl("https://evil.dev/x", allowlist)).toBe(false);
    expect(isValidRedirectUrl("//evil.dev/x", allowlist)).toBe(false);
    expect(isValidRedirectUrl("javascript:alert(1)", allowlist)).toBe(false);
    expect(isValidRedirectUrl("", allowlist)).toBe(false);
  });

  it("builds and decorates component URLs", () => {
    expect(appendRedirectParam("/sign-in", "redirect_url", "https://app.dev/a?b=1")).toBe(
      `/sign-in?redirect_url=${encodeURIComponent("https://app.dev/a?b=1")}`,
    );
    expect(appendRedirectParam("/sign-in?x=1", "redirect_url", "/after")).toBe("/sign-in?x=1&redirect_url=%2Fafter");
    expect(appendRedirectParam("/sign-in", "redirect_url", "/after")).toBe(appendRedirectParam("/sign-in", "redirect_url", "/after"));
    expect(appendRedirectParam("/sign-in", "redirect_url")).toBe("/sign-in");

    expect(buildComponentUrl("/sign-in", "user-profile")).toBe("/user-profile");
    expect(buildComponentUrl("/auth/sign-up", "user-profile")).toBe("/auth/user-profile");
    expect(buildComponentUrl("/auth", "user-profile")).toBe("/auth/user-profile");
    expect(buildComponentUrl(undefined, "sign-in")).toBe("/sign-in");

    expect(
      resolveComponentUrl({ component: "sign-in", configuredUrl: "/sign-in", redirectUrl: "/dashboard" }),
    ).toBe("/sign-in?redirect_url=%2Fdashboard");
    expect(resolveComponentUrl({ component: "sign-in", sdkUrl: "/sdk-sign-in", redirectUrl: "/x" })).toBe("/sdk-sign-in");
  });
});

describe("error mapping", () => {
  it("maps API errors to form fields and a global message", () => {
    const error = {
      errors: [
        { code: "form_param_value_invalid", message: "bad", meta: { param_name: "email_address" } },
        { code: "form_password_incorrect", message: "wrong" },
        { code: "rate_limit_exceeded", message: "slow down" },
      ],
    };

    const { fieldErrors, globalError } = mapFieldErrors(error);
    expect(fieldErrors.emailAddress?.message).toBe("bad");
    expect(fieldErrors.password?.type).toBe("server");
    expect(globalError).toBe("slow down");

    const setFieldErrors = vi.fn();
    const setGlobalError = vi.fn();
    handleOrbitError(error, setFieldErrors, { setGlobalError });
    expect(setFieldErrors).toHaveBeenCalledWith(expect.objectContaining({ emailAddress: expect.any(Object) }));
    expect(setGlobalError).toHaveBeenCalledWith("slow down");
  });

  it("localizes known codes and detects reverification", () => {
    const error = { errors: [{ code: "form_identifier_not_found", message: "Nope" }] };
    expect(getErrorMessage(error, t)).toBe("Couldn't find your account.");
    expect(getErrorMessage(error)).toBe("Nope");
    expect(getErrorMessage(new Error("plain"), t)).toBe("plain");
    expect(getErrorMessage(null, t)).toBe("Something went wrong. Please try again.");

    expect(isReverificationError({ errors: [{ code: "session_reverification_required", message: "x" }] })).toBe(true);
    expect(isReverificationError(new Error("x"))).toBe(false);
    expect(mapFieldErrors(error, t).fieldErrors.identifier?.message).toBe("Couldn't find your account.");
  });
});

describe("misc lib helpers", () => {
  it("decodes JWT payloads without verifying", () => {
    expect(decodeJwt(makeJwt({ sub: "user_1", n: 1 }))).toMatchObject({ sub: "user_1", n: 1 });
    expect(decodeJwt("not-a-jwt")).toBeNull();
    expect(decodeJwt(undefined)).toBeNull();
  });

  it("adds camelCase aliases to publicUserData", () => {
    const session = { publicUserData: { user_id: "user_1", first_name: "Ada", image_url: "i.png", has_image: true } };
    withPublicUserDataAliases(session);
    expect(session.publicUserData).toMatchObject({ userId: "user_1", firstName: "Ada", imageUrl: "i.png", hasImage: true });
  });

  it("counts down resend timers", () => {
    vi.useFakeTimers();
    try {
      const { result } = renderHook(() => useCountdown(3, { autoStart: true }));
      expect(result.current.remaining).toBe(3);
      act(() => {
        vi.advanceTimersByTime(1000);
      });
      expect(result.current.remaining).toBe(2);
      act(() => {
        vi.advanceTimersByTime(3000);
      });
      expect(result.current.remaining).toBe(0);
      expect(result.current.isComplete).toBe(true);

      act(() => result.current.start(2));
      expect(result.current.remaining).toBe(2);
      act(() => result.current.stop());
      expect(result.current.isRunning).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
