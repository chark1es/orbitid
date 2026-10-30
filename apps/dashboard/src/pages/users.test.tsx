import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, Route, Routes } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { UserJSON } from "@orbitid/shared";
import UsersPage from "./users";

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

describe("users table", () => {
  it("navigates server-side pages through the query string", async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requested.push(url);
      const body = url.includes("/v1/users")
        ? { data: [USER], total_count: 45 }
        : url.includes("/v1/instance")
          ? { application: { homeUrl: "http://localhost:3000" } }
          : { data: [], total_count: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/users"]}>
          <Routes>
            <Route path="/users" element={<UsersPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(requested.some((url) => url.includes("/v1/users?limit=20&offset=0&order_by=-created_at"))).toBe(true);
    expect(screen.getByText("Showing 1–20 of 45")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Next page" }));

    await waitFor(() => {
      expect(requested.some((url) => url.includes("/v1/users?limit=20&offset=20&order_by=-created_at"))).toBe(true);
    });
    expect(await screen.findByText("Showing 21–40 of 45")).toBeTruthy();
  });

  it("keeps both status filters out of the URL when one is chosen", async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requested.push(url);
      const body = url.includes("/v1/users")
        ? { data: [USER], total_count: 1 }
        : url.includes("/v1/instance")
          ? { application: { homeUrl: "http://localhost:3000" } }
          : { data: [], total_count: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/users"]}>
          <Routes>
            <Route path="/users" element={<UsersPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();

    const trigger = screen.getByRole("combobox", { name: "Filter users by status" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Locked" }));

    await waitFor(() => {
      expect(requested.some((url) => url.includes("/v1/users") && url.includes("locked=true"))).toBe(true);
    });
    expect(requested.some((url) => url.includes("locked=true") && url.includes("banned=true"))).toBe(false);
  });

  it("marks guest accounts and filters the list by account type", async () => {
    const GUEST: UserJSON = {
      ...USER,
      id: "user_guest",
      username: null,
      first_name: null,
      last_name: null,
      primary_email_address_id: null,
      email_addresses: [],
      password_enabled: false,
      is_anonymous: true,
    };
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requested.push(url);
      const body = url.includes("/v1/users")
        ? { data: [USER, GUEST], total_count: 2 }
        : url.includes("/v1/instance")
          ? { application: { homeUrl: "http://localhost:3000" } }
          : { data: [], total_count: 0 };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/users"]}>
          <Routes>
            <Route path="/users" element={<UsersPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Guest")).toBeTruthy();
    // A registered user keeps the plain status chip, so the word Guest is never ambiguous.
    expect(screen.getAllByText("Active")).toHaveLength(1);

    const trigger = screen.getByRole("combobox", { name: "Filter users by account type" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Guests" }));

    await waitFor(() => {
      expect(requested.some((url) => url.includes("/v1/users") && url.includes("is_anonymous=true"))).toBe(true);
    });

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Filter users by account type" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Registered" }));
    await waitFor(() => {
      expect(requested.some((url) => url.includes("/v1/users") && url.includes("is_anonymous=false"))).toBe(true);
    });
  });

  it("confirms a bulk delete against the selected user", async () => {
    sessionStorage.setItem("orbitid.apiUrl", "http://localhost:4000");
    const methods: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      methods.push(`${init?.method ?? "GET"} ${url}`);
      const body = url.includes("/v1/users")
        ? { data: [USER], total_count: 1 }
        : { application: { homeUrl: "http://localhost:3000" } };
      return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
    });

    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/users"]}>
          <Routes>
            <Route path="/users" element={<UsersPage />} />
          </Routes>
        </MemoryRouter>
      </QueryClientProvider>,
    );

    fireEvent.click(await screen.findByRole("checkbox", { name: "Select Ada Lovelace" }));
    expect((await screen.findByRole("region", { name: "Bulk actions" })).textContent).toContain("1 selected");

    fireEvent.click(screen.getByRole("button", { name: "Delete" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete 1 user?");
    expect(dialog.textContent).toContain("removed permanently");

    fireEvent.click(screen.getByRole("button", { name: "Delete users" }));
    await waitFor(() => {
      expect(methods).toContain("DELETE http://localhost:4000/v1/users/user_1");
    });
  });
});
