import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, clearLegacyCredentials, useAuth } from "./auth";

const SESSION = { object: "operator_session", id: "osess_1", expires_at: Date.now() + 3_600_000 };

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Exposes the auth value and its two actions to the test. */
let actions: ReturnType<typeof useAuth> | null = null;
function Probe() {
  const auth = useAuth();
  actions = auth;
  return <p>{auth.checking ? "checking" : auth.authenticated ? "in" : "out"}</p>;
}

function renderProvider() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <AuthProvider>
        <Probe />
      </AuthProvider>
    </QueryClientProvider>,
  );
}

describe("operator session lifecycle", () => {
  it("starts unauthenticated when the cookie is not live", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ errors: [{ code: "authentication_invalid", message: "No session" }] }, 401),
    );
    renderProvider();
    expect(await screen.findByText("out")).toBeTruthy();
  });

  it("revokes the session on sign out and drops local state", async () => {
    const calls: string[] = [];
    let signedIn = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url}`);
      if (method === "POST") {
        signedIn = true;
        return json(SESSION, 201);
      }
      if (method === "DELETE") {
        signedIn = false;
        return new Response(null, { status: 204 });
      }
      return signedIn ? json(SESSION) : json({ errors: [{ code: "authentication_invalid", message: "No session" }] }, 401);
    });

    renderProvider();
    expect(await screen.findByText("out")).toBeTruthy();

    await actions!.signIn(window.location.origin, "sk_test_once");
    await waitFor(() => expect(screen.getByText("in")).toBeTruthy());

    await actions!.signOut();
    await waitFor(() => expect(screen.getByText("out")).toBeTruthy());
    expect(calls).toContain(`DELETE ${window.location.origin}/v1/operator_sessions/current`);
  });

  it("refuses to send the key to a different origin", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ errors: [{ code: "authentication_invalid", message: "No session" }] }, 401),
    );
    renderProvider();
    await screen.findByText("out");

    await expect(actions!.signIn("https://other.example.com", "sk_test_never_sent")).rejects.toMatchObject({
      status: 400,
      code: "not_allowed_access",
    });
  });

  it("drops the session when any API call reports a 401", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") return json(SESSION, 201);
      return json(SESSION);
    });

    renderProvider();
    expect(await screen.findByText("in")).toBeTruthy();

    // `api()` dispatches this on any 401; the shell must leave the authenticated area immediately.
    window.dispatchEvent(new CustomEvent("orbitid:unauthorized", { detail: "Session ended" }));
    await waitFor(() => expect(screen.getByText("out")).toBeTruthy());
  });
});

describe("operator sign-out failures", () => {
  it("keeps the session and reports the failure when the server cannot revoke it", async () => {
    let signedIn = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        signedIn = true;
        return json(SESSION, 201);
      }
      if (method === "DELETE") return json({ errors: [{ code: "internal_server_error", message: "Server error" }] }, 500);
      return signedIn ? json(SESSION) : json({ errors: [{ code: "authentication_invalid", message: "No session" }] }, 401);
    });

    renderProvider();
    await screen.findByText("out");
    await actions!.signIn(window.location.origin, "sk_test_once");
    await waitFor(() => expect(screen.getByText("in")).toBeTruthy());

    // A failed revocation must not pretend the operator is signed out: the cookie is still live.
    await expect(actions!.signOut()).rejects.toMatchObject({ status: 500 });
    expect(screen.getByText("in")).toBeTruthy();
  });

  it("treats an already-ended session as a completed sign-out", async () => {
    let live = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      const method = init?.method ?? "GET";
      if (method === "POST") {
        live = true;
        return json(SESSION, 201);
      }
      if (method === "DELETE") {
        live = false;
        return json({ errors: [{ code: "authentication_invalid", message: "No session" }] }, 401);
      }
      return live ? json(SESSION) : json({ errors: [{ code: "authentication_invalid", message: "No session" }] }, 401);
    });

    renderProvider();
    await screen.findByText("out");
    await actions!.signIn(window.location.origin, "sk_test_once");
    await waitFor(() => expect(screen.getByText("in")).toBeTruthy());

    await expect(actions!.signOut()).resolves.toBeUndefined();
    await waitFor(() => expect(screen.getByText("out")).toBeTruthy());
  });
});

describe("legacy credentials", () => {
  it("removes a secret key an older dashboard left in sessionStorage", () => {
    sessionStorage.setItem("orbitid.secretKey", "sk_test_legacy");
    clearLegacyCredentials();
    expect(sessionStorage.getItem("orbitid.secretKey")).toBeNull();
  });

  it("clears the legacy key when the provider mounts, so an upgraded tab drops it", async () => {
    sessionStorage.setItem("orbitid.secretKey", "sk_test_legacy_tab");
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ errors: [{ code: "authentication_invalid", message: "No session" }] }, 401),
    );
    renderProvider();
    await screen.findByText("out");
    expect(sessionStorage.getItem("orbitid.secretKey")).toBeNull();
    expect(JSON.stringify(sessionStorage)).not.toContain("sk_test_legacy_tab");
  });

  it("survives a storage implementation that throws", () => {
    const blocked = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); },
      removeItem: () => { throw new Error("blocked"); },
      clear: () => { throw new Error("blocked"); },
      key: () => null,
      length: 0,
    } as unknown as Storage;
    expect(() => clearLegacyCredentials(blocked)).not.toThrow();
  });
});
