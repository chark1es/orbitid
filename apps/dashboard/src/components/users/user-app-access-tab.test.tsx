import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { UserJSON } from "@orbitid/shared";
import { UserAppAccessTab } from "./user-app-access-tab";
import { mockApi, renderPage } from "../../pages/_config/__tests__/harness";

const USER = { id: "user_1", first_name: "Ada", last_name: "Lovelace", email_addresses: [] } as unknown as UserJSON;

const APPS = [
  { object: "oauth_application", id: "oa_wiki", name: "Wiki", client_id: "client_wiki", organization_id: "org_acme", created_at: 1 },
  { object: "oauth_application", id: "oa_crm", name: "CRM", client_id: "client_crm", organization_id: "org_beta", created_at: 1 },
  { object: "oauth_application", id: "oa_open", name: "Portal", client_id: "client_open", organization_id: null, created_at: 1 },
];
const ORGS = [
  { object: "organization", id: "org_acme", name: "Acme" },
  { object: "organization", id: "org_beta", name: "Beta" },
];

function mockAccess(grants: Array<{ application_id: string }>) {
  return mockApi({
    handle: (call) => {
      if (call.url.includes("/v1/users/user_1/oauth_application_access_grants")) {
        return Response.json({
          data: grants.map((grant) => ({ object: "oauth_application_access_grant", user_id: "user_1", created_at: 1_700_000_000_000, ...grant })),
          total_count: grants.length,
        });
      }
      if (call.url.includes("/access_grants") && call.method === "POST") {
        return Response.json({ object: "oauth_application_access_grant", application_id: "oa_crm", user_id: "user_1", created_at: 2 }, { status: 201 });
      }
      if (call.url.includes("/access_grants/") && call.method === "DELETE") {
        return Response.json({ object: "oauth_application_access_grant", application_id: "oa_wiki", user_id: "user_1", deleted: true });
      }
      if (call.url.includes("/v1/oauth_applications")) return Response.json({ data: APPS, total_count: APPS.length });
      if (call.url.includes("/v1/organizations")) return Response.json({ data: ORGS, total_count: ORGS.length });
      return undefined;
    },
  });
}

describe("user application access", () => {
  it("lists cross-organization grants with their owning organization", async () => {
    mockAccess([{ application_id: "oa_wiki" }]);
    renderPage(<UserAppAccessTab user={USER} />);

    expect(await screen.findByText("Wiki")).toBeTruthy();
    expect(await screen.findByRole("link", { name: "Acme" })).toBeTruthy();
    expect(screen.getByText("client_wiki")).toBeTruthy();
  });

  it("offers only organization applications the user has no grant for, and grants one", async () => {
    const calls = mockAccess([{ application_id: "oa_wiki" }]);
    renderPage(<UserAppAccessTab user={USER} />);
    await screen.findByText("Wiki");

    const trigger = screen.getByRole("combobox", { name: "Application to grant" });
    await waitFor(() => expect(trigger.hasAttribute("disabled")).toBe(false));
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "Enter" });
    const options = (await screen.findAllByRole("option")).map((option) => option.textContent);
    expect(options).toEqual(["CRM · Beta"]);
    fireEvent.click(screen.getByRole("option", { name: "CRM · Beta" }));
    fireEvent.click(screen.getByRole("button", { name: "Grant access" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST")).toMatchObject({
        url: expect.stringContaining("/v1/oauth_applications/oa_crm/access_grants"),
        body: { user_id: "user_1" },
      });
    });
  });

  it("revokes a grant after confirmation", async () => {
    const calls = mockAccess([{ application_id: "oa_wiki" }]);
    renderPage(<UserAppAccessTab user={USER} />);
    fireEvent.click(await screen.findByRole("button", { name: "Revoke" }));

    const dialog = await screen.findByRole("alertdialog").catch(() => screen.findByRole("dialog"));
    expect(dialog.textContent).toContain("Revoke access to Wiki?");
    expect(dialog.textContent).toContain("member of Acme");
    fireEvent.click(within(dialog).getByRole("button", { name: "Revoke access" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "DELETE")?.url).toContain(
        "/v1/oauth_applications/oa_wiki/access_grants/user_1",
      );
    });
  });

  it("explains the empty state", async () => {
    mockAccess([]);
    renderPage(<UserAppAccessTab user={USER} />);
    expect(await screen.findByText("No cross-organization access")).toBeTruthy();
  });
});
