import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
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

function mockApi() {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    if (url.endsWith("/health")) return json({ status: "ok", publishable_key: "pk_test_demo" });
    if (url.includes("/v1/stats")) return json(STATS);
    if (url.includes("/v1/instance")) return json(INSTANCE);
    if (url.includes("/v1/users")) return json({ data: [], total_count: 0 });
    return json({ data: [], total_count: 0 });
  });
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
  it("redirects unauthenticated visitors to the login screen", async () => {
    mockApi();
    renderApp("/");
    expect(await screen.findByText("Sign in to your instance")).toBeTruthy();
    expect(screen.getByLabelText("Instance URL")).toBeTruthy();
    expect(screen.getByLabelText("Secret key")).toBeTruthy();
  });

  it("guards nested routes as well", async () => {
    mockApi();
    renderApp("/users");
    expect(await screen.findByText("Sign in to your instance")).toBeTruthy();
  });

  it("renders the shell when a secret key is already stored", async () => {
    sessionStorage.setItem("orbitid.secretKey", "sk_test_existing");
    mockApi();
    renderApp("/");
    expect(await screen.findAllByText("Overview")).not.toHaveLength(0);
    expect(screen.queryByText("Sign in to your instance")).toBeNull();
    expect(await screen.findByText("Instance keys")).toBeTruthy();
  });
});
