import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { OrbitID } from "../orbit";
import {
  clearLastUsedStrategy,
  readLastUsedStrategy,
  recordLastUsedStrategy,
} from "../util/last-used-strategy";
import { ApiMock, clientJSON, environmentJSON, publishableKey, sessionJSON, signInJSON } from "./helpers";

function setup() {
  const client = clientJSON();
  const api = new ApiMock((call) => {
    if (call.method === "GET" && call.path === "/v1/client") return { body: { response: client, client } };
    if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
    if (call.method === "POST" && call.path === "/v1/client/sign_ins") {
      const signIn = signInJSON({ status: "needs_first_factor" });
      return { body: { response: signIn, client: clientJSON({ sign_in: signIn }) } };
    }
    if (call.method === "POST" && call.path === "/v1/client/sign_ins/sia_1/attempt_first_factor") {
      return { body: { response: signInJSON({ status: "needs_second_factor", created_session_id: null }) } };
    }
    if (call.method === "POST" && call.path === "/v1/client/sign_ins/sia_1/attempt_second_factor") {
      return {
        body: {
          response: signInJSON({ status: "complete", created_session_id: "sess_1" }),
          client: clientJSON({ sessions: [sessionJSON()], last_active_session_id: null }),
        },
      };
    }
    return { status: 404, body: {} };
  });
  const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
  return { orbit, api };
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
});

describe("last used sign-in strategy", () => {
  it("records the method that completed and ignores identifiers", async () => {
    recordLastUsedStrategy("oauth_google");
    expect(readLastUsedStrategy()).toBe("oauth_google");

    clearLastUsedStrategy();
    expect(readLastUsedStrategy()).toBeNull();

    // An email address or any other PII must never reach storage.
    recordLastUsedStrategy("ada@example.com");
    expect(readLastUsedStrategy()).toBeNull();
  });

  it("exposes the completed method on the SDK instance", async () => {
    const { orbit } = setup();
    await orbit.load();
    await orbit.signIn.create({ identifier: "ada@example.com" });
    await orbit.signIn.attemptFirstFactor({ strategy: "password", password: "correct horse" });

    // A second factor is still outstanding, so nothing has been recorded yet.
    expect(orbit.lastUsedStrategy).toBeNull();

    await orbit.signIn.attemptSecondFactor({ strategy: "totp", code: "123456" });
    expect(orbit.lastUsedStrategy).toBe("password");
    orbit.dispose();
  });

  it("still reads null when storage is blocked", () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });
    try {
      expect(() => recordLastUsedStrategy("password")).not.toThrow();
      expect(readLastUsedStrategy()).toBeNull();
      expect(() => clearLastUsedStrategy()).not.toThrow();
    } finally {
      if (original) Object.defineProperty(window, "localStorage", original);
    }
  });

  it("still reads null when the storage write itself throws", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("blocked", "QuotaExceededError");
    };
    try {
      expect(() => recordLastUsedStrategy("email_code")).not.toThrow();
      expect(readLastUsedStrategy()).toBeNull();
    } finally {
      Storage.prototype.setItem = original;
    }
  });
});
