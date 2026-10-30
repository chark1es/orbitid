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
    await waitFor(() => expect(screen.getAllByRole("link", { name: "Organizations" })).toHaveLength(1));
    expect(screen.getAllByRole("link", { name: "Organizations" }).map((link) => link.getAttribute("href"))).toEqual([
      "/settings/organizations",
    ]);
  });

  it("shows them once organizations are on", async () => {
    mockApi({ instance: instanceBody((settings) => (settings.organizations.enabled = true)) });
    renderSidebar();

    await waitFor(() => expect(screen.getAllByRole("link", { name: "Organizations" })).toHaveLength(2));
    expect(screen.getAllByRole("link", { name: "Organizations" }).map((link) => link.getAttribute("href"))).toEqual([
      "/organizations",
      "/settings/organizations",
    ]);
  });
});
