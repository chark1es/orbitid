import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { PermissionJSON, RoleJSON } from "@orbitid/shared";
import Page from "./roles-permissions";
import { instanceBody, mockApi, renderPage } from "./_config/__tests__/harness";

const permission = (key: string): PermissionJSON => ({ object: "permission", id: key, key, name: key.toUpperCase(), description: "", scope: key.startsWith("app:") ? "instance" : "organization", type: "user", created_at: 0, updated_at: 0 });
const role = (key: string): RoleJSON => ({ object: "role", id: key, key, name: key.toUpperCase(), description: "", scope: key.startsWith("app:") ? "instance" : "organization", is_system: false, is_creator_eligible: false, permissions: [], created_at: 0, updated_at: 0 });
function setup(organizations: boolean) {
  return mockApi({ instance: instanceBody((settings) => { settings.organizations.enabled = organizations; }), handle: (call) => {
    if (call.method !== "GET") return;
    if (call.url.includes("/v1/roles")) return Response.json({ data: [role("app:support"), role("org:auditor")], total_count: 2 });
    if (call.url.includes("/v1/permissions")) return Response.json({ data: [permission("app:reports:read"), permission("org:reports:read")], total_count: 2 });
  } });
}

describe("role scopes", () => {
  it("creates an instance role while organizations are off and excludes organization permissions", async () => {
    const calls = setup(false);
    renderPage(<Page />);
    await screen.findByText("app:support");
    expect(screen.queryByText("org:auditor")).toBeNull();
    expect(screen.queryByRole("option", { name: "Organization" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Role" }));
    fireEvent.change(screen.getByLabelText(/Name/, { selector: "input" }), { target: { value: "Reviewer" } });
    // A fresh form is not an error state; the button stays live so the attempt can reveal the list.
    expect(screen.queryByText("Fix these before saving")).toBeNull();
    expect(screen.getByRole("button", { name: "Create role" }).hasAttribute("disabled")).toBe(false);
    fireEvent.change(screen.getByLabelText(/Role key/), { target: { value: "app:reviewer" } });
    expect(screen.queryByLabelText("Creator eligible")).toBeNull();
    expect(screen.queryByText("org:reports:read")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Create role" }));
    await waitFor(() => expect(calls.find((call) => call.method === "POST")?.body).toMatchObject({ key: "app:reviewer", is_creator_eligible: false }));
  });

  it("shows organization roles only when that scope is selected and enabled", async () => {
    setup(true);
    renderPage(<Page />);
    await screen.findByRole("option", { name: "Organization" });
    fireEvent.change(screen.getByLabelText("Role scope"), { target: { value: "org" } });
    expect(await screen.findByText("org:auditor")).toBeTruthy();
    expect(screen.queryByText("app:support")).toBeNull();
  });
});
