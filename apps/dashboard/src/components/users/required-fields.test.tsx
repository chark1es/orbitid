import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { UserJSON } from "@orbitid/shared";
import { instanceBody, mockApi, renderPage } from "../../pages/_config/__tests__/harness";
import { CreateUserDialog } from "./create-user-dialog";
import { UserIdentifiersTab } from "./user-identifiers-tab";
import { UserProfileTab } from "./user-profile-tab";

const EMAIL = {
  object: "email_address",
  id: "idn_e_1",
  email_address: "ada@example.com",
  verification: { status: "verified" },
  linked_to: [],
  reserved: false,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

const user = (overrides: Partial<UserJSON> = {}) =>
  ({
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
    email_addresses: [EMAIL],
    phone_numbers: [],
    external_accounts: [],
    passkeys: [],
    created_at: 1_700_000_000_000,
    updated_at: 1_700_000_000_000,
    ...overrides,
  }) as unknown as UserJSON;

describe("create user dialog: required attributes", () => {
  it("does not create a user while a required attribute is blank, and names it", async () => {
    const calls = mockApi({ instance: instanceBody() });
    renderPage(<CreateUserDialog open onOpenChange={() => undefined} />);

    // The create form is a sheet-width form (576px) with a two-column grid; the old 672px was an extra size.
    expect((await screen.findByRole("dialog")).className).toContain("sm:max-w-xl");
    // Email is required by default settings; wait for the instance settings to mark it.
    expect(await screen.findByText("(required)")).toBeTruthy();
    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Email address is required");
    expect(screen.getByLabelText(/Email address/).getAttribute("aria-invalid")).toBe("true");
    expect(calls.some((call) => call.method === "POST" && call.url.endsWith("/v1/users"))).toBe(false);
  });

  it("creates the user once the required attribute is filled", async () => {
    const calls = mockApi({ instance: instanceBody() });
    renderPage(<CreateUserDialog open onOpenChange={() => undefined} />);

    await screen.findByText("(required)");
    fireEvent.change(screen.getByLabelText(/Email address/), { target: { value: "ada@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/users"))?.body).toEqual({
        email_address: ["ada@example.com"],
      });
    });
  });

  it("cannot create a user while required settings are unknown", async () => {
    const calls = mockApi({ handle: (call) => (call.url.includes("/v1/instance") ? new Response("{}", { status: 500 }) : undefined) });
    renderPage(<CreateUserDialog open onOpenChange={() => undefined} />);

    fireEvent.change(screen.getByLabelText(/Username/), { target: { value: "ada" } });
    fireEvent.click(screen.getByRole("button", { name: "Create user" }));
    expect(await screen.findByText(/Required field settings could not be loaded/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Create user" }).hasAttribute("disabled")).toBe(true);
    expect(calls.some((call) => call.method === "POST")).toBe(false);
  });
});

describe("user profile tab: required attributes", () => {
  it("will not save a required name that has been cleared", async () => {
    const calls = mockApi({ instance: instanceBody((settings) => (settings.attributes.firstName.required = true)) });
    renderPage(<UserProfileTab user={user()} onUpdated={() => undefined} />);

    await screen.findByText("(required)");
    fireEvent.change(screen.getByLabelText(/First name/), { target: { value: "  " } });

    expect(screen.getByRole("alert").textContent).toContain("First name is required");
    const save = screen.getByRole("button", { name: /Save profile/ }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.submit(save.closest("form")!);
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });

  it("saves an optional name that has been cleared", async () => {
    const calls = mockApi({ instance: instanceBody() });
    renderPage(<UserProfileTab user={user()} onUpdated={() => undefined} />);

    fireEvent.change(screen.getByLabelText(/Last name/), { target: { value: "" } });
    await waitFor(() => expect(screen.getByRole("button", { name: /Save profile/ }).hasAttribute("disabled")).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: /Save profile/ }));
    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({ last_name: null });
    });
  });
});

describe("user identifiers tab", () => {
  it("shows identifiers without operator credential controls", async () => {
    const calls = mockApi();
    const second = { ...EMAIL, id: "idn_e_2", email_address: "ada@work.example" };
    renderPage(<UserIdentifiersTab user={user({ email_addresses: [EMAIL, second] as never })} onUpdated={() => undefined} />);
    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.getByText("ada@work.example")).toBeTruthy();
    expect(screen.queryByRole("button", { name: /Delete|Verify|Add|Primary/ })).toBeNull();
    expect(calls.some((call) => call.method !== "GET")).toBe(false);
  });
});
