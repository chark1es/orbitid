import { describe, expect, it, vi } from "vitest";
import { api, apiInit, getApiUrl, isSameOrigin, setApiUrl } from "./api";

describe("api 401 handling", () => {
  it("signals the guard globally so it can send the operator to /login", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: "authentication_invalid", message: "Session ended" }] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const listener = vi.fn();
    window.addEventListener("orbitid:unauthorized", listener);

    await expect(api("GET", "/instance")).rejects.toMatchObject({ status: 401, code: "authentication_invalid" });

    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("orbitid:unauthorized", listener);
  });

  it("does not signal the guard for non-auth errors", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ errors: [{ code: "resource_not_found", message: "Missing" }] }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const listener = vi.fn();
    window.addEventListener("orbitid:unauthorized", listener);

    await expect(api("GET", "/users/user_missing")).rejects.toMatchObject({ status: 404 });
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener("orbitid:unauthorized", listener);
  });

  it("sends the operator cookie with the request instead of a bearer key", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 200 }));
    await api("GET", "/instance");
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    expect(new Headers(init.headers).get("authorization")).toBeNull();
  });

  it("posts the secret key only for the one exchange call, then never again", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ object: "operator_session", id: "osess_1", expires_at: 1 }), { status: 201 }),
    );
    await api("POST", "/operator_sessions", { secret_key: "sk_test_once" });
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ secret_key: "sk_test_once" });

    // No storage anywhere in the page holds the key.
    expect(JSON.stringify(sessionStorage)).not.toContain("sk_test_once");
    expect(JSON.stringify(localStorage)).not.toContain("sk_test_once");
    expect(document.cookie).not.toContain("sk_test_once");
  });
});

describe("api origin", () => {
  it("defaults to the server that served the page", () => {
    expect(getApiUrl()).toBe(window.location.origin);
  });

  it("accepts a same-origin URL and rejects a cross-origin one", () => {
    expect(isSameOrigin(window.location.origin)).toBe(true);
    expect(isSameOrigin(`${window.location.origin}/`)).toBe(true);
    expect(isSameOrigin("https://other.example.com")).toBe(false);
    expect(isSameOrigin("not a url")).toBe(false);
  });

  it("remembers a temporary origin for the tab only", () => {
    setApiUrl("http://localhost:4000");
    expect(getApiUrl()).toBe("http://localhost:4000");
    setApiUrl(null);
    expect(getApiUrl()).toBe(window.location.origin);
  });

  it("builds credentialled requests for JSON and multipart alike", () => {
    expect(apiInit("GET").credentials).toBe("same-origin");
    const init = apiInit("POST", { a: 1 });
    expect(new Headers(init.headers).get("content-type")).toBe("application/json");
  });
});
