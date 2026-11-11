import { describe, expect, it, vi } from "vitest";
import { api, apiAllPages, apiInit, getApiUrl, isSameOrigin, notifyUnauthorized, setApiUrl } from "./api";

describe("api 401 handling", () => {
  it("does not announce an expired session during the initial session check", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("{}", { status: 401 }));
    const listener = vi.fn();
    window.addEventListener("orbitid:unauthorized", listener);
    try {
      await expect(api("GET", "/operator_sessions/current")).rejects.toMatchObject({ status: 401 });
      expect(listener).not.toHaveBeenCalled();
    } finally {
      window.removeEventListener("orbitid:unauthorized", listener);
    }
  });

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

  it("confirms a shared 401 once for queries that fail together", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/operator_sessions/current")) {
        return new Response(JSON.stringify({ errors: [{ code: "authentication_invalid" }] }), {
          status: 401,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ errors: [{ code: "upstream_failure", message: "Proxy answered" }] }), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      });
    });
    const listener = vi.fn();
    window.addEventListener("orbitid:unauthorized", listener);
    try {
      await Promise.allSettled([api("GET", "/users"), api("GET", "/organizations"), api("GET", "/sessions")]);
      const confirmations = fetchMock.mock.calls.filter(([input]) =>
        String(input).includes("/operator_sessions/current"),
      );
      // Three failing queries share one in-flight confirmation instead of three parallel probes.
      expect(confirmations).toHaveLength(1);
      expect(listener).toHaveBeenCalledTimes(1);
    } finally {
      window.removeEventListener("orbitid:unauthorized", listener);
    }
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

const jsonResponse = (body: unknown) =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

describe("apiAllPages", () => {
  it("reads a bare array response and counts its rows", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(jsonResponse([{ id: "thing_1" }]));

    await expect(apiAllPages<{ id: string }>("/things")).resolves.toEqual({
      data: [{ id: "thing_1" }],
      total_count: 1,
    });
  });

  it("uses the rows it read when the server omits total_count", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const offset = Number(new URL(String(input)).searchParams.get("offset"));
      return jsonResponse({ data: offset === 0 ? [{ id: "a" }, { id: "b" }] : [] });
    });

    await expect(apiAllPages<{ id: string }>("/things", { pageSize: 2 })).resolves.toEqual({
      data: [{ id: "a" }, { id: "b" }],
      total_count: 2,
    });
  });

  it("follows every page when the server caps rows below pageSize", async () => {
    const all = Array.from({ length: 5 }, (_, index) => ({ id: `thing_${index}` }));
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(String(input));
      const offset = Number(url.searchParams.get("offset"));
      const limit = Number(url.searchParams.get("limit"));
      return jsonResponse({ data: all.slice(offset, offset + Math.min(limit, 2)), total_count: all.length });
    });

    const result = await apiAllPages<{ id: string }>("/things", { pageSize: 4 });

    expect(result.data.map((row) => row.id)).toEqual(all.map((row) => row.id));
    expect(result.total_count).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("terminates when the server ignores offset instead of looping forever", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      jsonResponse({ data: [{ id: "a" }, { id: "b" }] }),
    );

    const result = await apiAllPages<{ id: string }>("/things", { pageSize: 2 });

    // The identical second page ends the walk; the rows are not repeated.
    expect(result.data).toEqual([{ id: "a" }, { id: "b" }]);
    expect(result.total_count).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("notifyUnauthorized", () => {
  it("announces the ended session with the message the shell shows", () => {
    const listener = vi.fn();
    window.addEventListener("orbitid:unauthorized", listener as EventListener);
    notifyUnauthorized();
    window.removeEventListener("orbitid:unauthorized", listener as EventListener);

    expect(listener).toHaveBeenCalledTimes(1);
    expect((listener.mock.calls[0]![0] as CustomEvent<string>).detail).toBe(
      "Your dashboard session ended. Sign in again.",
    );
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

describe("api 401 confirmation", () => {
  it("does not end the session for a proxy or captive-portal 401 that the session endpoint contradicts", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/v1/operator_sessions/current")) return new Response("{}", { status: 200 });
      return new Response("<html><body>Sign in to this Wi-Fi network</body></html>", {
        status: 401,
        headers: { "Content-Type": "text/html" },
      });
    });
    const listener = vi.fn();
    window.addEventListener("orbitid:unauthorized", listener);

    await expect(api("GET", "/users")).rejects.toMatchObject({ status: 401, code: "unknown" });
    expect(listener).not.toHaveBeenCalled();
    window.removeEventListener("orbitid:unauthorized", listener);
  });

  it("confirms an unstructured 401 against the session endpoint before announcing the end", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/v1/operator_sessions/current")) {
        return new Response(JSON.stringify({ errors: [{ code: "authentication_invalid" }] }), { status: 401 });
      }
      return new Response("<html><body>Proxy error</body></html>", {
        status: 401,
        headers: { "Content-Type": "text/html" },
      });
    });
    const listener = vi.fn();
    window.addEventListener("orbitid:unauthorized", listener);

    await expect(api("GET", "/users")).rejects.toMatchObject({ status: 401 });
    expect(
      fetchMock.mock.calls.map((call) => String(call[0])).some((url) => url.endsWith("/v1/operator_sessions/current")),
    ).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
    window.removeEventListener("orbitid:unauthorized", listener);
  });
});
