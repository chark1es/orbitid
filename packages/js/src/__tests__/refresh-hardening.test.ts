import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitID } from "../orbit";
import {
  ApiMock,
  clearCookies,
  clientJSON,
  cookieValue,
  environmentJSON,
  fakeJwt,
  publishableKey,
  sessionJSON,
  type MockResult,
} from "./helpers";

/**
 * The refresh loop's hardening: a refresh-client rebuild, N tabs sharing one cookie, a backward
 * wall-clock jump, and a 429. None of them may stall the timer or sign the user out.
 */
function routes(
  token: (call: number) => MockResult | Promise<MockResult>,
): ApiMock {
  let tokens = 0;
  return new ApiMock(async (call) => {
    if (call.method === "GET" && call.path === "/v1/client") {
      const client = clientJSON({ sessions: [sessionJSON()], last_active_session_id: "sess_1" });
      return { body: { response: client, client } };
    }
    if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
    if (call.method === "POST" && call.path === "/v1/client/sessions/sess_1/tokens") {
      tokens += 1;
      return token(tokens);
    }
    return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
  });
}

const minted = (nonce: string) => ({ body: { jwt: fakeJwt({ sid: "sess_1", nonce }) } });

beforeEach(() => {
  clearCookies();
  localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  clearCookies();
  localStorage.clear();
});

describe("refresh keeps its timer across a client rebuild", () => {
  it("keeps refreshing after refreshClient() replaces the Session object mid-flight", async () => {
    vi.useFakeTimers();
    let release: ((result: MockResult) => void) | null = null;
    const api = routes((call) => {
      if (call === 1) return minted("first");
      if (call === 2) {
        return new Promise<MockResult>((resolve) => {
          release = resolve;
        });
      }
      return minted(`later-${call}`);
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    // No timer, and a stale cache: this is the exact moment the loop would refresh.
    orbit.stopTokenRefresh();
    await vi.advanceTimersByTimeAsync(51_000);
    const tokenPath = "/v1/client/sessions/sess_1/tokens";

    const refresh = (orbit as unknown as { refreshSessionToken(): Promise<void> }).refreshSessionToken();
    // Let the token request reach the deferred handler, then rebuild every resource from a client envelope
    // exactly as a cross-tab broadcast or setActive would while the mint is still in flight.
    await vi.advanceTimersByTimeAsync(0);
    await orbit.refreshClient();
    release!(minted("late"));
    await refresh;

    expect(api.countCalls("POST", tokenPath)).toBe(2);
    // The accepted token expires in 60 s; the loop must have re-armed and mint again by then.
    await vi.advanceTimersByTimeAsync(51_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.countCalls("POST", tokenPath)).toBe(3);
    expect(orbit.isSignedIn).toBe(true);
    orbit.dispose();
  });
});

describe("refresh across tabs", () => {
  class HubChannel {
    static all: HubChannel[] = [];
    onmessage: ((event: MessageEvent) => void) | null = null;
    constructor(readonly name: string) {
      HubChannel.all.push(this);
    }
    postMessage(data: unknown): void {
      for (const other of HubChannel.all) {
        if (other !== this) other.onmessage?.({ data } as MessageEvent);
      }
    }
    close(): void {
      HubChannel.all = HubChannel.all.filter((channel) => channel !== this);
    }
  }

  async function steadyState(): Promise<number> {
    const api = routes((call) => minted(`mint-${call}`));
    const first = new OrbitID(publishableKey, { fetch: api.fetch });
    const second = new OrbitID(publishableKey, { fetch: api.fetch });
    await first.load();
    await second.load();
    first.stopTokenRefresh();
    second.stopTokenRefresh();
    const tokenPath = "/v1/client/sessions/sess_1/tokens";
    const baseline = api.countCalls("POST", tokenPath);

    // Both tabs find a stale token and refresh at once. One mints; the other waits, then must notice the
    // winner's token (broadcast, or the shared cookie) instead of minting a second one.
    await vi.advanceTimersByTimeAsync(51_000);
    await Promise.all([
      (first as unknown as { refreshSessionToken(): Promise<void> }).refreshSessionToken(),
      (second as unknown as { refreshSessionToken(): Promise<void> }).refreshSessionToken(),
    ]);
    expect(api.countCalls("POST", tokenPath)).toBe(baseline + 1);

    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.countCalls("POST", tokenPath)).toBe(baseline + 1);

    // The next cycle stays at one mint too.
    first.stopTokenRefresh();
    second.stopTokenRefresh();
    await vi.advanceTimersByTimeAsync(51_000);
    await Promise.all([
      (first as unknown as { refreshSessionToken(): Promise<void> }).refreshSessionToken(),
      (second as unknown as { refreshSessionToken(): Promise<void> }).refreshSessionToken(),
    ]);
    await vi.advanceTimersByTimeAsync(6_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.countCalls("POST", tokenPath)).toBe(baseline + 2);
    first.dispose();
    second.dispose();
    return baseline;
  }

  it("mints once per cycle for two tabs with BroadcastChannel", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("BroadcastChannel", HubChannel);
    await steadyState();
  });

  it("mints once per cycle for two tabs when BroadcastChannel is unavailable", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("BroadcastChannel", undefined);
    await steadyState();
  });
});

describe("refresh tolerates a backward wall clock", () => {
  it("does not stall for hours when the system clock jumps back", async () => {
    vi.useFakeTimers();
    const api = routes((call) => minted(`clock-${call}`));
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const tokenPath = "/v1/client/sessions/sess_1/tokens";
    const before = api.countCalls("POST", tokenPath);

    // NTP or DST moves the wall clock two hours back after the timer was planned.
    vi.setSystemTime(Date.now() - 2 * 60 * 60 * 1000);
    document.dispatchEvent(new Event("visibilitychange"));

    // The schedule is recomputed from the monotonic reference: mint once now rather than trusting a
    // deadline hours in the future.
    await vi.advanceTimersByTimeAsync(10);
    expect(api.countCalls("POST", tokenPath)).toBe(before + 1);
    // Then keep running: the next token is scheduled from its own lifetime, not the jumped clock.
    await vi.advanceTimersByTimeAsync(61_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.countCalls("POST", tokenPath)).toBe(before + 2);
    expect(orbit.isSignedIn).toBe(true);
    orbit.dispose();
  });
});

describe("refresh honours a 429", () => {
  it("waits for Retry-After, backs off, and never signs out", async () => {
    vi.useFakeTimers();
    const api = routes((call) =>
      call === 1
        ? minted("first")
        : {
            status: 429,
            headers: { "retry-after": "7" },
            body: { errors: [{ code: "rate_limited", message: "Too many requests" }] },
          },
    );
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const tokenPath = "/v1/client/sessions/sess_1/tokens";
    const before = cookieValue("__session");

    await vi.advanceTimersByTimeAsync(51_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.countCalls("POST", tokenPath)).toBe(2);
    // The server asked for 7 s; a plain 5 s back-off would already have retried.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.countCalls("POST", tokenPath)).toBe(2);
    await vi.advanceTimersByTimeAsync(2_000);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.countCalls("POST", tokenPath)).toBe(3);

    expect(orbit.isSignedIn).toBe(true);
    expect(cookieValue("__session")).toBe(before);
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);
    orbit.dispose();
  });
});

describe("refresh interval floor", () => {
  it("applies the 5 second floor to an expiry-derived delay, not just a configured one", async () => {
    vi.useFakeTimers();
    const api = routes((call) => ({
      body: { jwt: fakeJwt({ sid: "sess_1", nonce: call }, { lifetimeSeconds: 8 }) },
    }));
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const tokenPath = "/v1/client/sessions/sess_1/tokens";
    const before = api.countCalls("POST", tokenPath);

    // An 8 s token less the 10 s leeway would schedule in 1 s; the floor keeps it at 5 s.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(api.countCalls("POST", tokenPath)).toBe(before);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.countCalls("POST", tokenPath)).toBe(before + 1);
    orbit.dispose();
  });

  it("never mints more often than every 5 seconds for a 1-second configured cadence", async () => {
    vi.useFakeTimers();
    const api = routes((call) => minted(`fast-${call}`));
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch, tokenRefreshIntervalMs: 1_000 });
    await orbit.load();
    // No timer, stale token: a 1 s cadence would now mint every second.
    orbit.stopTokenRefresh();
    await vi.advanceTimersByTimeAsync(51_000);
    (orbit as unknown as { startTokenRefresh(): void }).startTokenRefresh();
    const tokenPath = "/v1/client/sessions/sess_1/tokens";
    const before = api.countCalls("POST", tokenPath);

    // The floor is 5 s: nothing is minted before then even though 4 s have passed.
    await vi.advanceTimersByTimeAsync(4_000);
    expect(api.countCalls("POST", tokenPath)).toBe(before);
    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(10);
    expect(api.countCalls("POST", tokenPath)).toBe(before + 1);
    orbit.dispose();
  });
});
