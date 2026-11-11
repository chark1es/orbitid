import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitID } from "../orbit";
import { setClientUatCookie, setSessionCookie } from "../util/cookies";
import { decodeJwtPayload } from "../util/jwt";
import {
  ApiMock, clearCookies, clientJSON, cookieValue, environmentJSON, fakeJwt, publishableKey, sessionJSON,
} from "./helpers";

/**
 * A pending-MFA session is live: the Next.js middleware handshake writes its `sts: "pending"` token and a live
 * `__client_uat`, and the SDK must keep and refresh both. It used to clear them on `load()` because only `active`
 * counted, which undid the server handshake fix and dropped the visitor out of enrolment.
 */
function pendingApi(overrides: { token?: () => { status?: number; body: unknown } } = {}) {
  let minted = fakeJwt({ sid: "sess_pending", sts: "pending", nonce: "minted" });
  const api = new ApiMock((call) => {
    if (call.method === "GET" && call.path === "/v1/client") {
      const client = clientJSON({ sessions: [sessionJSON({ id: "sess_pending", status: "pending" })], last_active_session_id: "sess_pending" });
      return { body: { response: client, client } };
    }
    if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
    if (call.method === "POST" && call.path === "/v1/client/sessions/sess_pending/tokens") {
      if (overrides.token) return overrides.token();
      minted = fakeJwt({ sid: "sess_pending", sts: "pending", nonce: Math.random() });
      return { body: { jwt: minted } };
    }
    return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
  });
  return { api, minted: () => minted };
}

/** The cookies the Next.js handshake return leaves behind. */
function handshakeCookies(): string {
  const token = fakeJwt({ sid: "sess_pending", sts: "pending", nonce: "handshake" });
  setSessionCookie(token);
  setClientUatCookie(Math.floor(Date.now() / 1000));
  return token;
}

describe("pending-MFA sessions keep their auth cookies", () => {
  beforeEach(() => {
    clearCookies();
    localStorage.clear();
  });
  afterEach(() => {
    vi.useRealTimers();
    clearCookies();
    localStorage.clear();
  });

  it("keeps minting the pending token on the refresh schedule", async () => {
    vi.useFakeTimers();
    const handshakeToken = handshakeCookies();
    const { api } = pendingApi();
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    const tokenCalls = () => api.countCalls("POST", "/v1/client/sessions/sess_pending/tokens");

    await orbit.load();
    const first = cookieValue("__session");
    expect(first).not.toBe(handshakeToken);
    expect(tokenCalls()).toBe(1);

    // The pending token lives ~60 s; the loop must renew it like an active session's, so a long enrolment does not
    // leave the browser with only `__client_uat` and force a handshake on the next server render.
    await vi.advanceTimersByTimeAsync(51_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(tokenCalls()).toBe(2);
    const refreshed = cookieValue("__session");
    expect(refreshed).not.toBe(first);
    expect(decodeJwtPayload(refreshed!)?.sts).toBe("pending");
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);
    expect(orbit.session?.status).toBe("pending");
    orbit.dispose();
  });

  it("mints the pending token on load and keeps the handshake cookies for the next navigation", async () => {
    const handshakeToken = handshakeCookies();
    const { api, minted } = pendingApi();
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });

    await orbit.load();

    expect(orbit.session?.id).toBe("sess_pending");
    expect(orbit.session?.status).toBe("pending");
    // Still not signed in for authorization purposes, but the browser is not signed out either.
    expect(orbit.isSignedIn).toBe(false);
    expect(api.countCalls("POST", "/v1/client/sessions/sess_pending/tokens")).toBe(1);

    const cookie = cookieValue("__session");
    expect(cookie).toBeTruthy();
    expect(cookie).not.toBe(handshakeToken);
    expect(decodeJwtPayload(cookie!)?.sts).toBe("pending");
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);
    const refreshed = minted();
    expect(cookie).toBe(refreshed);

    // The next hard navigation carries the same pending token and live `__client_uat`: no sign-out, no re-handshake.
    orbit.dispose();
    expect(cookieValue("__session")).toBe(refreshed);
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);
  });

  it("keeps the handshake cookies when the pending token mint fails transiently", async () => {
    const handshakeToken = handshakeCookies();
    const { api } = pendingApi({ token: () => ({ status: 503, body: { errors: [{ code: "internal_server_error", message: "deploying" }] } }) });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });

    await orbit.load();

    expect(orbit.session?.status).toBe("pending");
    expect(orbit.isSignedIn).toBe(false);
    // Nothing was deleted or zeroed: a pending session is never treated like a signed-out browser.
    expect(cookieValue("__session")).toBe(handshakeToken);
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);
    orbit.dispose();
  });

  it("does not sign a pending session out on a 401 that the client endpoint contradicts", async () => {
    const handshakeToken = handshakeCookies();
    const { api } = pendingApi({ token: () => ({ status: 401, body: { errors: [{ code: "authentication_invalid", message: "upstream proxy" }] } }) });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });

    await orbit.load();

    // The confirmation still reports the pending session: a stray 401 is not an authoritative end.
    expect(orbit.session?.status).toBe("pending");
    expect(cookieValue("__session")).toBe(handshakeToken);
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);
    // The confirmation call happened, so this exercised the reconcile path rather than skipping it.
    expect(api.countCalls("GET", "/v1/client")).toBe(2);
    orbit.dispose();
  });
});
