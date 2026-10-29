import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrbitID } from "../orbit";
import { ApiMock, clearCookies, clientJSON, cookieValue, environmentJSON, fakeJwt, publishableKey, sessionJSON } from "./helpers";

/**
 * The middleware handshake relies on both cookies after sign-in: `__client_uat` > 0 marks a live
 * client, `__session` carries the JWT. A failed token fetch must not leave the browser looking signed
 * out, or a hard navigation would land on the sign-in page.
 */
describe("auth cookie consistency", () => {
  beforeEach(() => clearCookies());
  afterEach(() => clearCookies());

  it("writes __session and __client_uat when a signed-in session is activated", async () => {
    const token = fakeJwt({ sid: "sess_1" });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        const client = clientJSON({ sessions: [sessionJSON()], last_active_session_id: "sess_1" });
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") return { body: { jwt: token } };
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();

    expect(cookieValue("__session")).toBe(token);
    const uat = Number(cookieValue("__client_uat"));
    expect(uat).toBeGreaterThan(0);
    // Seconds, not milliseconds: the middleware compares it with `> 0` and nothing else.
    expect(uat).toBeLessThan(10_000_000_000);
    expect(orbit.isSignedIn).toBe(true);
    orbit.dispose();
  });

  it("still writes __client_uat when the token request fails, so a handshake can recover", async () => {
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        const client = clientJSON({ sessions: [sessionJSON()], last_active_session_id: "sess_1" });
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") {
        return { status: 500, body: { errors: [{ code: "internal_server_error", message: "boom" }] } };
      }
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();

    expect(cookieValue("__session")).toBeNull();
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);
    expect(orbit.isSignedIn).toBe(true);
    orbit.dispose();
  });

  it("reads both cookies back on a second load (SSR handoff)", async () => {
    const token = fakeJwt({ sid: "sess_1" });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        const client = clientJSON({ sessions: [sessionJSON()], last_active_session_id: "sess_1" });
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") return { body: { jwt: token } };
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const cookieBefore = cookieValue("__session");
    await orbit.refreshClient();
    expect(cookieValue("__session")).toBe(cookieBefore);
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);
    orbit.dispose();
  });

  it("does not bring a signed-out session back when a refresh lands late", async () => {
    let release: (() => void) | null = null;
    let hold = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let signedOut = false;
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        const client = clientJSON({ sessions: signedOut ? [] : [sessionJSON()], last_active_session_id: signedOut ? null : "sess_1" });
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") return { body: { jwt: fakeJwt({ sid: "sess_1" }) } };
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/remove") {
        signedOut = true;
        return { body: { response: clientJSON({ sessions: [] }), client: clientJSON({ sessions: [] }) } };
      }
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
    });
    // Hold only the refresh's token request so it can land after sign-out.
    const fetchWithGate = async (input: string, init?: RequestInit) => {
      if (hold && input.includes("/tokens")) await gate;
      return api.fetch(input, init);
    };
    const orbit = new OrbitID(publishableKey, { fetch: fetchWithGate });
    await orbit.load();
    expect(cookieValue("__session")).toBeTruthy();

    hold = true;
    const refresh = (orbit as unknown as { refreshSessionToken(): Promise<void> }).refreshSessionToken();
    hold = false;
    await orbit.signOut();
    expect(cookieValue("__session") ?? "").toBe("");
    expect(Number(cookieValue("__client_uat") ?? 0)).toBe(0);

    release!();
    await refresh;
    expect(cookieValue("__session") ?? "").toBe("");
    expect(Number(cookieValue("__client_uat") ?? 0)).toBe(0);
    orbit.dispose();
  });
});
