import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitID } from "../orbit";
import { FapiClient } from "../fapi";
import { TokenCache } from "../token-cache";
import { Session } from "../resources/session";
import { ApiMock, API_URL, clearCookies, clientJSON, cookieValue, environmentJSON, fakeJwt, publishableKey, sessionJSON } from "./helpers";

describe("TokenCache", () => {
  it("caches per session+template and dedupes concurrent fetches", async () => {
    let now = 1_700_000_000_000;
    let fetches = 0;
    const cache = new TokenCache({ now: () => now });
    const fetchToken = async () => {
      fetches += 1;
      return fakeJwt({}, { now, lifetimeSeconds: 60 });
    };

    const [first, second] = await Promise.all([
      cache.getToken("sess_1", null, fetchToken),
      cache.getToken("sess_1", null, fetchToken),
    ]);
    expect(first).toBe(second);
    expect(fetches).toBe(1);
    expect(cache.isFresh("sess_1", null)).toBe(true);

    await cache.getToken("sess_1", "custom", fetchToken);
    expect(fetches).toBe(2);

    const cached = await cache.getToken("sess_1", null, fetchToken);
    expect(cached).toBe(first);
    expect(fetches).toBe(2);

    // Within the 10 s refresh leeway → refetch.
    now += 55_000;
    expect(cache.isFresh("sess_1", null)).toBe(false);
    await cache.getToken("sess_1", null, fetchToken);
    expect(fetches).toBe(3);

    cache.removeSession("sess_1");
    expect(cache.get("sess_1", null)).toBeUndefined();
    expect(cache.get("sess_1", "custom")).toBeUndefined();
  });

  it("compensates server clock skew using iat/exp", async () => {
    const localNow = 1_700_000_100_000; // local clock 100 s ahead of the server
    const serverNow = Math.floor(1_700_000_000_000 / 1000);
    const cache = new TokenCache({ now: () => localNow });
    const token = fakeJwt({}, { now: 1_700_000_000_000, lifetimeSeconds: 60 });
    cache.set("sess_1", null, token);
    const entry = cache.get("sess_1", null);
    expect(entry?.expiresAt).toBe((serverNow + 60) * 1000 + 100_000);
    expect(cache.isFresh("sess_1", null)).toBe(true);
  });

  it("fetches a fresh token when skipCache is set", async () => {
    const api = new ApiMock((call) => {
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") return { body: { jwt: fakeJwt({ iat: Math.floor(Date.now() / 1000) }) } };
      return { status: 404, body: {} };
    });
    const fapi = new FapiClient({ publishableKey, fetch: api.fetch, frontendApi: API_URL });
    const session = Session.fromJSON(fapi, sessionJSON(), new TokenCache());
    await session.getToken();
    await session.getToken();
    expect(api.countCalls("POST", "/v1/client/sessions/sess_1/tokens")).toBe(1);
    await session.getToken({ skipCache: true });
    expect(api.countCalls("POST", "/v1/client/sessions/sess_1/tokens")).toBe(2);
  });
});

describe("token refresh + cookies", () => {
  beforeEach(() => clearCookies());
  afterEach(() => {
    clearCookies();
    vi.useRealTimers();
  });

  it("refreshes the active session token just before it expires and updates cookies", async () => {
    vi.useFakeTimers();
    let tokenCounter = 0;
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        const client = clientJSON({ sessions: [sessionJSON()], last_active_session_id: "sess_1" });
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") {
        tokenCounter += 1;
        const nowSeconds = Math.floor(Date.now() / 1000);
        return { body: { jwt: fakeJwt({ iat: nowSeconds - tokenCounter, sid: "sess_1", nonce: tokenCounter }) } };
      }
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const initial = cookieValue("__session");
    expect(initial).not.toBeNull();
    expect(api.countCalls("POST", "/v1/client/sessions/sess_1/tokens")).toBe(1);

    // The deadline comes from the token's own `exp` minus its leeway, not a fixed interval: it is ~50 s but may
    // be a fraction later because `iat` has whole-second precision. 45 s must not refresh; 10 s more must.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(api.countCalls("POST", "/v1/client/sessions/sess_1/tokens")).toBe(1);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.countCalls("POST", "/v1/client/sessions/sess_1/tokens")).toBe(2);
    expect(cookieValue("__session")).not.toBe(initial);

    await vi.advanceTimersByTimeAsync(55_000);
    expect(api.countCalls("POST", "/v1/client/sessions/sess_1/tokens")).toBe(3);
    orbit.dispose();
  });

  it("stops refreshing after dispose", async () => {
    vi.useFakeTimers();
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        const client = clientJSON({ sessions: [sessionJSON()], last_active_session_id: "sess_1" });
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.path === "/v1/client/sessions/sess_1/tokens") return { body: { jwt: fakeJwt({ iat: Math.floor(Date.now() / 1000) }) } };
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const before = api.calls.length;
    orbit.dispose();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(api.calls.length).toBe(before);
  });
});
