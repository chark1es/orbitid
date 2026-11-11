import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { SidebarProvider } from "@orbitid/ui";
import { instanceBody, mockApi, renderPage } from "../../pages/_config/__tests__/harness";
import { AppSidebar } from "./app-shell";

const renderSidebar = () =>
  renderPage(
    <SidebarProvider>
      <AppSidebar />
    </SidebarProvider>,
  );

describe("navigation rail", () => {
  it("hides the organization pages while organizations are off, and keeps their setting", async () => {
    mockApi({ instance: instanceBody((settings) => (settings.organizations.enabled = false)) });
    renderSidebar();

    expect(screen.getByRole("link", { name: "Roles & permissions" })).toBeTruthy();
    await waitFor(() =>
      expect(screen.getAllByRole("link", { name: "Organization settings" }).map((link) => link.getAttribute("href"))).toEqual([
        "/settings/organizations",
      ]),
    );
    expect(screen.queryByRole("link", { name: "Organizations" })).toBeNull();
  });

  it("shows them once organizations are on, with distinct labels for the settings pages", async () => {
    mockApi({ instance: instanceBody((settings) => (settings.organizations.enabled = true)) });
    renderSidebar();

    await waitFor(() => expect(screen.getByRole("link", { name: "Organizations" }).getAttribute("href")).toBe("/organizations"));
    expect(screen.getAllByRole("link", { name: "Organizations" })).toHaveLength(1);
    expect(screen.getByRole("link", { name: "Session settings" }).getAttribute("href")).toBe("/settings/sessions");
    expect(screen.getByRole("link", { name: "Organization settings" }).getAttribute("href")).toBe(
      "/settings/organizations",
    );
  });
});
