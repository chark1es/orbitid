import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import type { OrganizationJSON } from "@orbitid/shared";
import { OrganizationSettingsTab } from "./organization-settings-tab";
import { mockApi, renderPage, type ApiCall } from "../../pages/_config/__tests__/harness";

const ORG = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  image_url: "",
  members_count: 12,
  pending_invitations_count: 2,
  max_allowed_memberships: 100,
  admin_delete_enabled: true,
  created_by: "user_1",
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
} as unknown as OrganizationJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function renderTab(org: OrganizationJSON = ORG) {
  const calls = mockApi({
    handle: (call: ApiCall) => {
      if (call.url.endsWith("/v1/organizations/org_1") && call.method !== "GET") return json({});
      return undefined;
    },
  });
  const onChanged = vi.fn();
  renderPage(
    <Routes>
      <Route path="/organizations/:id" element={<OrganizationSettingsTab org={org} onChanged={onChanged} />} />
      <Route path="/organizations" element={<p>Organization list</p>} />
    </Routes>,
    ["/organizations/org_1"],
  );
  return { calls, onChanged };
}

describe("organization settings tab", () => {
  it("saves name, slug, capacity and admin-delete in one PATCH", async () => {
    const { calls, onChanged } = renderTab();

    fireEvent.change(screen.getByLabelText("Name"), { target: { value: "  Acme Labs  " } });
    fireEvent.change(screen.getByLabelText("Slug"), { target: { value: "acme-labs" } });
    fireEvent.change(screen.getByLabelText("Max memberships"), { target: { value: "250" } });
    fireEvent.click(screen.getByRole("switch", { name: "Admins can delete" }));
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      const patch = calls.find((call) => call.method === "PATCH" && call.url.endsWith("/v1/organizations/org_1"));
      expect(patch?.body).toEqual({
        name: "Acme Labs",
        slug: "acme-labs",
        max_allowed_memberships: 250,
        admin_delete_enabled: false,
      });
    });
    expect(onChanged).toHaveBeenCalled();
  });

  it("deletes the organization only after the confirmation", async () => {
    const { calls } = renderTab();

    fireEvent.click(screen.getByRole("button", { name: "Delete organization" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Delete this organization permanently?");
    expect(calls.some((call) => call.method === "DELETE")).toBe(false);

    fireEvent.click(within(dialog).getByRole("button", { name: "Delete organization" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/v1/organizations/org_1"))).toBe(true);
    });
    expect(await screen.findByText("Organization list")).toBeTruthy();
  });

  it("sets the billing portal URL, and sends it only when it changed", async () => {
    const { calls } = renderTab();
    fireEvent.change(screen.getByLabelText("Billing portal URL"), { target: { value: " https://pay.example.com/acme " } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const patch = calls.find((call) => call.method === "PATCH" && call.url.endsWith("/v1/organizations/org_1"));
      expect(patch?.body).toMatchObject({ billing_portal_url: "https://pay.example.com/acme" });
    });
  });

  it("clears a configured billing portal with null", async () => {
    const { calls } = renderTab({ ...ORG, billing_portal_url: "https://pay.example.com/acme" } as OrganizationJSON);
    const input = screen.getByLabelText("Billing portal URL") as HTMLInputElement;
    expect(input.value).toBe("https://pay.example.com/acme");
    fireEvent.change(input, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
    await waitFor(() => {
      const patch = calls.find((call) => call.method === "PATCH" && call.url.endsWith("/v1/organizations/org_1"));
      expect(patch?.body).toMatchObject({ billing_portal_url: null });
    });
  });

  it("refuses a billing portal that is not https", () => {
    const { calls } = renderTab();
    fireEvent.change(screen.getByLabelText("Billing portal URL"), { target: { value: "http://pay.example.com" } });
    expect(screen.getByText("The billing portal URL must start with https://.")).toBeTruthy();
    const save = screen.getByRole("button", { name: "Save changes" }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    fireEvent.click(save);
    expect(calls.some((call) => call.method === "PATCH")).toBe(false);
  });
});
