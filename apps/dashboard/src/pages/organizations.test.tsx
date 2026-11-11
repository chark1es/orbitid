import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { OrganizationJSON } from "@orbitid/shared";
import type { InstanceSettings } from "@orbitid/shared";
import OrganizationsPage from "./organizations";
import { RequireOrganizations } from "../components/shared/feature-locked";
import { instanceBody, mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const ORG = {
  id: "org_1",
  name: "Acme",
  slug: "acme",
  image_url: "",
  members_count: 12,
  pending_invitations_count: 2,
  max_allowed_memberships: 100,
  admin_delete_enabled: true,
  created_at: 1_700_000_000_000,
} as unknown as OrganizationJSON;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const list = (data: unknown[], total = data.length) => json({ data, total_count: total });

function settings(organizationsEnabled = true) {
  return instanceBody((value: InstanceSettings) => {
    value.organizations.enabled = organizationsEnabled;
  });
}

describe("organizations page", () => {
  it("shows a loading state", () => {
    pendingApi();
    renderPage(<OrganizationsPage />);
    expect(document.querySelector('[aria-busy="true"]')).toBeTruthy();
  });

  it("renders the empty state", async () => {
    mockApi({ instance: settings() });
    renderPage(<OrganizationsPage />);
    expect(await screen.findByText("No organizations yet")).toBeTruthy();
    expect(screen.getByText("No organizations yet").closest("[data-variant]")?.getAttribute("data-variant")).toBe("compact");
  });

  it("renders organizations and paginates", async () => {
    mockApi({
      instance: settings(),
      handle: (call) => (call.url.includes("/v1/organizations?") ? list([ORG], 34) : undefined),
    });
    renderPage(<OrganizationsPage />);

    expect(await screen.findByText("Acme")).toBeTruthy();
    expect(screen.getByText("12")).toBeTruthy();
    expect(screen.getByText("Showing 1–20 of 34")).toBeTruthy();
  });

  it("truncates a long slug with a title and keeps the Created column out below lg", async () => {
    const slug = "northwind-traders-with-a-very-long-organization-name";
    mockApi({
      instance: settings(),
      handle: (call) => (call.url.includes("/v1/organizations?") ? list([{ ...ORG, slug }], 1) : undefined),
    });
    renderPage(<OrganizationsPage />);

    const slugNode = await screen.findByText(slug);
    expect(slugNode.className).toContain("truncate");
    expect(slugNode.getAttribute("title")).toBe(slug);

    const created = screen.getByRole("columnheader", { name: "Created" });
    expect(created.className).toContain("hidden");
    expect(created.className).toContain("lg:table-cell");
    expect(screen.getByRole("columnheader", { name: "Organization" })).toBeTruthy();
  });

  it("shows a list error", async () => {
    mockApi({
      instance: settings(),
      handle: (call) =>
        call.url.includes("/v1/organizations?") ? json({ errors: [{ long_message: "Organizations failed" }] }, 500) : undefined,
    });
    renderPage(<OrganizationsPage />);
    expect(await screen.findByText(/Organizations failed/)).toBeTruthy();
  });

  it("creates an organization with a derived slug", async () => {
    const calls = mockApi({
      instance: settings(),
      handle: (call) => {
        if (call.method === "POST" && call.url.endsWith("/v1/organizations")) return json({ ...ORG, id: "org_new" });
        if (call.url.includes("/v1/organizations?")) return list([]);
        return undefined;
      },
    });
    renderPage(<OrganizationsPage />);
    await screen.findByText("No organizations yet");

    fireEvent.click(screen.getAllByRole("button", { name: /Create organization/ })[0]!);
    const dialog = await screen.findByRole("dialog");
    fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "Northwind Traders" } });
    expect((within(dialog).getByLabelText("Slug") as HTMLInputElement).value).toBe("northwind-traders");
    fireEvent.click(within(dialog).getByRole("button", { name: "Create organization" }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "POST" && call.url.endsWith("/v1/organizations"))?.body).toEqual({
        name: "Northwind Traders",
        slug: "northwind-traders",
      });
    });
  });

  it("deletes an organization only after confirmation", async () => {
    const calls = mockApi({
      instance: settings(),
      handle: (call) => (call.url.includes("/v1/organizations?") ? list([ORG]) : undefined),
    });
    renderPage(<OrganizationsPage />);

    fireEvent.click(await screen.findByRole("button", { name: "Delete Acme" }));
    expect(screen.getByText("Delete organization?")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Delete organization" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.endsWith("/v1/organizations/org_1"))).toBe(true);
    });
  });

  it("locks the route while organizations are disabled", async () => {
    mockApi({ instance: settings(false) });
    renderPage(
      <RequireOrganizations title="Organizations">
        <OrganizationsPage />
      </RequireOrganizations>,
    );

    expect(await screen.findByTestId("feature-locked")).toBeTruthy();
    expect(screen.getByText("Organizations are turned off")).toBeTruthy();
  });
});
