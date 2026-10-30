import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitID } from "../orbit";
import { FapiClient } from "../fapi";
import { Session } from "../resources/session";
import { TokenCache } from "../token-cache";
import { CrossTabSync } from "../cross-tab-sync";
import { createHasCheck } from "../util/reverification";
import { getSafeRedirectUrl, isSafeRedirectUrl, validateRedirectUrl } from "../util/url";
import {
  ApiMock,
  API_URL,
  clearCookies,
  clientJSON,
  cookieValue,
  environmentJSON,
  fakeJwt,
  publishableKey,
  sessionJSON,
} from "./helpers";

const ORIGIN = "https://app.example.com";

describe("redirect validation resolves before it judges", () => {
  it("refuses paths the browser would turn into another origin", () => {
    // `\` is read as `/` and tabs are dropped, so these all leave the app.
    for (const url of ["/\\evil.test/x", "/\t/evil.test", "\\\\evil.test", "/\\/evil.test", " /\t/evil.test"]) {
      expect(isSafeRedirectUrl(url, { origin: ORIGIN })).toBe(false);
      expect(validateRedirectUrl(url, { origin: ORIGIN })).toBeNull();
      expect(getSafeRedirectUrl(url, "/fallback", { origin: ORIGIN })).toBe("/fallback");
    }
  });

  it("refuses control characters, credentials and non-http schemes", () => {
    for (const url of ["/\u0000x", "/\u001fx", "https://user:pass@app.example.com/x", "javascript:alert(1)", "data:text/html,x"]) {
      expect(isSafeRedirectUrl(url, { origin: ORIGIN })).toBe(false);
    }
  });

  it("still accepts normal same-origin and allow-listed targets", () => {
    expect(isSafeRedirectUrl("/dashboard?tab=1#x", { origin: ORIGIN })).toBe(true);
    expect(isSafeRedirectUrl(`${ORIGIN}/dashboard`, { origin: ORIGIN })).toBe(true);
    expect(isSafeRedirectUrl("https://other.example.com/x", { origin: ORIGIN, allowedOrigins: ["https://other.example.com"] })).toBe(true);
    expect(getSafeRedirectUrl(`${ORIGIN}/a?b=1#c`, "/", { origin: ORIGIN })).toBe("/a?b=1#c");
    expect(getSafeRedirectUrl("//evil.test/a", "/fallback", { origin: ORIGIN })).toBe("/fallback");
  });
});

describe("authorization checks do not broaden a grant", () => {
  it("does not let a requested wildcard be satisfied by a narrower permission", () => {
    const has = createHasCheck({ orgPermissions: ["org:team:read"] });
    expect(has({ permission: "org:team:read" })).toBe(true);
    expect(has({ permission: "org:team:*" })).toBe(false);
    // A wildcard *grant* still covers a concrete request.
    expect(createHasCheck({ orgPermissions: ["org:team:*"] })({ permission: "org:team:write" })).toBe(true);
  });

  it("answers an empty check with false instead of a blanket grant", () => {
    const has = createHasCheck({ orgRole: "org:admin", orgPermissions: ["org:sys_memberships:manage"], fva: [0, 0] });
    expect(has({})).toBe(false);
  });

  it("matches an operator-assigned instance role and its permissions", () => {
    const has = createHasCheck({ roles: ["app:support"], rolePermissions: ["app:tickets:read"] });
    expect(has({ role: "app:support" })).toBe(true);
    expect(has({ permission: "app:tickets:read" })).toBe(true);
    // Instance permissions do not leak into the organization `feature` namespace.
    expect(has({ feature: "tickets", permission: "read" })).toBe(false);
    // An organization role is still matched alongside them.
    expect(createHasCheck({ roles: ["app:support"], orgRole: "org:admin" })({ role: "org:admin" })).toBe(true);
  });
});

describe("Session.has() only trusts a token for this session", () => {
  function sessionWith(token: string | null, overrides: Parameters<typeof sessionJSON>[0] = {}) {
    const fapi = new ApiMock(() => ({ status: 404, body: {} }));
    return Session.fromJSON(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { get: vi.fn(), post: vi.fn() } as never,
      sessionJSON({ last_active_token: token ? { object: "token", jwt: token } : null, ...overrides }),
      new TokenCache(),
    );
  }

  it("evaluates role and permission claims from the session token", () => {
    const token = fakeJwt({ sid: "sess_1", org_role: "org:admin", org_permissions: ["org:sys_memberships:manage"] });
    const session = sessionWith(token);
    expect(session.has({ role: "org:admin" })).toBe(true);
    expect(session.has({ permission: "org:sys_memberships:manage" })).toBe(true);
  });

  it("refuses claims from a token minted for a different session", () => {
    const foreign = fakeJwt({ sid: "sess_other", org_role: "org:admin", org_permissions: ["org:sys_memberships:manage"] });
    expect(sessionWith(foreign).has({ permission: "org:sys_memberships:manage" })).toBe(false);
  });

  it("refuses a pending or ended session even when its token carries admin claims", () => {
    const token = fakeJwt({ sid: "sess_1", org_role: "org:admin", org_permissions: ["org:sys_memberships:manage"] });
    expect(sessionWith(token, { status: "pending" }).has({ role: "org:admin" })).toBe(false);
    expect(sessionWith(token, { status: "ended" }).has({ role: "org:admin" })).toBe(false);
  });

  it("refuses an expired session", () => {
    const token = fakeJwt({ sid: "sess_1", org_role: "org:admin" });
    expect(sessionWith(token, { expire_at: Date.now() - 1000 }).has({ role: "org:admin" })).toBe(false);
  });
});

describe("TokenCache lifecycle", () => {
  it("does not repopulate a removed session when an in-flight fetch lands late", async () => {
    let resolve!: (token: string) => void;
    const cache = new TokenCache();
    const pending = cache.getToken("sess_1", null, () => new Promise<string>((r) => (resolve = r)));
    cache.removeSession("sess_1");
    resolve(fakeJwt({ sid: "sess_1" }));
    await pending;
    expect(cache.get("sess_1", null)).toBeUndefined();
  });

  it("does not repopulate after clear()", async () => {
    let resolve!: (token: string) => void;
    const cache = new TokenCache();
    const pending = cache.getToken("sess_1", null, () => new Promise<string>((r) => (resolve = r)));
    cache.clear();
    resolve(fakeJwt({ sid: "sess_1" }));
    await pending;
    expect(cache.get("sess_1", null)).toBeUndefined();
  });

  it("refuses to request a token for a placeholder session", async () => {
    const fapi = new FapiClient({ publishableKey, fetch: vi.fn(), frontendApi: API_URL });
    const session = Session.fromJSON(fapi, sessionJSON({ id: "" }), new TokenCache());
    await expect(session.getToken()).rejects.toThrow(/no id/);
  });

  it("rejects a synced token for another session or one already expired", () => {
    let now = 1_700_000_000_000;
    const cache = new TokenCache({ now: () => now });
    const token = fakeJwt({ sid: "sess_1" }, { now, lifetimeSeconds: 60 });
    expect(cache.setFromSync("sess_2", null, token)).toBe(false);
    expect(cache.get("sess_2", null)).toBeUndefined();
    expect(cache.setFromSync("sess_1", null, token)).toBe(true);
    // Same-origin tabs share a clock; `exp` is authoritative here, not a per-fetch skew estimate.
    now += 120_000;
    expect(cache.setFromSync("sess_1", null, token)).toBe(false);
  });
});

describe("cross-tab sync never persists a token", () => {
  class FakeChannel {
    static instances: FakeChannel[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(readonly name: string) {
      FakeChannel.instances.push(this);
    }
    postMessage(): void {}
    close(): void {}
    emit(message: unknown): void {
      this.onmessage?.({ data: message } as MessageEvent);
    }
  }

  afterEach(() => {
    vi.unstubAllGlobals();
    FakeChannel.instances = [];
  });

  it("does not write a session token into the localStorage fallback", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const setItem = vi.spyOn(Storage.prototype, "setItem");
    const sync = new CrossTabSync(() => undefined);
    sync.broadcast({ type: "token", sessionId: "sess_1", template: null, token: "secret-jwt" });
    expect(setItem).not.toHaveBeenCalled();
    expect(JSON.stringify(Object.fromEntries(Object.entries(localStorage)))).not.toContain("secret-jwt");
    sync.close();
    setItem.mockRestore();
  });

  it("drops malformed messages from storage", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const received: unknown[] = [];
    const sync = new CrossTabSync((message) => received.push(message));
    for (const payload of [
      { type: "token" },
      { type: "token", sessionId: "sess_1" },
      { type: "token", sessionId: "sess_1", token: "" },
      { type: "token", sessionId: "sess_1", token: "jwt", template: 7 },
      { type: "unknown" },
      null,
      "string",
    ]) {
      window.dispatchEvent(Object.assign(new Event("storage"), { key: "__orbitid_sync", newValue: JSON.stringify(payload) }));
    }
    expect(received).toEqual([]);
    sync.close();
  });

  it("delivers valid signals over the storage fallback", () => {
    vi.stubGlobal("BroadcastChannel", undefined);
    const received: unknown[] = [];
    const sync = new CrossTabSync((message) => received.push(message));
    for (const payload of [{ type: "signout" }, { type: "refresh-client" }]) {
      window.dispatchEvent(Object.assign(new Event("storage"), { key: "__orbitid_sync", newValue: JSON.stringify(payload) }));
    }
    expect(received).toEqual([{ type: "signout" }, { type: "refresh-client" }]);
    // A token is never sent through persistent storage, so one arriving there is not adopted.
    window.dispatchEvent(
      Object.assign(new Event("storage"), {
        key: "__orbitid_sync",
        newValue: JSON.stringify({ type: "token", sessionId: "sess_1", template: null, token: "jwt" }),
      }),
    );
    expect(received).toEqual([{ type: "signout" }, { type: "refresh-client" }]);
    sync.close();
  });

  it("drops a template token even over BroadcastChannel", () => {
    vi.stubGlobal("BroadcastChannel", FakeChannel);
    const received: unknown[] = [];
    const sync = new CrossTabSync((message) => received.push(message));
    FakeChannel.instances[0]!.emit({ type: "token", sessionId: "sess_1", template: "external", token: "jwt" });
    expect(received).toEqual([]);
    sync.close();
    FakeChannel.instances = [];
  });

  it("adopts another tab's token for the same session but not a foreign or stale one", async () => {
    let counter = 0;
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        const client = clientJSON({ sessions: [sessionJSON()], last_active_session_id: "sess_1" });
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") {
        counter += 1;
        return { body: { jwt: fakeJwt({ sid: "sess_1", nonce: counter }) } };
      }
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const handle = (orbit as unknown as { handleSyncMessage(message: unknown): void }).handleSyncMessage.bind(orbit);

    const fresh = fakeJwt({ sid: "sess_1", nonce: 99 });
    handle({ type: "token", sessionId: "sess_1", template: null, token: fresh });
    expect(cookieValue("__session")).toBe(fresh);

    // A token minted for another session is ignored.
    handle({ type: "token", sessionId: "sess_other", template: null, token: fakeJwt({ sid: "sess_other" }) });
    expect(cookieValue("__session")).toBe(fresh);

    // A token from the future-past (expired) is ignored.
    handle({ type: "token", sessionId: "sess_1", template: null, token: fakeJwt({ sid: "sess_1" }, { lifetimeSeconds: -60 }) });
    expect(cookieValue("__session")).toBe(fresh);
    orbit.dispose();
  });
});

describe("FapiClient redirects only to http(s)", () => {
  it("ignores a javascript:/data:/protocol-relative redirect URL from the API", () => {
    const navigate = vi.fn();
    const fapi = new FapiClient({ publishableKey, fetch: vi.fn(), frontendApi: API_URL, navigate });
    fapi.redirectTo("javascript:alert(document.cookie)");
    fapi.redirectTo("data:text/html,<script>alert(1)</script>");
    fapi.redirectTo("https://user:pass@evil.test/");
    // Protocol-relative and bare relative values resolve off-origin once a base is applied.
    fapi.redirectTo("//evil.test/oauth");
    fapi.redirectTo("/oauth");
    expect(navigate).not.toHaveBeenCalled();
    fapi.redirectTo("https://accounts.google.com/o/oauth2/v2/auth?client_id=abc");
    expect(navigate).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/v2/auth?client_id=abc");
  });
});

describe("FapiClient aborts cleanly", () => {
  it("does not retry an aborted GET and releases the back-off timer", async () => {
    vi.useFakeTimers();
    try {
      const controller = new AbortController();
      let calls = 0;
      const fetchImpl = vi.fn(async () => {
        calls += 1;
        throw new DOMException("aborted", "AbortError");
      });
      const fapi = new FapiClient({ publishableKey, fetch: fetchImpl, frontendApi: API_URL, retry: { attempts: 3, delayMs: 10_000 } });
      await expect(fapi.get("/v1/client", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
      expect(calls).toBe(1);
      expect(vi.getTimerCount()).toBe(0);
      controller.abort();
    } finally {
      vi.useRealTimers();
    }
  });

  it("fails fast when the signal is already aborted", async () => {
    const fetchImpl = vi.fn();
    const fapi = new FapiClient({ publishableKey, fetch: fetchImpl, frontendApi: API_URL });
    const controller = new AbortController();
    controller.abort();
    await expect(fapi.get("/v1/client", { signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("OrbitID teardown and concurrency", () => {
  beforeEach(() => clearCookies());
  afterEach(() => clearCookies());

  function setup() {
    let clientCalls = 0;
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") {
        clientCalls += 1;
        const client = clientJSON({ sessions: [sessionJSON()], last_active_session_id: "sess_1" });
        return { body: { response: client, client } };
      }
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") return { body: { jwt: fakeJwt({ sid: "sess_1" }) } };
      return { status: 404, body: {} };
    });
    return { api, clientCalls: () => clientCalls };
  }

  it("shares one /v1/client request across concurrent refreshes", async () => {
    const { api, clientCalls } = setup();
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const before = clientCalls();
    await Promise.all([orbit.refreshClient(), orbit.refreshClient(), orbit.refreshClient()]);
    expect(clientCalls() - before).toBe(1);
    orbit.dispose();
  });

  it("refuses to load after dispose and does not re-arm timers", async () => {
    vi.useFakeTimers();
    try {
      const { api, clientCalls } = setup();
      const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
      orbit.dispose();
      await expect(orbit.load()).rejects.toThrow(/disposed/);

      const loaded = new OrbitID(publishableKey, { fetch: api.fetch });
      const pending = loaded.load();
      loaded.dispose();
      await pending;
      const after = clientCalls();
      await vi.advanceTimersByTimeAsync(120_000);
      expect(clientCalls()).toBe(after);
      expect(loaded.loaded).toBe(false);
      expect(loaded.session).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not notify listeners after dispose", async () => {
    const { api } = setup();
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    const listener = vi.fn();
    orbit.addListener(listener);
    await orbit.load();
    expect(listener).toHaveBeenCalledTimes(1);
    orbit.dispose();
    await orbit.refreshClient().catch(() => undefined);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("reports a network failure without leaking the API URL", async () => {
    const orbit = new OrbitID(publishableKey, {
      fetch: async () => {
        throw new Error(`connect ECONNREFUSED ${API_URL}`);
      },
      retry: { attempts: 1 },
    });
    await expect(orbit.load()).rejects.toMatchObject({ code: "network_error" });
    await expect(orbit.load().catch((error: unknown) => error)).resolves.not.toMatchObject({
      message: expect.stringContaining(API_URL),
    });
    orbit.dispose();
  });

  it("refuses to navigate to javascript:/data:/protocol-relative targets", async () => {
    const { api } = setup();
    const push = vi.fn();
    const replace = vi.fn();
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch, navigate: { push, replace } });
    await orbit.load();
    for (const target of ["javascript:alert(1)", "data:text/html,x", "//evil.test/x", "/\\evil.test", "https://user:pass@evil.test/"]) {
      orbit.navigate(target);
      orbit.navigate(target, { replace: true });
    }
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
    orbit.navigate("/dashboard");
    expect(push).toHaveBeenCalledWith("/dashboard");
    orbit.dispose();
  });

  it("does not refresh after dispose", async () => {
    const { api, clientCalls } = setup();
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const before = clientCalls();
    orbit.dispose();
    await orbit.refreshClient().catch(() => undefined);
    expect(clientCalls()).toBe(before);
  });
});
