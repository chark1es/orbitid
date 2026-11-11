import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import App from "../App";
import { AuthProvider } from "../lib/auth";

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

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

interface MockOptions {
  /** Report a live operator session on `GET /v1/operator_sessions/current`. */
  sessionActive?: boolean;
  /** Status for `POST /v1/operator_sessions`; 201 signs in. */
  exchangeStatus?: number;
  health?: Record<string, unknown>;
}

function mockApi(options: MockOptions = {}) {
  const calls: Array<{ method: string; url: string; body?: unknown }> = [];
  const mock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url, body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });

    if (url.includes("/v1/operator_sessions/current")) {
      return options.sessionActive
        ? json({ object: "operator_session", id: "osess_test", expires_at: Date.now() + 3_600_000 })
        : json({ errors: [{ code: "authentication_invalid", message: "No session" }] }, 401);
    }
    if (url.includes("/v1/operator_sessions") && method === "POST") {
      return options.exchangeStatus && options.exchangeStatus !== 201
        ? json({ errors: [{ code: "secret_key_invalid", message: "Invalid secret key" }] }, options.exchangeStatus)
        : json({ object: "operator_session", id: "osess_new", expires_at: Date.now() + 3_600_000 }, 201);
    }
    if (url.endsWith("/health")) return json(options.health ?? { status: "ok", publishable_key: "pk_test_demo" });
    if (url.includes("/v1/stats")) return json(STATS);
    if (url.includes("/v1/instance")) return json(INSTANCE);
    if (url.includes("/v1/users")) return json({ data: [], total_count: 0 });
    return json({ data: [], total_count: 0 });
  });
  return { mock, calls };
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
  it("redirects unauthenticated visitors to the sign-in screen", async () => {
    mockApi();
    renderApp("/");
    expect(await screen.findByText("Sign in with your secret key")).toBeTruthy();
    expect(document.title).toBe("Sign in \u00b7 OrbitID");
    expect(screen.getByLabelText("API URL")).toBeTruthy();
    expect(screen.getByLabelText("Secret key")).toBeTruthy();
  });

  it("guards nested routes as well", async () => {
    mockApi();
    renderApp("/users");
    expect(await screen.findByText("Sign in with your secret key")).toBeTruthy();
  });

  it("shows the database and publishable key from the health check before sign-in", async () => {
    mockApi({ health: { status: "ok", database: "postgres", publishable_key: "pk_test_demo" } });
    renderApp("/login");

    expect(await screen.findByText("Postgres")).toBeTruthy();
    expect(screen.getByText("pk_test_demo")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Show secret key" })).toBeTruthy();
  });

  it("tells the operator how to print the key rather than promising it in the startup log", async () => {
    mockApi({ sessionActive: false });
    renderApp("/login");

    expect((await screen.findAllByText(/orbitid keys/)).length).toBeGreaterThan(0);
    expect(screen.getByText(/Startup prints the publishable key and leaves the secret key hidden/)).toBeTruthy();
    expect(screen.queryByText(/Printed when the server starts/)).toBeNull();
    expect(screen.queryByText(/The first start prints the publishable key and the secret key once/)).toBeNull();
  });

  it("names the problem when the instance does not answer", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.includes("/operator_sessions")) {
        return json({ errors: [{ code: "authentication_invalid", message: "No session" }] }, 401);
      }
      if (url.endsWith("/health")) throw new TypeError("Failed to fetch");
      return json({ data: [], total_count: 0 });
    });
    renderApp("/login");

    expect(await screen.findByText(/No answer from/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Check again" })).toBeTruthy();
  });

  it("says it is checking the session before deciding where to go", async () => {
    mockApi({ sessionActive: true });
    renderApp("/");
    expect(await screen.findByText("Checking your session…")).toBeTruthy();
  });

  it("renders the shell when the cookie session is live, without any key in storage", async () => {
    mockApi({ sessionActive: true, health: { status: "ok", database: "sqlite", publishable_key: "pk_test_demo" } });
    renderApp("/");
    expect(await screen.findAllByText("Overview")).not.toHaveLength(0);
    expect(screen.queryByText("Sign in with your secret key")).toBeNull();
    expect(await screen.findByText("SQLite")).toBeTruthy();
    expect(document.title).toBe("Overview \u00b7 OrbitID");
    expect(JSON.stringify(sessionStorage)).not.toContain("sk_");
  });
});

describe("operator sign-in", () => {
  it("posts the key once, never stores it, and lands in the shell", async () => {
    const { calls } = mockApi({ sessionActive: false });
    renderApp("/login");

    fireEvent.change(await screen.findByLabelText("API URL"), { target: { value: window.location.origin } });
    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "sk_test_one_time" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findAllByText("Overview")).not.toHaveLength(0);

    const exchange = calls.find((call) => call.method === "POST" && call.url.includes("/v1/operator_sessions"))!;
    expect(exchange.body).toEqual({ secret_key: "sk_test_one_time" });
    // The key lived only in the form field: nothing persisted it before or after the exchange.
    expect(JSON.stringify(sessionStorage)).not.toContain("sk_test_one_time");
    expect(JSON.stringify(localStorage)).not.toContain("sk_test_one_time");
    expect(document.cookie).not.toContain("sk_test_one_time");
  });

  it("names a rejected key and stays on the sign-in screen", async () => {
    mockApi({ sessionActive: false, exchangeStatus: 401 });
    renderApp("/login");

    fireEvent.change(await screen.findByLabelText("API URL"), { target: { value: window.location.origin } });
    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "sk_test_wrong" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/The server rejected that secret key/)).toBeTruthy();
    expect(screen.getByText("Sign in with your secret key")).toBeTruthy();
    expect(JSON.stringify(sessionStorage)).not.toContain("sk_test_wrong");
  });

  it("refuses to sign in to another origin instead of sending the key there", async () => {
    const { calls } = mockApi({ sessionActive: false });
    renderApp("/login");

    fireEvent.change(await screen.findByLabelText("API URL"), { target: { value: "https://other.example.com" } });
    fireEvent.change(screen.getByLabelText("Secret key"), { target: { value: "sk_test_never_sent" } });
    fireEvent.click(screen.getByRole("button", { name: "Sign in" }));

    expect(await screen.findByText(/This build can only sign in to the instance that serves it/)).toBeTruthy();
    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.includes("/v1/operator_sessions"))).toBe(false);
    });
  });

  it("explains that the URL must be the instance that serves the dashboard", async () => {
    mockApi({ sessionActive: false });
    renderApp("/login");

    fireEvent.change(await screen.findByLabelText("API URL"), { target: { value: "https://other.example.com" } });
    expect(await screen.findByText(/This build can only sign in to the instance that serves it/)).toBeTruthy();
  });
});
