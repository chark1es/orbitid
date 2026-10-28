import { afterEach, describe, expect, it, vi } from "vitest";
import { createOrbitId } from "../src/client";
import { OrbitIdError, isOrbitIdError } from "../src/errors";
import { USER_AGENT } from "../src/version";
import { encodePublishableKey } from "@orbitid/shared";
import { startRealServer } from "./helpers/server";

const ENV_NAMES = ["ORBITID_SECRET_KEY", "ORBITID_API_URL", "ORBITID_PUBLISHABLE_KEY", "ORBITID_AUDIENCE", "ORBITID_JWKS_URL", "ORBITID_WEBHOOK_SECRET"] as const;

function clearEnv() {
  for (const name of ENV_NAMES) delete process.env[name];
}

afterEach(() => {
  clearEnv();
  vi.unstubAllGlobals();
});

describe("createOrbitId configuration", () => {
  it("reads the secret key, API URL and publishable key from the environment", () => {
    process.env.ORBITID_SECRET_KEY = "sk_test_abc12345";
    process.env.ORBITID_API_URL = "https://auth.example.com/";
    const orbit = createOrbitId();
    expect(orbit.client.apiUrl).toBe("https://auth.example.com");
    expect(orbit.config.jwksUrl).toBe("https://auth.example.com/.well-known/jwks.json");
    expect(orbit.version).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("derives the API URL from the publishable key when no URL is set", () => {
    process.env.ORBITID_SECRET_KEY = "sk_test_abc12345";
    process.env.ORBITID_PUBLISHABLE_KEY = encodePublishableKey("https://auth.example.com");
    const orbit = createOrbitId();
    expect(orbit.client.apiUrl).toBe("https://auth.example.com");
  });

  it("prefers explicit options over the environment", () => {
    process.env.ORBITID_SECRET_KEY = "sk_test_abc12345";
    process.env.ORBITID_API_URL = "https://env.example.com";
    const orbit = createOrbitId({ secretKey: "sk_test_explicit1", apiUrl: "https://option.example.com" });
    expect(orbit.client.apiUrl).toBe("https://option.example.com");
  });

  it("fails fast with a helpful error when the secret key is missing, without inventing one", () => {
    expect(() => createOrbitId({ apiUrl: "https://auth.example.com" })).toThrowError(OrbitIdError);
    try {
      createOrbitId({ apiUrl: "https://auth.example.com" });
    } catch (error) {
      const orbitError = error as OrbitIdError;
      expect(orbitError.reason).toBe("configuration");
      expect(orbitError.code).toBe("secret_key_missing");
      expect(orbitError.message).toContain("ORBITID_SECRET_KEY");
      expect(orbitError.message).not.toContain("sk_");
    }
  });

  it("rejects a publishable key where the secret key belongs", () => {
    expect(() => createOrbitId({ secretKey: "pk_test_aHR0cDovL2xvY2FsaG9zdDo0MDAw", apiUrl: "https://auth.example.com" }))
      .toThrowError(/publishable key/);
  });

  it("rejects a secret key containing line breaks", () => {
    expect(() => createOrbitId({ secretKey: "sk_test_abc12345\r\nX-Injected: 1", apiUrl: "https://auth.example.com" })).toThrowError(OrbitIdError);
  });

  it("never echoes the secret key in an error, even when a backend call fails", async () => {
    const server = await startRealServer();
    try {
      const orbit = createOrbitId({ secretKey: "sk_test_wrongsecret9", apiUrl: server.url });
      let message = "";
      try {
        await orbit.client.users.getUserList();
      } catch (error) {
        message = (error as Error).message;
        expect(isOrbitIdError(error)).toBe(true);
        expect((error as OrbitIdError).status).toBe(401);
        expect((error as OrbitIdError).code).toBe("secret_key_invalid");
      }
      expect(message).not.toContain("sk_test_wrongsecret9");
    } finally {
      await server.close();
    }
  });

  it("sends User-Agent: orbitid-node/<version> on every request", async () => {
    const server = await startRealServer();
    try {
      const seen: (string | null)[] = [];
      const orbit = createOrbitId({
        secretKey: server.secretKey,
        apiUrl: server.url,
        fetch: async (input, init) => {
          seen.push(new Headers(init?.headers).get("user-agent"));
          return fetch(input, init);
        },
      });
      await orbit.client.users.getUserList();
      expect(seen).toEqual([USER_AGENT]);
      expect(USER_AGENT).toMatch(/^orbitid-node\/\d+\.\d+\.\d+$/);
    } finally {
      await server.close();
    }
  });

  it("rejects tokens when the configured audience is not in the JWT", async () => {
    process.env.ORBITID_SECRET_KEY = "sk_test_abc12345";
    process.env.ORBITID_AUDIENCE = "my-api";
    const orbit = createOrbitId({ apiUrl: "https://auth.example.com" });
    expect(orbit.config.audience).toBe("my-api");
  });
});

describe("transport", () => {
  it("retries idempotent GETs on a 5xx and then succeeds", async () => {
    let calls = 0;
    const orbit = createOrbitId({
      secretKey: "sk_test_abc12345",
      apiUrl: "https://auth.example.com",
      retryDelayMs: 1,
      fetch: async () => {
        calls += 1;
        if (calls < 3) {
          return new Response(JSON.stringify({ errors: [{ code: "internal_server_error", message: "boom" }] }), { status: 503, headers: { "content-type": "application/json" } });
        }
        return new Response(JSON.stringify({ data: [], total_count: 0 }), { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    const result = await orbit.client.users.getUserList();
    expect(calls).toBe(3);
    expect(result.totalCount).toBe(0);
  });

  it("does not retry non-idempotent requests", async () => {
    let calls = 0;
    const orbit = createOrbitId({
      secretKey: "sk_test_abc12345",
      apiUrl: "https://auth.example.com",
      retryDelayMs: 1,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ errors: [{ code: "internal_server_error", message: "boom" }] }), { status: 500, headers: { "content-type": "application/json" } });
      },
    });
    await expect(orbit.client.users.createUser({ emailAddress: ["a@example.com"], password: "Sup3rSecret!" })).rejects.toMatchObject({ status: 500 });
    expect(calls).toBe(1);
  });

  it("gives up after the configured number of GET attempts", async () => {
    let calls = 0;
    const orbit = createOrbitId({
      secretKey: "sk_test_abc12345",
      apiUrl: "https://auth.example.com",
      retries: 1,
      retryDelayMs: 1,
      fetch: async () => {
        calls += 1;
        return new Response(JSON.stringify({ errors: [{ code: "rate_limit_exceeded", message: "slow down" }] }), { status: 429, headers: { "content-type": "application/json" } });
      },
    });
    await expect(orbit.client.users.getUserList()).rejects.toMatchObject({ code: "rate_limit_exceeded" });
    expect(calls).toBe(2);
  });

  it("reports an unreachable server as a typed network error", async () => {
    const orbit = createOrbitId({
      secretKey: "sk_test_abc12345",
      apiUrl: "http://127.0.0.1:1",
      retries: 1,
      retryDelayMs: 1,
      timeoutMs: 2_000,
    });
    await expect(orbit.client.users.getUserList()).rejects.toMatchObject({ name: "OrbitIdError", code: "network_error", reason: "network-error" });
  });

  it("times out a request that never answers", async () => {
    const orbit = createOrbitId({
      secretKey: "sk_test_abc12345",
      apiUrl: "https://auth.example.com",
      retries: 0,
      timeoutMs: 25,
      fetch: (_input, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      }),
    });
    await expect(orbit.client.users.getUserList()).rejects.toMatchObject({ code: "request_timeout", reason: "request-timeout" });
  });

  it("maps a non-JSON error response to a generic typed error without leaking the body", async () => {
    const orbit = createOrbitId({
      secretKey: "sk_test_abc12345",
      apiUrl: "https://auth.example.com",
      retries: 0,
      fetch: async () => new Response("<html>IIS 10.0 Detailed Error - internal stack trace</html>", { status: 500 }),
    });
    await expect(orbit.client.users.getUserList()).rejects.toMatchObject({
      status: 500,
      code: "unknown_error",
      message: "The OrbitID server returned an unexpected response (status 500)",
    });
  });

  it("keeps trace_id from an API error body", async () => {
    const orbit = createOrbitId({
      secretKey: "sk_test_abc12345",
      apiUrl: "https://auth.example.com",
      retries: 0,
      fetch: async () => new Response(JSON.stringify({ errors: [{ code: "resource_not_found", message: "No such user" }], trace_id: "trace_123" }), { status: 404, headers: { "content-type": "application/json" } }),
    });
    try {
      await orbit.client.users.getUser("user_missing");
      expect.unreachable("should throw");
    } catch (error) {
      const orbitError = error as OrbitIdError;
      expect(orbitError.status).toBe(404);
      expect(orbitError.code).toBe("resource_not_found");
      expect(orbitError.traceId).toBe("trace_123");
      expect(orbitError.toBody()).toEqual({ errors: [{ code: "resource_not_found", message: "No such user" }], trace_id: "trace_123" });
    }
  });
});
