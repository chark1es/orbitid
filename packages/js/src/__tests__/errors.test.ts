import { describe, expect, it } from "vitest";
import { FapiClient } from "../fapi";
import { OrbitAPIResponseError, isOrbitAPIResponseError, parseError } from "../util/errors";
import { ApiMock, API_URL, errorBody, publishableKey } from "./helpers";

describe("error mapping", () => {
  it("maps the wire error body into OrbitAPIResponseError", async () => {
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client/me") return errorBody("form_password_incorrect", "Password is incorrect");
      return { status: 404, body: {} };
    });
    const fapi = new FapiClient({ publishableKey, fetch: api.fetch, frontendApi: API_URL });
    const error = await fapi.get("/v1/client/me").catch((err: unknown) => err);

    expect(isOrbitAPIResponseError(error)).toBe(true);
    const apiError = error as OrbitAPIResponseError;
    expect(apiError).toBeInstanceOf(OrbitAPIResponseError);
    expect(apiError.status).toBe(422);
    expect(apiError.code).toBe("form_password_incorrect");
    expect(apiError.traceId).toBe("trace_1");
    expect(apiError.longMessage).toBe("Password is incorrect");
    expect(apiError.hasCode("form_password_incorrect")).toBe(true);

    const parsed = parseError(error);
    expect(parsed.status).toBe(422);
    expect(parsed.errors[0]?.message).toBe("Password is incorrect");
    expect(parseError(new Error("boom")).errors[0]?.code).toBe("unknown_error");
  });

  it("retries GETs on network failure", async () => {
    let attempts = 0;
    const api = new ApiMock(() => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("Failed to fetch");
      return { body: { response: { ok: true } } };
    });
    const fapi = new FapiClient({ publishableKey, fetch: api.fetch, frontendApi: API_URL, retry: { attempts: 3, delayMs: 0 } });
    const result = await fapi.get<{ response: { ok: boolean } }>("/v1/client");
    expect(result.response.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  it("does not retry POSTs and surfaces a network error", async () => {
    let attempts = 0;
    const api = new ApiMock(() => {
      attempts += 1;
      throw new TypeError("Failed to fetch");
    });
    const fapi = new FapiClient({ publishableKey, fetch: api.fetch, frontendApi: API_URL, retry: { attempts: 3, delayMs: 0 } });
    const error = await fapi.post("/v1/client/sign_ins", { body: {} }).catch((err: unknown) => err);
    expect(attempts).toBe(1);
    expect(isOrbitAPIResponseError(error)).toBe(true);
    expect((error as OrbitAPIResponseError).status).toBe(0);
    expect((error as OrbitAPIResponseError).code).toBe("network_error");
  });

  it("keeps the envelope client reference on errors from malformed bodies", async () => {
    const api = new ApiMock(() => ({ status: 500, body: null }));
    const fapi = new FapiClient({ publishableKey, fetch: api.fetch, frontendApi: API_URL });
    const error = await fapi.get("/v1/client").catch((err: unknown) => err);
    expect((error as OrbitAPIResponseError).status).toBe(500);
    expect((error as OrbitAPIResponseError).code).toBe("unknown_error");
  });
});
