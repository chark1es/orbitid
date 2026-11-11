import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { OrganizationJSON, OrganizationMembershipJSON, UserJSON } from "@orbitid/shared";
import { OrganizationMembersTab } from "./organization-members-tab";
import { mockApi, renderPage, type ApiCall } from "../../pages/_config/__tests__/harness";

const ORG = { id: "org_1", name: "Acme", slug: "acme" } as OrganizationJSON;

const MEMBERSHIP = {
  id: "mem_1",
  role: "org:member",
  permissions: ["org:sys_memberships:read"],
  public_user_data: {
    user_id: "user_1",
    identifier: "ada@example.com",
    first_name: "Ada",
    last_name: "Lovelace",
    image_url: "",
  },
  created_at: 1_700_000_000_000,
} as unknown as OrganizationMembershipJSON;

const USER = {
  id: "user_2",
  first_name: "Grace",
  last_name: "Hopper",
  email_addresses: [{ email_address: "grace@example.com" }],
  username: "grace",
  image_url: "",
} as unknown as UserJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const list = (data: unknown[], total = data.length) => json({ data, total_count: total });

function renderTab(rows: unknown[] = [MEMBERSHIP], custom?: (call: ApiCall) => Response | undefined) {
  const calls = mockApi({
    handle: (call) => {
      const handled = custom?.(call);
      if (handled) return handled;
      if (call.url.includes("/v1/users?")) return list([USER], 1);
      if (call.method === "GET" && call.url.includes("/v1/organizations/org_1/memberships")) return list(rows);
      return undefined;
    },
  });
  const onChanged = vi.fn();
  renderPage(<OrganizationMembersTab org={ORG} onChanged={onChanged} />);
  return { calls, onChanged };
}

describe("organization members tab", () => {
  it("renders members with their role and joined date", async () => {
    renderTab();
    expect(await screen.findByText("Ada Lovelace")).toBeTruthy();
    expect(screen.getByText("ada@example.com")).toBeTruthy();
    expect(screen.getByRole("combobox", { name: "Membership role" })).toBeTruthy();
  });

  it("shows the empty state", async () => {
    renderTab([]);
    expect(await screen.findByText("No members yet")).toBeTruthy();
  });

  it("adds an existing user with the chosen role", async () => {
    const { calls, onChanged } = renderTab([]);
    await screen.findByText("No members yet");

    fireEvent.click(screen.getAllByRole("button", { name: /Add member/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Find user"), { target: { value: "grace" } });
    fireEvent.click(await within(dialog).findByRole("button", { name: /Grace Hopper/ }));

    const role = within(dialog).getByRole("combobox", { name: "Role" });
    role.focus();
    fireEvent.keyDown(role, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Admin" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "Add member" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/organizations/org_1/memberships"))?.body).toEqual({
        user_id: "user_2",
        role: "org:admin",
      });
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("changes a member role with PATCH", async () => {
    const { calls } = renderTab();
    await screen.findByText("Ada Lovelace");

    const role = screen.getByRole("combobox", { name: "Membership role" });
    role.focus();
    fireEvent.keyDown(role, { key: "Enter" });
    fireEvent.click(await screen.findByRole("option", { name: "Admin" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH" && call.url.endsWith("/v1/organizations/org_1/memberships/user_1"))?.body).toEqual({
        role: "org:admin",
      });
    });
  });

  it("removes a member only after confirmation", async () => {
    const { calls, onChanged } = renderTab();
    await screen.findByText("Ada Lovelace");

    fireEvent.click(screen.getByRole("button", { name: "Remove ada@example.com" }));
    expect(screen.getByText("Remove member?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Remove member" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/v1/organizations/org_1/memberships/user_1"))).toBe(true);
    });
    expect(onChanged).toHaveBeenCalled();
  });
});
