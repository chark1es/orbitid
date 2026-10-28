import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitID, type OrbitIDState } from "../orbit";
import {
  ApiMock,
  clearCookies,
  clientJSON,
  cookieValue,
  environmentJSON,
  fakeJwt,
  organizationJSON,
  publishableKey,
  sessionJSON,
  userJSON,
} from "./helpers";

describe("setActive / organization switching / signOut", () => {
  beforeEach(() => clearCookies());
  afterEach(() => clearCookies());

  function setup() {
    let client = clientJSON({
      sessions: [
        sessionJSON({ id: "sess_1", user: userJSON(), last_active_organization_id: "org_1" }),
        sessionJSON({ id: "sess_2", user: userJSON(), last_active_organization_id: null }),
      ],
      last_active_session_id: "sess_1",
    });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") return { body: { response: client, client } };
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "GET" && call.path === "/v1/client/organizations/org_1") return { body: { response: organizationJSON({ id: "org_1", name: "Alpha", slug: "alpha" }) } };
      if (call.method === "GET" && call.path === "/v1/client/organizations/org_2") return { body: { response: organizationJSON({ id: "org_2", name: "Beta", slug: "beta" }) } };
      if (call.method === "POST" && call.path.startsWith("/v1/client/sessions/") && call.path.endsWith("/tokens")) {
        const id = call.path.split("/")[4] ?? "sess_1";
        return { body: { jwt: fakeJwt({ sid: id }) } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_2/touch") {
        const orgId = (call.body?.active_organization_id as string | null | undefined) ?? null;
        client = clientJSON({
          sessions: [
            sessionJSON({ id: "sess_1", last_active_organization_id: "org_1" }),
            sessionJSON({ id: "sess_2", last_active_organization_id: orgId }),
          ],
          last_active_session_id: "sess_2",
        });
        const session = client.sessions.find((candidate) => candidate.id === "sess_2")!;
        return { body: { response: session, client } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/remove") {
        client = clientJSON();
        return { body: { response: sessionJSON({ id: "sess_1", status: "ended" }), client } };
      }
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
    });
    return { api, orbitClient: () => client };
  }

  it("switches the active session and organization, notifying listeners with fresh state", async () => {
    const { api } = setup();
    const beforeEmit = vi.fn<(state: OrbitIDState) => void>();
    const states: OrbitIDState[] = [];
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    orbit.addListener((state) => states.push(state));
    await orbit.load();
    expect(orbit.session?.id).toBe("sess_1");
    expect(orbit.organization?.id).toBe("org_1");

    const previousSession = orbit.session;
    await orbit.setActive({ session: "sess_2", organization: "org_2", beforeEmit });

    expect(api.lastCall("POST", "/v1/client/sessions/sess_2/touch")?.body).toEqual({ active_organization_id: "org_2" });
    expect(orbit.session?.id).toBe("sess_2");
    expect(orbit.session).not.toBe(previousSession);
    expect(orbit.organization?.id).toBe("org_2");
    expect(orbit.organization?.name).toBe("Beta");
    expect(beforeEmit).toHaveBeenCalledTimes(1);
    const emitted = beforeEmit.mock.calls[0]?.[0];
    expect(emitted?.organization?.id).toBe("org_2");
    const last = states.at(-1);
    expect(last?.session?.id).toBe("sess_2");
    expect(last?.organization?.id).toBe("org_2");
    expect(cookieValue("__session")).not.toBeNull();
    orbit.dispose();
  });

  it("signs out, clears cookies and follows afterSignOutUrl", async () => {
    const { api, orbitClient } = setup();
    const push = vi.fn<(url: string) => void>();
    const replace = vi.fn<(url: string) => void>();
    const orbit = new OrbitID(publishableKey, {
      fetch: api.fetch,
      navigate: { push, replace },
      afterSignOutUrl: "/goodbye",
    });
    await orbit.load();
    expect(cookieValue("__session")).not.toBeNull();

    await orbit.signOut();

    expect(api.lastCall("POST", "/v1/client/sessions/sess_1/remove")).toBeDefined();
    expect(orbitClient().sessions).toHaveLength(0);
    expect(orbit.isSignedIn).toBe(false);
    expect(orbit.user).toBeNull();
    expect(cookieValue("__session")).toBeNull();
    expect(cookieValue("__client_uat")).toBe("0");
    expect(replace).toHaveBeenCalledWith("/goodbye");
    orbit.dispose();
  });

  it("signs out of every session when no session id is provided", async () => {
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        const client = clientJSON();
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "DELETE" && call.path === "/v1/client") return { body: { response: { object: "client", id: "client_1" } } };
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    await orbit.signOut();
    expect(api.countCalls("DELETE", "/v1/client")).toBe(1);
    orbit.dispose();
  });

  it("handleRedirectCallback activates a completed sign-in and redirects", async () => {
    const replace = vi.fn<(url: string) => void>();
    let client = clientJSON({
      sign_in: {
        object: "sign_in",
        id: "sia_1",
        status: "complete",
        supported_identifiers: ["email_address"],
        supported_first_factors: null,
        supported_second_factors: null,
        first_factor_verification: { status: "verified", strategy: "oauth_google", attempts: null, expire_at: null },
        second_factor_verification: null,
        identifier: "ada@example.com",
        user_data: null,
        created_session_id: "sess_9",
        abandon_at: Date.now() + 1000,
      },
      sessions: [sessionJSON({ id: "sess_9" })],
      last_active_session_id: null,
    });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") return { body: { response: client, client } };
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_9/touch") {
        client = clientJSON({ sessions: [sessionJSON({ id: "sess_9" })], last_active_session_id: "sess_9" });
        return { body: { response: sessionJSON({ id: "sess_9" }), client } };
      }
      if (call.path === "/v1/client/sessions/sess_9/tokens") return { body: { jwt: fakeJwt({ sid: "sess_9" }) } };
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch, navigate: { replace }, afterSignInUrl: "/dashboard" });
    await orbit.load();
    await orbit.handleRedirectCallback();
    expect(orbit.isSignedIn).toBe(true);
    expect(replace).toHaveBeenCalledWith("/dashboard");
    orbit.dispose();
  });

  it("handleRedirectCallback transfers transferable OAuth sign-ins into sign-up", async () => {
    const push = vi.fn<(url: string) => void>();
    const client = clientJSON({
      sign_in: {
        object: "sign_in",
        id: "sia_1",
        status: "needs_first_factor",
        supported_identifiers: [],
        supported_first_factors: null,
        supported_second_factors: null,
        first_factor_verification: { status: "transferable", strategy: "oauth_google", attempts: null, expire_at: null },
        second_factor_verification: null,
        identifier: null,
        user_data: null,
        created_session_id: null,
        abandon_at: Date.now() + 1000,
      },
    });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") return { body: { response: client, client } };
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sign_ups") return { body: { response: client.sign_in && { object: "sign_up", id: "sua_1" } } };
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch, navigate: { push }, signUpUrl: "/sign-up" });
    await orbit.load();
    const result = await orbit.handleRedirectCallback();
    expect(api.lastCall("POST", "/v1/client/sign_ups")?.body?.transfer).toBe(true);
    expect(result.signUp?.id).toBe("sua_1");
    expect(push).toHaveBeenCalledWith("/sign-up");
    orbit.dispose();
  });

  it("handleRedirectCallback routes second-factor attempts back to sign-in", async () => {
    const push = vi.fn<(url: string) => void>();
    const client = clientJSON({
      sign_in: {
        object: "sign_in",
        id: "sia_1",
        status: "needs_second_factor",
        supported_identifiers: ["email_address"],
        supported_first_factors: null,
        supported_second_factors: [{ strategy: "totp" }],
        first_factor_verification: { status: "verified", strategy: "password", attempts: null, expire_at: null },
        second_factor_verification: null,
        identifier: "ada@example.com",
        user_data: null,
        created_session_id: null,
        abandon_at: Date.now() + 1000,
      },
    });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") return { body: { response: client, client } };
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch, navigate: { push }, signInUrl: "/sign-in" });
    await orbit.load();
    await orbit.handleRedirectCallback({ signInForceRedirectUrl: "/after" });
    expect(push).toHaveBeenCalledWith("/sign-in?redirect_url=%2Fafter");
    orbit.dispose();
  });

  it("builds sign-in/sign-up URLs with redirect_url", () => {
    const orbit = new OrbitID(publishableKey, { fetch: vi.fn(), afterSignInUrl: "/home", afterSignUpUrl: "/home" });
    expect(orbit.buildSignInUrl({ redirectUrl: "/settings" })).toBe("/sign-in?redirect_url=%2Fsettings");
    expect(orbit.buildSignUpUrl()).toBe("/sign-up?redirect_url=%2Fhome");
    expect(orbit.buildUserProfileUrl({ redirectUrl: "/" })).toBe("/user?redirect_url=%2F");
    orbit.dispose();
  });
});
