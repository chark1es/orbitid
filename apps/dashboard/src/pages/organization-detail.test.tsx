import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { Route, Routes } from "react-router-dom";
import type { OrganizationJSON } from "@orbitid/shared";
import OrganizationDetailPage from "./organization-detail";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

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

function detailPage() {
  return (
    <Routes>
      <Route path="/organizations/:id" element={<OrganizationDetailPage />} />
    </Routes>
  );
}

describe("organization detail page", () => {
  it("shows a skeleton while the organization loads", () => {
    pendingApi();
    renderPage(detailPage(), ["/organizations/org_1"]);
    expect(document.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  });

  it("renders the header, counts, and members tab", async () => {
    mockApi({
      handle: (call) => (call.url.endsWith("/v1/organizations/org_1") ? json(ORG) : undefined),
    });
    renderPage(detailPage(), ["/organizations/org_1"]);

    expect(await screen.findByRole("heading", { name: "Acme" })).toBeTruthy();
    expect(screen.getByText("acme")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("100")).toBeTruthy();
    expect(await screen.findByText("No members yet")).toBeTruthy();
  });

  it("shows a not-found error with a way back", async () => {
    mockApi({
      handle: (call) =>
        call.url.endsWith("/v1/organizations/org_missing")
          ? json({ errors: [{ long_message: "Organization not found" }] }, 404)
          : undefined,
    });
    renderPage(detailPage(), ["/organizations/org_missing"]);

    expect(await screen.findByText("Could not load this organization")).toBeTruthy();
    expect(screen.getByText(/Organization not found/)).toBeTruthy();
    expect(screen.getByRole("link", { name: /Back to organizations/ })).toBeTruthy();
  });
});
