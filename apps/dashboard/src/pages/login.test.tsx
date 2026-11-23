import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App";
import { AuthProvider } from "../lib/auth";

// The SDK sign-in form talks to the Frontend API; its own package tests cover it. Here it is a stub that can report
// a finished sign-in, which is all the sign-in screen depends on.
vi.mock("./_login/account-sign-in", () => ({
  prepareAccountSignIn: () => {},
  default: ({ onSignedIn }: { onSignedIn: () => void }) => (
    <button type="button" onClick={onSignedIn}>
      Account sign-in form
    </button>
  ),
}));

const STATS = {
  users_total: 0,
  users_active_7d: 0,
  sessions_active: 0,
  organizations_total: 0,
  signups_by_day: [],
  signins_by_day: [],
  banned_users: 0,
  locked_users: 0,
  mfa_enabled_users: 0,
  top_social_providers: [],
};

const INSTANCE = { application: { name: "OrbitID App", homeUrl: "http://localhost:3000" } };

const ACCOUNT = {
  id: "user_ada",
  first_name: "Ada",
  last_name: "Lovelace",
  username: null,
  email_address: "ada@example.com",
  image_url: null,
  console_access: true,
};

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface MockOptions {
  /** Report a live console session on `GET /v1/operator_sessions/status`. */
  sessionActive?: boolean;
  /** The instance has no account yet. */
  setupRequired?: boolean;
  /** Accounts exist but none can open the console. */
  unclaimed?: boolean;
  /** The account signed in on this browser. */
  account?: typeof ACCOUNT | null;
  /** Answer the status check with `429` and this `Retry-After` until `lift()` is called. */
  statusRetryAfter?: number;
  /** Answer `POST /from_user` with `429` and this `Retry-After`. */
  openRetryAfter?: number;
  health?: Record<string, unknown>;
}

function mockApi(options: MockOptions = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  let live = !!options.sessionActive;
  let account = options.account ?? null;
  let setupRequired = !!options.setupRequired;
  let limited = options.statusRetryAfter !== undefined;
  const session = () => ({ object: "operator_session", id: "osess_test", expires_at: Date.now() + 3_600_000, user_id: ACCOUNT.id });
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });

    if (url.includes("/v1/operator_sessions/status")) {
      if (limited) {
        return new Response(JSON.stringify({ errors: [{ code: "rate_limit_exceeded", message: "Too many requests. Please try again later." }] }), {
          status: 429,
          headers: { "Content-Type": "application/json", "Retry-After": String(options.statusRetryAfter) },
        });
      }
      return json({
        object: "operator_status",
        operator_session: live ? session() : null,
        user: account,
        setup_required: setupRequired,
        console_unclaimed: !!options.unclaimed,
      });
    }
    if (url.includes("/v1/operator_sessions/setup")) {
      live = true;
      setupRequired = false;
      account = ACCOUNT;
      return json({ object: "operator_status", operator_session: session(), user: ACCOUNT, setup_required: false, console_unclaimed: false }, 201);
    }
    if (url.includes("/v1/operator_sessions/from_user") && options.openRetryAfter !== undefined) {
      return new Response(JSON.stringify({ errors: [{ code: "rate_limit_exceeded", message: "Too many requests. Please try again later." }] }), {
        status: 429,
        headers: { "Content-Type": "application/json", "Retry-After": String(options.openRetryAfter) },
      });
    }
    if (url.includes("/v1/operator_sessions/from_user")) {
      if (!account?.console_access) return json({ errors: [{ code: "not_allowed_access", message: "No console access" }] }, 403);
      live = true;
      return json({ object: "operator_status", operator_session: session(), user: account, setup_required: false, console_unclaimed: false }, 201);
    }
    if (url.endsWith("/health")) return json(options.health ?? { status: "ok", publishable_key: "pk_test_demo" });
    if (url.includes("/v1/stats")) return json(STATS);
    if (url.includes("/v1/instance")) return json(INSTANCE);
    if (url.includes("/v1/users")) return json({ data: [], total_count: 0 });
    return json({ data: [], total_count: 0 });
  });
  /** What the SDK sign-in does from the server's point of view: the browser now has an account session. */
  const signInAccount = (next: typeof ACCOUNT) => {
    account = next;
  };
  const lift = () => {
    limited = false;
  };
  return { mock, calls, signInAccount, lift };
}

function renderApp(initialEntry: string) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[initialEntry]}>
        <AuthProvider>
          <App />
        </AuthProvider>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("login guard", () => {
  it("redirects unauthenticated visitors to the account sign-in", async () => {
    mockApi();
    renderApp("/");
    expect(await screen.findByRole("button", { name: "Account sign-in form" })).toBeTruthy();
    expect(document.title).toBe("Sign in \u00b7 OrbitID");
  });

  it("shows only the sign-in form to a signed-out visitor", async () => {
    mockApi();
    renderApp("/");
    const form = await screen.findByRole("button", { name: "Account sign-in form" });
    const main = screen.getByRole("main", { name: "Sign in" });
    // The form is the page: no visible heading, instructions or help around it. The only addition is a heading that
    // only assistive technology announces.
    const heading = screen.getByRole("heading", { level: 1, name: "Sign in" });
    expect(heading.className).toContain("sr-only");
    expect(main.textContent).toBe(`${heading.textContent}${form.textContent}`);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("banner")).toBeNull();
    expect(screen.queryByText(/console/i)).toBeNull();
  });

  it("never offers the secret key as a way in", async () => {
    mockApi();
    renderApp("/login");
    await screen.findByRole("button", { name: "Account sign-in form" });
    expect(screen.queryByRole("button", { name: /secret key/i })).toBeNull();
    expect(screen.queryByLabelText("Secret key")).toBeNull();
    expect(screen.queryByText(/secret key/i)).toBeNull();
  });

  it("guards nested routes as well", async () => {
    mockApi();
    renderApp("/users");
    expect(await screen.findByRole("button", { name: "Account sign-in form" })).toBeTruthy();
  });

  it("names the problem when the instance does not answer, and checks again on request", async () => {
    let reachable = false;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (!reachable && url.includes("/operator_sessions")) throw new TypeError("Failed to fetch");
      if (url.includes("/operator_sessions/status")) {
        return json({ object: "operator_status", operator_session: null, user: null, setup_required: true });
      }
      return json({ status: "ok", publishable_key: "pk_test_demo" });
    });
    renderApp("/login");

    expect(await screen.findByText("Could not check your session")).toBeTruthy();
    expect(screen.getByText("Failed to fetch")).toBeTruthy();
    reachable = true;
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    expect(await screen.findByText("Create the owner account")).toBeTruthy();
    expect(screen.queryByText("Could not check your session")).toBeNull();
  });

  it("says how long to wait when the session check is rate limited", async () => {
    const { lift } = mockApi({ statusRetryAfter: 30 });
    renderApp("/login");
    expect(await screen.findByText("Could not check your session")).toBeTruthy();
    expect(screen.getByText("Too many attempts. Try again in 30 seconds.")).toBeTruthy();
    lift();
    fireEvent.click(screen.getByRole("button", { name: /Try again/ }));
    await waitFor(() => expect(screen.queryByText("Could not check your session")).toBeNull());
  });

  it("says it is checking the session before deciding where to go", async () => {
    mockApi({ sessionActive: true });
    renderApp("/");
    expect(await screen.findByText("Checking your session…")).toBeTruthy();
  });

  it("renders the shell when the cookie session is live, without any key in storage", async () => {
    mockApi({
      sessionActive: true,
      account: ACCOUNT,
      health: { status: "ok", database: "postgres", database_driver: "postgres", publishable_key: "pk_test_demo" },
    });
    renderApp("/");
    expect(await screen.findAllByText("Overview")).not.toHaveLength(0);
    expect(screen.queryByRole("button", { name: "Account sign-in form" })).toBeNull();
    expect(await screen.findByText("Postgres")).toBeTruthy();
    expect(document.title).toBe("Overview \u00b7 OrbitID");
    expect(JSON.stringify(sessionStorage)).not.toContain("sk_");
  });
});

describe("account console access", () => {
  it("lets the first visitor of a fresh instance create the owner and enter the console", async () => {
    const { calls } = mockApi({ setupRequired: true });
    renderApp("/");

    expect(await screen.findByText("Create the owner account")).toBeTruthy();
    fireEvent.change(screen.getByLabelText("First name"), { target: { value: "Ada" } });
    fireEvent.change(screen.getByLabelText("Email address"), { target: { value: "ada@example.com" } });
    fireEvent.change(screen.getByLabelText("Password"), { target: { value: "correct horse battery staple" } });
    fireEvent.click(screen.getByRole("button", { name: "Create owner and open the console" }));

    expect(await screen.findAllByText("Overview")).not.toHaveLength(0);
    const setup = calls.find((call) => call.url.includes("/v1/operator_sessions/setup"))!;
    expect(setup.body).toEqual({ first_name: "Ada", email_address: "ada@example.com", password: "correct horse battery staple" });
    // The console names the account instead of a generic operator.
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
  });

  it("shows who is signed in and opens the console for an account with access", async () => {
    const { calls } = mockApi({ account: ACCOUNT });
    renderApp("/");

    expect(await screen.findByText("You are signed in")).toBeTruthy();
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Open the admin console/ }));

    expect(await screen.findAllByText("Overview")).not.toHaveLength(0);
    expect(calls.some((call) => call.method === "POST" && call.url.includes("/from_user"))).toBe(true);
  });

  it("tells a signed-in account without access why it cannot enter", async () => {
    mockApi({ account: { ...ACCOUNT, console_access: false } });
    renderApp("/");

    expect(await screen.findByText("No access to the console")).toBeTruthy();
    expect(screen.getByText("No console access")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Open the admin console/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Sign out" })).toBeTruthy();
  });

  it("goes straight into the console after signing in with an account that has access", async () => {
    const { calls, signInAccount } = mockApi();
    renderApp("/");
    const form = await screen.findByRole("button", { name: "Account sign-in form" });
    signInAccount(ACCOUNT);
    fireEvent.click(form);
    expect(await screen.findAllByText("Overview")).not.toHaveLength(0);
    expect(calls.some((call) => call.method === "POST" && call.url.includes("/from_user"))).toBe(true);
  });

  it("keeps the signed-out page to the form even when no account can open the console", async () => {
    mockApi({ unclaimed: true });
    renderApp("/");
    expect(await screen.findByRole("button", { name: "Account sign-in form" })).toBeTruthy();
    expect(screen.queryByText("No account can open the console yet")).toBeNull();
  });

  it("fills in the signed-in account's email for the server-side grant", async () => {
    mockApi({ unclaimed: true, account: { ...ACCOUNT, console_access: false } });
    renderApp("/");
    expect(await screen.findByText("No access to the console")).toBeTruthy();
    expect(screen.getByText("orbitid owner ada@example.com")).toBeTruthy();
  });

  it("keeps the form and says why when the session check fails right after signing in", async () => {
    const { mock } = mockApi();
    renderApp("/");
    const form = await screen.findByRole("button", { name: "Account sign-in form" });
    mock.mockImplementation(async () => {
      throw new TypeError("Failed to fetch");
    });
    fireEvent.click(form);
    expect(await screen.findByText("Could not open the console")).toBeTruthy();
    expect(screen.getByRole("main", { name: "Sign in" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Account sign-in form" })).toBeTruthy();
  });

  it("shows why the console did not open after signing in", async () => {
    const { signInAccount } = mockApi({ openRetryAfter: 20 });
    renderApp("/");
    const form = await screen.findByRole("button", { name: "Account sign-in form" });
    signInAccount(ACCOUNT);
    fireEvent.click(form);
    expect(await screen.findByText("You are signed in")).toBeTruthy();
    expect(await screen.findByText("Too many attempts. Try again in 20 seconds.")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Open the admin console/ })).toBeTruthy();
  });
});
