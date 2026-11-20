import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider, accountLabel, clearLegacyCredentials, useAuth, type OperatorStatus } from "./auth";

const SESSION = { object: "operator_session" as const, id: "osess_1", expires_at: Date.now() + 3_600_000, user_id: "user_owner" };
const OWNER = {
  id: "user_owner",
  first_name: "Ada",
  last_name: "Lovelace",
  username: null,
  email_address: "ada@example.com",
  image_url: null,
  console_access: true,
};

function status(overrides: Partial<OperatorStatus> = {}): OperatorStatus {
  return { object: "operator_status", operator_session: null, user: null, setup_required: false, ...overrides };
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Exposes the auth value and its actions to the test. */
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

afterEach(() => {
  window.__ORBITID_BOOT__ = undefined;
});

describe("operator session lifecycle", () => {
  it("starts unauthenticated when nobody is signed in", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(status()));
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
      return json(status({ operator_session: signedIn ? SESSION : null }));
    });

    renderProvider();
    expect(await screen.findByText("out")).toBeTruthy();

    await actions!.openConsole();
    await waitFor(() => expect(screen.getByText("in")).toBeTruthy());

    await actions!.signOut();
    await waitFor(() => expect(screen.getByText("out")).toBeTruthy());
    expect(calls).toContain(`DELETE ${window.location.origin}/v1/operator_sessions/current`);
  });

  it("has no way to sign in with the secret key", () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(status()));
    renderProvider();
    expect(actions && "signIn" in actions).toBe(false);
  });

  it("says when the session check is rate limited, and settles once it answers", async () => {
    let limited = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      limited
        ? new Response(JSON.stringify({ errors: [{ code: "rate_limit_exceeded", message: "Too many requests. Please try again later." }] }), {
            status: 429,
            headers: { "Content-Type": "application/json", "Retry-After": "42" },
          })
        : json(status()),
    );
    renderProvider();
    await waitFor(() => expect(actions!.statusError).toBe("Too many attempts. Try again in 42 seconds."));
    expect(screen.getByText("out")).toBeTruthy();
    limited = false;
    await actions!.refresh();
    await waitFor(() => expect(actions!.statusError).toBeNull());
  });

  it("drops the session when any API call reports a 401", async () => {
    let live = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json(status({ operator_session: live ? SESSION : null })),
    );

    renderProvider();
    expect(await screen.findByText("in")).toBeTruthy();

    // `api()` dispatches this on any 401; the shell must leave the authenticated area immediately.
    live = false;
    window.dispatchEvent(new CustomEvent("orbitid:unauthorized", { detail: "Session ended" }));
    await waitFor(() => expect(screen.getByText("out")).toBeTruthy());
  });

  it("does not loop when the status endpoint itself answers 401", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ errors: [{ code: "authentication_invalid", message: "No session" }] }, 401));
    renderProvider();
    expect(await screen.findByText("out")).toBeTruthy();
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(2);
  });
});

describe("boot status", () => {
  it("renders the right screen at once when the inline boot request already answered", () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const value = status({ operator_session: SESSION });
    window.__ORBITID_BOOT__ = { status: Promise.resolve(value), value };
    renderProvider();
    // No "checking" frame and no second request: the answer arrived with the page.
    expect(screen.getByText("in")).toBeTruthy();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("waits for a boot request still in flight instead of asking twice", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    let answer: (value: unknown) => void = () => undefined;
    window.__ORBITID_BOOT__ = { status: new Promise((resolve) => (answer = resolve)) };
    renderProvider();
    expect(screen.getByText("checking")).toBeTruthy();
    answer(status({ user: OWNER }));
    expect(await screen.findByText("out")).toBeTruthy();
    expect(actions!.status?.user?.email_address).toBe("ada@example.com");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("asks again when the boot request failed", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(json(status({ setup_required: true })));
    window.__ORBITID_BOOT__ = { status: Promise.reject(new Error("offline")) };
    renderProvider();
    await waitFor(() => expect(actions!.status?.setup_required).toBe(true));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("boot status fallback", () => {
  it("asks once when the boot answer is unusable, even if that request fails", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));
    window.__ORBITID_BOOT__ = { status: Promise.resolve({ unexpected: true }) };
    renderProvider();
    await waitFor(() => expect(actions!.statusError).toBe("Failed to fetch"));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("account sign-in", () => {
  it("creates the owner on a fresh instance and lands in the console", async () => {
    const bodies: unknown[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/v1/operator_sessions/setup")) {
        bodies.push(JSON.parse(String(init?.body)));
        return json(status({ operator_session: SESSION, user: OWNER }), 201);
      }
      return json(status({ setup_required: true }));
    });

    renderProvider();
    await waitFor(() => expect(actions!.status?.setup_required).toBe(true));
    await actions!.setupOwner({ email_address: "ada@example.com", password: "a long passphrase", first_name: "Ada" });
    await waitFor(() => expect(screen.getByText("in")).toBeTruthy());
    expect(actions!.status?.user?.id).toBe(OWNER.id);
    expect(bodies).toEqual([{ email_address: "ada@example.com", password: "a long passphrase", first_name: "Ada" }]);
  });

  it("opens the console for an account that may, and signs both out together", async () => {
    const calls: string[] = [];
    let console_ = false;
    let account = true;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      calls.push(`${method} ${url.replace(window.location.origin, "")}`);
      if (url.endsWith("/from_user")) {
        console_ = true;
        return json(SESSION, 201);
      }
      if (method === "DELETE") {
        console_ = false;
        account = false;
        return new Response(null, { status: 204 });
      }
      return json(
        status({
          operator_session: console_ ? SESSION : null,
          user: account ? OWNER : null,
        }),
      );
    });

    renderProvider();
    await waitFor(() => expect(actions!.status?.user?.console_access).toBe(true));
    expect(screen.getByText("out")).toBeTruthy();

    await actions!.openConsole();
    await waitFor(() => expect(screen.getByText("in")).toBeTruthy());

    await actions!.signOut();
    await waitFor(() => expect(screen.getByText("out")).toBeTruthy());
    // A console opened from an account ends with it: the page must not keep showing the account.
    expect(actions!.status?.user).toBeNull();
    expect(calls).toContain("POST /v1/operator_sessions/from_user");
  });

  it("names the account the console was opened for, not the one the page loaded with", async () => {
    let opened = false;
    const OTHER = { ...OWNER, id: "user_other", first_name: "Grace", last_name: "Hopper", email_address: "grace@example.com" };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/from_user")) {
        opened = true;
        return json({ ...SESSION, user_id: OTHER.id }, 201);
      }
      // Another tab switched the browser to OTHER after this page loaded with OWNER.
      return json(status({ operator_session: opened ? { ...SESSION, user_id: OTHER.id } : null, user: opened ? OTHER : OWNER }));
    });
    renderProvider();
    await waitFor(() => expect(actions!.status?.user?.id).toBe(OWNER.id));
    await actions!.openConsole();
    await waitFor(() => expect(actions!.status?.user?.id).toBe(OTHER.id));
  });

  it("signs an account without console access out on request", async () => {
    const calls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const method = init?.method ?? "GET";
      calls.push(`${method} ${String(input).replace(window.location.origin, "")}`);
      if (method === "DELETE") return new Response(null, { status: 204 });
      return json(status({ user: { ...OWNER, console_access: false } }));
    });
    renderProvider();
    await waitFor(() => expect(actions!.status?.user).not.toBeNull());
    await actions!.signOut({ account: true });
    expect(calls).toContain("DELETE /v1/operator_sessions/current?account=true");
  });

  it("labels an account by name, then username, then email", () => {
    expect(accountLabel(OWNER)).toBe("Ada Lovelace");
    expect(accountLabel({ ...OWNER, first_name: null, last_name: null, username: "ada" })).toBe("ada");
    expect(accountLabel({ ...OWNER, first_name: null, last_name: null })).toBe("ada@example.com");
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
      return json(status({ operator_session: signedIn ? SESSION : null }));
    });

    renderProvider();
    await screen.findByText("out");
    await actions!.openConsole();
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
      return json(status({ operator_session: live ? SESSION : null }));
    });

    renderProvider();
    await screen.findByText("out");
    await actions!.openConsole();
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
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json(status()));
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
