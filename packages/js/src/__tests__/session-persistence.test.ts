import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { COOKIE_MAX_AGE_SECONDS } from "@orbitid/shared";
import { OrbitID } from "../orbit";
import { setSessionCookie } from "../util/cookies";
import { ApiMock, clearCookies, clientJSON, cookieValue, environmentJSON, fakeJwt, publishableKey, sessionJSON, userJSON } from "./helpers";

/**
 * A session must survive everything except an explicit sign-out, revocation or ban. These tests pin the
 * refresh scheduler's tolerance: transient failures, offline periods, a suspended laptop and several tabs
 * racing must never clear cookies or local state. Only an authoritative 401/403 that the client endpoint
 * confirms may sign the user out.
 */
function tokenRoute(api: ApiMock, path = "/v1/client/sessions/sess_1/tokens") {
  return api.countCalls("POST", path);
}

function signedInApi(overrides: { tokens?: () => Promise<unknown> | unknown; client?: () => unknown } = {}) {
  let latest = fakeJwt({ sid: "sess_1" });
  const api = new ApiMock(async (call) => {
    if (call.method === "GET" && call.path === "/v1/client") {
      const body = overrides.client ? overrides.client() : { sessions: [sessionJSON()], last_active_session_id: "sess_1" };
      const client = clientJSON(body as Parameters<typeof clientJSON>[0]);
      return { body: { response: client, client } };
    }
    if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
    if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") {
      if (overrides.tokens) {
        const result = await overrides.tokens();
        if (result instanceof Error) throw result;
        return result as { status?: number; body: unknown };
      }
      latest = fakeJwt({ sid: "sess_1", nonce: Math.random() });
      return { body: { jwt: latest } };
    }
    return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
  });
  return api;
}

describe("session persistence across refresh failures", () => {
  beforeEach(() => {
    clearCookies();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearCookies();
    localStorage.clear();
  });

  it("treats a 5xx as transient, keeps the user signed in and retries with backoff", async () => {
    vi.useFakeTimers();
    let fail = false;
    const api = signedInApi({
      tokens: () =>
        fail
          ? { status: 503, body: { errors: [{ code: "internal_server_error", message: "deploying" }] } }
          : { body: { jwt: fakeJwt({ sid: "sess_1", nonce: "recovered" }) } },
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const before = cookieValue("__session");
    expect(before).toBeTruthy();
    expect(tokenRoute(api)).toBe(1);

    fail = true;
    await vi.advanceTimersByTimeAsync(51_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(tokenRoute(api)).toBe(2);
    // Failed refresh: no sign-out, cookies untouched, still signed in.
    expect(orbit.isSignedIn).toBe(true);
    expect(cookieValue("__session")).toBe(before);

    // First backoff is 5 s, then 10 s; the request happens each time but nothing is cleared.
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(tokenRoute(api)).toBe(3);
    await vi.advanceTimersByTimeAsync(10_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(tokenRoute(api)).toBe(4);
    expect(orbit.isSignedIn).toBe(true);
    expect(cookieValue("__session")).toBe(before);

    // The instance comes back: the next retry succeeds and the cookie is rewritten.
    fail = false;
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(tokenRoute(api)).toBe(5);
    expect(cookieValue("__session")).not.toBe(before);
    expect(orbit.isSignedIn).toBe(true);
    orbit.dispose();
  });

  it("recovers from an offline period when the browser reports it is back online", async () => {
    vi.useFakeTimers();
    let online = true;
    const api = signedInApi({
      tokens: () => {
        if (!online) throw new TypeError("Failed to fetch");
        return { body: { jwt: fakeJwt({ sid: "sess_1", nonce: "online" }) } };
      },
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const offlineCookie = cookieValue("__session");

    online = false;
    await vi.advanceTimersByTimeAsync(55_000);
    await vi.advanceTimersByTimeAsync(10);
    const afterFailure = tokenRoute(api);
    expect(afterFailure).toBeGreaterThan(1);
    expect(orbit.isSignedIn).toBe(true);
    expect(cookieValue("__session")).toBe(offlineCookie);

    // No timer wait: coming back online refreshes immediately.
    online = true;
    window.dispatchEvent(new Event("online"));
    await vi.advanceTimersByTimeAsync(10);
    expect(tokenRoute(api)).toBe(afterFailure + 1);
    expect(cookieValue("__session")).not.toBe(offlineCookie);
    expect(orbit.isSignedIn).toBe(true);
    orbit.dispose();
  });

  it("refreshes after a suspend/resume gap instead of waiting for the throttled timer", async () => {
    vi.useFakeTimers();
    const api = signedInApi();
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const before = cookieValue("__session");
    const callsBefore = tokenRoute(api);

    // A closed laptop: the wall clock jumps six hours but no timer ran.
    vi.setSystemTime(Date.now() + 6 * 60 * 60 * 1000);
    expect(tokenRoute(api)).toBe(callsBefore);
    expect(orbit.isSignedIn).toBe(true);

    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(10);
    expect(tokenRoute(api)).toBe(callsBefore + 1);
    expect(cookieValue("__session")).not.toBe(before);
    expect(orbit.isSignedIn).toBe(true);
    orbit.dispose();
  });

  it("uses one cross-tab lock so two tabs do not stampede the token endpoint", async () => {
    vi.useFakeTimers();
    const api = signedInApi();
    const first = new OrbitID(publishableKey, { fetch: api.fetch });
    const second = new OrbitID(publishableKey, { fetch: api.fetch });
    await first.load();
    await second.load();
    // Let the tokens minted on load go stale, with no timer to race the explicit refreshes below.
    first.stopTokenRefresh();
    second.stopTokenRefresh();
    await vi.advanceTimersByTimeAsync(51_000);
    const before = tokenRoute(api);

    const firstRefresh = (first as unknown as { refreshSessionToken(): Promise<void> }).refreshSessionToken();
    const secondRefresh = (second as unknown as { refreshSessionToken(): Promise<void> }).refreshSessionToken();
    await Promise.all([firstRefresh, secondRefresh]);
    // One tab acquired the lock synchronously; the other deferred instead of minting a second token.
    expect(tokenRoute(api)).toBe(before + 1);
    expect(first.isSignedIn).toBe(true);
    expect(second.isSignedIn).toBe(true);
    first.dispose();
    second.dispose();
  });

  it("signs out only when a 401 is confirmed by the client endpoint", async () => {
    vi.useFakeTimers();
    let revoked = false;
    const api = signedInApi({
      tokens: () =>
        revoked
          ? { status: 401, body: { errors: [{ code: "authentication_invalid", message: "This session is no longer active" }] } }
          : { body: { jwt: fakeJwt({ sid: "sess_1" }) } },
      client: () => (revoked ? { sessions: [], last_active_session_id: null } : { sessions: [sessionJSON()], last_active_session_id: "sess_1" }),
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    expect(orbit.isSignedIn).toBe(true);

    revoked = true;
    await vi.advanceTimersByTimeAsync(55_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(orbit.isSignedIn).toBe(false);
    expect(cookieValue("__session") ?? "").toBe("");
    expect(Number(cookieValue("__client_uat") ?? 0)).toBe(0);
    orbit.dispose();
  });

  it("does not sign out on a 401 that the client endpoint contradicts", async () => {
    vi.useFakeTimers();
    const api = signedInApi({
      tokens: () => ({ status: 401, body: { errors: [{ code: "authentication_invalid", message: "upstream proxy" }] } }),
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const before = cookieValue("__session");

    await vi.advanceTimersByTimeAsync(55_000);
    await vi.advanceTimersByTimeAsync(10);
    // The client endpoint still reports the session as active: this was not a real revocation.
    expect(orbit.isSignedIn).toBe(true);
    expect(cookieValue("__session")).toBe(before);
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);
    orbit.dispose();
  });

  it("keeps this tab on its own session when another tab activates a second account", async () => {
    let lastActive = "sess_a";
    const sessions = [
      sessionJSON({ id: "sess_a", user: userJSON({ id: "user_a" }) }),
      sessionJSON({ id: "sess_b", user: userJSON({ id: "user_b" }) }),
    ];
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        const client = clientJSON({ sessions, last_active_session_id: lastActive });
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path.endsWith("/tokens")) {
        const id = call.path.split("/")[4]!;
        return { body: { jwt: fakeJwt({ sid: id }) } };
      }
      if (call.method === "POST" && call.path.endsWith("/touch")) {
        const id = call.path.split("/")[4]!;
        return { body: { response: sessionJSON({ id }) } };
      }
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    expect(orbit.session?.id).toBe("sess_a");

    // Another tab signed into a second account; the server's pointer moved, but this tab must not switch users.
    lastActive = "sess_b";
    await orbit.refreshClient();
    expect(orbit.session?.id).toBe("sess_a");

    // An explicit switch still works.
    await orbit.setActive({ session: "sess_b" });
    expect(orbit.session?.id).toBe("sess_b");
    orbit.dispose();
  });

  it("keeps long-lived cookies instead of session cookies", () => {
    const written: string[] = [];
    vi.stubGlobal("document", {
      get cookie() {
        return "";
      },
      set cookie(value: string) {
        written.push(value);
      },
    });
    try {
      setSessionCookie("jwt-value");
      expect(written[0]).toContain(`Max-Age=${COOKIE_MAX_AGE_SECONDS}`);
      expect(written[0]).toContain("Path=/");
      expect(written[0]).toContain("SameSite=Lax");
      // jsdom's URL is https, so the SDK adds Secure.
      expect(written[0]).toContain("Secure");
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
