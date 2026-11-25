import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { SessionJSON, TrustedDeviceJSON, UserJSON } from "@orbitid/shared";
import UserDetailPage from "./user-detail";

const USER: UserJSON = {
  object: "user",
  roles: [],
  role_permissions: [],
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
  totp_enabled: true,
  backup_code_enabled: false,
  two_factor_enabled: true,
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
  is_anonymous: false,
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

const DEVICE: TrustedDeviceJSON = {
  object: "trusted_device",
  id: "tdev_1",
  user_id: "user_1",
  label: "Trusted browser",
  user_agent: "Mozilla/5.0",
  ip_address: "203.0.113.7",
  expires_at: 1_790_000_000_000,
  last_used_at: 1_789_000_000_000,
  revoked_at: null,
  created_at: 1_788_000_000_000,
  updated_at: 1_789_000_000_000,
};

const SESSION: SessionJSON = {
  object: "session",
  id: "sess_1",
  status: "active",
  sign_in_method: "password",
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
  second_factor_skipped_by_trusted_device: true,
  last_active_token: null,
  latest_activity: null,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

interface MockOptions {
  user?: Partial<UserJSON>;
  devices?: TrustedDeviceJSON[];
  deviceStatus?: number;
  emailSecondFactor?: boolean;
  trustedDevicesEnabled?: boolean;
  organizationsEnabled?: boolean;
}

/** Answers the user, instance, trusted-device and session calls the detail page makes. */
function mockUserDetail(options: MockOptions = {}) {
  const calls: Array<{ method: string; url: string }> = [];
  const user = { ...USER, ...options.user };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    calls.push({ method, url });
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

    if (url.endsWith("/trusted_devices") && method === "GET") {
      return json(options.devices ?? []);
    }
    if (url.includes("/trusted_devices/") && method === "DELETE") {
      return json({ object: "trusted_device", id: "tdev_1", deleted: true });
    }
    if (url.includes("/v1/sessions")) {
      return json({ data: [SESSION], total_count: 1 });
    }
    if (url.includes("/v1/audit_logs")) {
      return json({ data: [], total_count: 0 });
    }
    if (url.includes("/v1/instance")) {
      return json({
        attributes: { emailAddress: { usedForSecondFactor: options.emailSecondFactor ?? false } },
        session: { trustedDevicesEnabled: options.trustedDevicesEnabled ?? true, trustedDeviceDays: 30 },
        organizations: { enabled: options.organizationsEnabled ?? false },
      });
    }
    if (url.includes("/v1/users/user_1")) {
      return json(user);
    }
    return json({ data: [], total_count: 0 });
  });
  return calls;
}

function renderDetail(path = "/users/user_1") {
  sessionStorage.setItem("orbitid.apiUrl", "http://localhost:4000");
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[path]}>
        <Routes>
          <Route path="/users/:id" element={<UserDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("user detail: guest accounts", () => {
  it("explains what a guest account is and marks the header", async () => {
    mockUserDetail({ user: { is_anonymous: true, password_enabled: false } });
    renderDetail();

    expect(await screen.findByText("Guest account")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    expect(
      screen.getByText(/It becomes a registered account the moment it gains a verified email address/),
    ).toBeTruthy();
    // The generic "Active" chip would contradict a guest header; only the Guest chip is shown.
    expect(screen.queryByText("Active")).toBeNull();
  });

  it("shows no guest notice for a registered account", async () => {
    mockUserDetail();
    renderDetail();

    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    expect(screen.queryByText("Guest account")).toBeNull();
    // The email in the header is body copy, not a monospace identifier.
    expect(screen.getByText("ada@example.com").className).not.toContain("font-data");
  });
});

describe("user detail: trusted devices", () => {
  it("lists a device with label, address, last use and expiry, then revokes it after confirmation", async () => {
    const calls = mockUserDetail({ devices: [DEVICE] });
    renderDetail("/users/user_1?tab=devices");

    expect(await screen.findByText("Trusted browser")).toBeTruthy();
    expect(screen.getByText("203.0.113.7")).toBeTruthy();
    expect(screen.getByText("tdev_1")).toBeTruthy();
    // The expiry column renders a real date rather than a raw timestamp.
    expect(screen.getByText(/Sep 21, 2026/)).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Revoke" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Revoke Trusted browser?");
    expect(dialog.textContent).toContain("must complete the second factor on its next sign-in");

    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke device" }));
    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/v1/users/user_1/trusted_devices/tdev_1"))).toBe(
        true,
      );
    });
  });

  it("says what the empty list means", async () => {
    mockUserDetail({ devices: [] });
    renderDetail("/users/user_1?tab=devices");

    expect(await screen.findByText("No trusted devices")).toBeTruthy();
    expect(screen.getByText(/Nothing skips the second factor for this account now/)).toBeTruthy();
  });

  it("offers a retry when the device list fails", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.endsWith("/trusted_devices")) {
        return json({ errors: [{ code: "internal_server_error", message: "Server error" }] }, 500);
      }
      if (url.includes("/v1/instance")) {
        return json({ attributes: { emailAddress: { usedForSecondFactor: false } }, session: {} });
      }
      if (url.includes("/v1/users/user_1")) return json(USER);
      return json({ data: [], total_count: 0 });
    });
    renderDetail("/users/user_1?tab=devices");

    expect(await screen.findByText("Could not load this list")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });
});

describe("user detail: second factor summary", () => {
  it("lists email code as a second factor when the instance offers it", async () => {
    mockUserDetail({ emailSecondFactor: true });
    renderDetail("/users/user_1?tab=security");

    expect(await screen.findByText("Email code")).toBeTruthy();
    expect(screen.getByText("Offered as a second factor")).toBeTruthy();
    expect(screen.getByText(/never offered when the first factor was already an email code or link/)).toBeTruthy();
  });

  it("says email code is not offered when the setting is off", async () => {
    mockUserDetail({ emailSecondFactor: false });
    renderDetail("/users/user_1?tab=security");

    expect(await screen.findByText("Email code")).toBeTruthy();
    expect(screen.getByText("Not offered")).toBeTruthy();
  });

  it("points to the sessions setting when trusted devices are off", async () => {
    mockUserDetail({ trustedDevicesEnabled: false });
    renderDetail("/users/user_1?tab=security");

    expect(await screen.findByText(/Trusted devices are off on this instance/)).toBeTruthy();
  });

  it("marks a session that skipped the second factor on a trusted device", async () => {
    mockUserDetail();
    renderDetail("/users/user_1?tab=sessions");

    // The Sessions tab mounts only after the user record arrives, so wait for each phase on its own:
    // the header first, then the session list the tab fetches. One wait would have to cover both
    // serialized request/render rounds inside the same async window.
    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    expect(await screen.findByText("Second factor skipped: trusted device")).toBeTruthy();
  });

  it("revokes every active session, not only the page the operator can see", async () => {
    const calls: Array<{ method: string; url: string }> = [];
    const second = { ...SESSION, id: "sess_2", second_factor_skipped_by_trusted_device: false };
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      calls.push({ method: init?.method ?? "GET", url });
      const json = (body: unknown, status = 200) =>
        new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
      if (url.includes("/v1/sessions")) {
        // The visible page shows one row; the revoke-all helper reads the live active list at 100.
        return json(url.includes("limit=100") ? { data: [SESSION, second], total_count: 2 } : { data: [SESSION], total_count: 2 });
      }
      if (url.includes("/v1/instance")) return json({ attributes: {}, session: {} });
      if (url.includes("/v1/users/user_1")) return json(USER);
      return json({ data: [], total_count: 0 });
    });
    renderDetail("/users/user_1?tab=sessions");

    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    fireEvent.click(await screen.findByRole("button", { name: "Revoke active sessions" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("every device");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/sessions/sess_2/revoke"))).toBe(true);
    });
  });
});

describe("user detail: operator actions", () => {
  it("offers no impersonation, in the header or the actions menu", async () => {
    mockUserDetail();
    renderDetail();

    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Impersonate" })).toBeNull();

    fireEvent.keyDown(screen.getByRole("button", { name: "Actions for Ada Lovelace" }), { key: "Enter" });
    expect(await screen.findByRole("menuitem", { name: /Copy user ID/ })).toBeTruthy();
    expect(screen.queryByRole("menuitem", { name: /Impersonate/ })).toBeNull();
  });
});

describe("user detail: organizations tab", () => {
  it("is hidden while organizations are off, and a deep link falls back to the profile", async () => {
    mockUserDetail({ organizationsEnabled: false });
    renderDetail("/users/user_1?tab=organizations");

    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    expect(screen.queryByRole("tab", { name: "Organizations" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "App access" })).toBeNull();
    expect(await screen.findByLabelText("First name")).toBeTruthy();
  });

  it("is shown once organizations are on", async () => {
    mockUserDetail({ organizationsEnabled: true });
    renderDetail();

    expect(await screen.findByRole("tab", { name: "Organizations" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: "App access" })).toBeTruthy();
  });
});

describe("user detail: danger zone", () => {
  it("deletes the user from the detail page only after confirmation", async () => {
    const calls = mockUserDetail();
    renderDetail("/users/user_1?tab=danger");

    expect(await screen.findByRole("heading", { name: "Ada Lovelace" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete user" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete this user permanently?");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete user" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/v1/users/user_1"))).toBe(true);
    });
  });
});

it("offers no operator password or MFA replacement controls", async () => {
  mockUserDetail();
  renderDetail("/users/user_1?tab=security");
  expect(await screen.findByText(/Password changes and recovery must be completed by the user/)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Change password|Set password|Remove password|Reset MFA/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Sign out everywhere" })).toBeTruthy();
});
