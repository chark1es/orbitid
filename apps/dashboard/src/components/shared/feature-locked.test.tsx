import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import { instanceBody, mockApi, renderPage } from "../../pages/_config/__tests__/harness";
import { RequireOrganizations } from "./feature-locked";

describe("RequireOrganizations", () => {
  it("locks the page when organizations are off, keeps the title, and links to the one setting", async () => {
    mockApi({ instance: instanceBody((settings) => (settings.organizations.enabled = false)) });
    renderPage(
      <RequireOrganizations title="Organizations">
        <p>Organization table</p>
      </RequireOrganizations>,
    );

    expect(await screen.findByTestId("feature-locked")).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Organizations" })).toBeTruthy();
    expect(screen.getByText("Organizations are turned off")).toBeTruthy();
    expect(screen.queryByText("Organization table")).toBeNull();
    expect(screen.getByRole("link", { name: "Open organization settings" }).getAttribute("href")).toBe(
      "/settings/organizations",
    );
  });

  it("renders the page once organizations are on", async () => {
    mockApi({ instance: instanceBody((settings) => (settings.organizations.enabled = true)) });
    renderPage(
      <RequireOrganizations title="Organizations">
        <p>Organization table</p>
      </RequireOrganizations>,
    );

    expect(await screen.findByText("Organization table")).toBeTruthy();
    expect(screen.queryByTestId("feature-locked")).toBeNull();
  });

  it("shows no table while settings are still loading, instead of flashing the page", () => {
    mockApi({ instance: instanceBody() });
    renderPage(
      <RequireOrganizations title="Organizations">
        <p>Organization table</p>
      </RequireOrganizations>,
    );
    expect(screen.queryByText("Organization table")).toBeNull();
  });

  it("keeps the page locked when settings cannot be read", async () => {
    mockApi({ handle: (call) => (call.url.includes("/v1/instance") ? new Response("{}", { status: 500 }) : undefined) });
    renderPage(
      <RequireOrganizations title="Organizations">
        <p>Organization table</p>
      </RequireOrganizations>,
    );
    expect(await screen.findByText("Organization settings could not be loaded")).toBeTruthy();
    expect(screen.queryByText("Organization table")).toBeNull();
  });
});
