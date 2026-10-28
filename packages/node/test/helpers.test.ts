import { describe, expect, it } from "vitest";
import { readHeader, tokenFromRequest, headersOf, isFetchRequest } from "../src/request";
import { parseApiErrorBody, errorFromResponse, OrbitIdError, isOrbitIdError } from "../src/errors";

describe("request helpers", () => {
  it("reads headers from a Fetch Headers object, case-insensitively", () => {
    const headers = new Headers({ Authorization: "Bearer abc" });
    expect(readHeader(headers, "authorization")).toBe("Bearer abc");
  });

  it("reads headers from a Node header bag, including arrays", () => {
    expect(readHeader({ authorization: "Bearer a" }, "authorization")).toBe("Bearer a");
    expect(readHeader({ authorization: ["Bearer a", "Bearer b"] }, "authorization")).toBe("Bearer a, Bearer b");
    expect(readHeader({ AUTHORIZATION: "Bearer c" }, "authorization")).toBe("Bearer c");
    expect(readHeader({}, "authorization")).toBeNull();
    expect(readHeader(undefined, "authorization")).toBeNull();
  });

  it("prefers the bearer token and falls back to the cookie", () => {
    expect(tokenFromRequest({ headers: { authorization: "Bearer t1", cookie: "__session=t2" } })).toBe("t1");
    expect(tokenFromRequest({ headers: { cookie: "__session=t2" } })).toBe("t2");
    expect(tokenFromRequest({ headers: { authorization: "Basic abc", cookie: "__session=t3" } })).toBe("t3");
    expect(tokenFromRequest({ headers: {} })).toBeNull();
    expect(tokenFromRequest({})).toBeNull();
  });

  it("tolerates URL-encoded cookie values", () => {
    expect(tokenFromRequest({ headers: { cookie: `__session=${encodeURIComponent("a.b.c")}` } })).toBe("a.b.c");
  });

  it("detects a Fetch Request", () => {
    expect(isFetchRequest(new Request("https://app.example.com"))).toBe(true);
    expect(isFetchRequest({ headers: {} })).toBe(false);
    expect(isFetchRequest(null)).toBe(false);
    expect(headersOf({ headers: { a: "b" } })).toEqual({ a: "b" });
  });
});

describe("error parsing", () => {
  it("parses the server's error shape", () => {
    const parsed = parseApiErrorBody({ errors: [{ code: "resource_not_found", message: "No user" }], trace_id: "t1" });
    expect(parsed).toEqual({ errors: [{ code: "resource_not_found", message: "No user" }], trace_id: "t1" });
  });

  it("rejects anything else", () => {
    expect(parseApiErrorBody({ errors: [] })).toBeNull();
    expect(parseApiErrorBody({ errors: [{ message: "no code" }] })).toBeNull();
    expect(parseApiErrorBody("<html>")).toBeNull();
    expect(parseApiErrorBody(null)).toBeNull();
  });

  it("maps a bodyless response to a generic error and never exposes the body", async () => {
    const error = await errorFromResponse(new Response("stacktrace at /srv/app/index.js", { status: 502 }));
    expect(error).toBeInstanceOf(OrbitIdError);
    expect(error.status).toBe(502);
    expect(error.code).toBe("unknown_error");
    expect(error.message).toBe("The OrbitID server returned an unexpected response (status 502)");
  });

  it("keeps every error item and meta", async () => {
    const error = await errorFromResponse(
      new Response(
        JSON.stringify({
          errors: [
            { code: "form_identifier_not_found", message: "Couldn't find your account", meta: { param_name: "identifier" } },
            { code: "form_param_missing", message: "identifier is missing" },
          ],
          trace_id: "trace_x",
        }),
        { status: 422, headers: { "content-type": "application/json" } },
      ),
    );
    expect(error.status).toBe(422);
    expect(error.code).toBe("form_identifier_not_found");
    expect(error.traceId).toBe("trace_x");
    expect(error.meta).toEqual({ param_name: "identifier" });
    expect(error.errors).toHaveLength(2);
    expect(error.hasCode("form_param_missing")).toBe(true);
  });

  it("uses an x-orbitid-trace-id header when the body has no trace_id", async () => {
    const error = await errorFromResponse(
      new Response(JSON.stringify({ errors: [{ code: "rate_limit_exceeded", message: "slow down" }] }), {
        status: 429,
        headers: { "content-type": "application/json", "x-orbitid-trace-id": "hdr_trace" },
      }),
    );
    expect(error.traceId).toBe("hdr_trace");
  });

  it("recognizes its own errors across module boundaries", () => {
    expect(isOrbitIdError(new OrbitIdError({ code: "x", message: "y" }))).toBe(true);
    expect(isOrbitIdError({ name: "OrbitIdError" })).toBe(true);
    expect(isOrbitIdError(new Error("other"))).toBe(false);
  });
});
