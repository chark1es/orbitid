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
  it("labels every filter in the bar, including the date fields", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      const body = url.includes("/v1/users") ? { data: [USER], total_count: 1 } : { application: { homeUrl: "" } };
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

    expect(await screen.findByLabelText("Search")).toBeTruthy();
    // An email address is not an id or a key: it reads in the sans family, not 11px monospace.
    const email = await screen.findByText("ada@example.com");
    expect(email.className).not.toContain("font-data");
    expect(email.className).toContain("text-[0.8125rem]");
    expect(screen.getByRole("combobox", { name: "Status" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "MFA" })).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Account type" })).toBeTruthy();
    for (const name of ["Search", "Status", "MFA", "Account type", "Created after", "Created before"]) {
      const label = screen.getByText(name, { selector: "label" });
      expect(label.className, `${name} label`).toContain("text-[0.75rem]");
      expect(label.className).toContain("font-medium");
      expect(label.className).not.toContain("uppercase");
    }
    for (const name of ["Created after", "Created before"]) {
      const input = screen.getByLabelText(name) as HTMLInputElement;
      // The native picker must remain: only its glyph is hidden under the select-style chevron.
      expect(input.getAttribute("type")).toBe("date");
      expect(input.className).toContain("text-sm");
      expect(input.className).not.toContain("text-[0.8125rem]");
      expect(input.className).toContain("::-webkit-calendar-picker-indicator");
      expect(input.parentElement?.querySelector("svg")).toBeTruthy();
    }
  });

  it("commits a date filter only once the typed date is complete", async () => {
    const requested: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      requested.push(url);
      const body = url.includes("/v1/users") ? { data: [USER], total_count: 1 } : { application: { homeUrl: "" } };
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

    await screen.findByText("ada@example.com");
    const input = screen.getByLabelText("Created after") as HTMLInputElement;

    // Typing the year 2026 goes through 0002, 0020 and 0202. None of those may reach the URL,
    // or the controlled value is replaced mid-entry and the rest of the year is lost.
    for (const draft of ["0002-01-15", "0020-01-15", "0202-01-15"]) {
      fireEvent.change(input, { target: { value: draft } });
      expect(input.value).toBe(draft);
      expect(requested.some((url) => url.includes("created_at_after"))).toBe(false);
      expect(screen.queryByRole("button", { name: "Clear" })).toBeNull();
    }

    fireEvent.change(input, { target: { value: "2026-01-15" } });
    await waitFor(() => expect(requested.some((url) => url.includes("created_at_after="))).toBe(true));
    expect(await screen.findByRole("button", { name: "Clear" })).toBeTruthy();

    fireEvent.change(input, { target: { value: "" } });
    await waitFor(() => expect(screen.queryByRole("button", { name: "Clear" })).toBeNull());
    expect(requested.at(-1)).not.toContain("created_at_after");
  });

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

    const trigger = screen.getByRole("combobox", { name: "Status" });
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

    const trigger = screen.getByRole("combobox", { name: "Account type" });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Guests" }));

    await waitFor(() => {
      expect(requested.some((url) => url.includes("/v1/users") && url.includes("is_anonymous=true"))).toBe(true);
    });

    fireEvent.keyDown(screen.getByRole("combobox", { name: "Account type" }), { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Registered" }));
    await waitFor(() => {
      expect(requested.some((url) => url.includes("/v1/users") && url.includes("is_anonymous=false"))).toBe(true);
    });
  });

  it("toggles order_by from a column header and exposes aria-sort", async () => {
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

    await screen.findByText("Ada Lovelace");
    expect(screen.getByRole("button", { name: "Sort by Username" }).closest("th")?.getAttribute("aria-sort")).toBe("none");
    // Username is the first column to go: it keeps the row inside 768/1024 without hiding the actions.
    const usernameHeader = screen.getByRole("button", { name: "Sort by Username" }).closest("th")!;
    expect(usernameHeader.className).toContain("hidden");
    expect(usernameHeader.className).toContain("xl:table-cell");

    fireEvent.click(screen.getByRole("button", { name: "Sort by Username" }));
    await waitFor(() => {
      expect(requested.some((url) => url.includes("/v1/users?") && url.includes("order_by=username"))).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Sort by Username" }).closest("th")?.getAttribute("aria-sort")).toBe("ascending");

    fireEvent.click(screen.getByRole("button", { name: "Sort by Username" }));
    await waitFor(() => {
      expect(requested.some((url) => url.includes("/v1/users?") && url.includes("order_by=-username"))).toBe(true);
    });
    expect(screen.getByRole("button", { name: "Sort by Username" }).closest("th")?.getAttribute("aria-sort")).toBe(
      "descending",
    );
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
