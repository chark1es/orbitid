import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type { SessionJSON, UserJSON } from "@orbitid/shared";
import OverviewPage from "./overview";

const USER: UserJSON = {
  object: "user",
  id: "user_1",
  external_id: null,
  username: "ada",
  first_name: "Ada",
  last_name: "Lovelace",
  image_url: "",
  has_image: false,
  primary_email_address_id: "idn_e_1",
  primary_phone_number_id: null,
  password_enabled: true,
  totp_enabled: false,
  backup_code_enabled: false,
  two_factor_enabled: false,
  passkeys: [],
  email_addresses: [
    {
      object: "email_address",
      id: "idn_e_1",
      email_address: "ada@example.com",
      verification: null,
      linked_to: [],
      reserved: false,
      created_at: 1_700_000_000_000,
      updated_at: 1_700_000_000_000,
    },
  ],
  phone_numbers: [],
  external_accounts: [],
  public_metadata: {},
  unsafe_metadata: {},
  banned: false,
  locked: false,
  lockout_expires_in_seconds: null,
  verification_attempts_remaining: 100,
  delete_self_enabled: true,
  create_organization_enabled: true,
  create_organizations_limit: null,
  last_sign_in_at: null,
  last_active_at: null,
  legal_accepted_at: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const SESSION: SessionJSON = {
  object: "session",
  id: "sess_1",
  status: "active",
  sign_in_method: null,
  expire_at: 1_700_100_000_000,
  abandon_at: 1_700_100_000_000,
  last_active_at: 1_700_000_500_000,
  last_active_organization_id: null,
  actor: null,
  user: null,
  public_user_data: {
    first_name: "Ada",
    last_name: "Lovelace",
    image_url: "",
    has_image: false,
    identifier: "ada@example.com",
    user_id: "user_1",
  },
  factor_verification_age: null,
  last_active_token: null,
  latest_activity: {
    id: "act_1",
    is_mobile: false,
    ip_address: "203.0.113.7",
    city: "Berlin",
    country: "DE",
    browser_name: "Chrome",
    browser_version: "128",
    device_type: "desktop",
  },
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const STATS = {
  users_total: 12,
  users_active_7d: 5,
  sessions_active: 3,
  organizations_total: 2,
  signups_by_day: [{ date: "2026-10-01", count: 4 }],
  signins_by_day: [{ date: "2026-10-01", count: 9 }],
  banned_users: 1,
  locked_users: 0,
  mfa_enabled_users: 3,
  top_social_providers: [],
};

function mockApi({ sessions, users }: { sessions: SessionJSON[]; users: UserJSON[] }) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const url = String(input);
    const body = url.includes("/health")
      ? { status: "ok", publishable_key: "pk_test_abc123" }
      : url.includes("/v1/stats")
        ? STATS
        : url.includes("/v1/sessions")
          ? { data: sessions }
          : url.includes("/v1/users")
            ? { data: users, total_count: users.length }
            : { application: { homeUrl: "https://app.example.com" } };
    return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
  });
}

function renderOverview() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <OverviewPage />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("overview", () => {
  it("puts recent sessions on the activity board", async () => {
    mockApi({ sessions: [SESSION], users: [USER] });
    renderOverview();

    expect(await screen.findByText("Berlin, DE · 203.0.113.7 · Chrome")).toBeTruthy();
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
    expect(screen.getByText("Success")).toBeTruthy();
    expect(screen.queryByText("No sign-ins yet")).toBeNull();
  });

  it("prints the publishable key and a copyable Next.js environment", async () => {
    mockApi({ sessions: [SESSION], users: [USER] });
    renderOverview();

    expect(await screen.findByText(/NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY=pk_test_abc123/)).toBeTruthy();
    expect(screen.getByText(/NEXT_PUBLIC_ORBITID_SIGN_IN_URL=https:\/\/app\.example\.com\/sign-in/)).toBeTruthy();
    expect(screen.getByText(/createOrbitIdClient/)).toBeTruthy();
    expect(screen.getAllByText("pk_test_abc123").length).toBeGreaterThan(0);
  });

  it("teaches the next step when there are no sign-ins and no users", async () => {
    mockApi({ sessions: [], users: [] });
    renderOverview();

    expect(await screen.findByText("No sign-ins yet")).toBeTruthy();
    expect(screen.getByText("Create a user or open the test site. Every new session lands here.")).toBeTruthy();
    expect(await screen.findByText("No users yet")).toBeTruthy();
  });
});
