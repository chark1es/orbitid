import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { Breadcrumbs } from "./breadcrumbs";
import { BreadcrumbLabelProvider, shortId, useBreadcrumbLabel } from "./breadcrumb-label";

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Breadcrumbs />
    </MemoryRouter>,
  );
}

function DetailPage({ label }: { label: string | null }) {
  useBreadcrumbLabel(label);
  return null;
}

describe("breadcrumbs", () => {
  it("keeps the trail inside its column instead of painting over the instance chip", () => {
    const { container } = renderAt("/settings/sessions");
    const nav = container.querySelector('nav[aria-label="breadcrumb"]')!;
    const list = container.querySelector('ol[data-slot="breadcrumb-list"]')!;
    // The narrow top-bar grid cell clips: a wide trail may not overlap the chip to its right.
    expect(nav.className).toContain("overflow-hidden");
    expect(nav.className).toContain("min-w-0");
    expect(list.className).toContain("overflow-hidden");
    expect(list.className).toContain("flex-nowrap");
    // Only the last crumb truncates; the middle crumbs stay whole.
    expect(screen.getByText("Configure").className).not.toContain("truncate");
    expect(screen.getByText("Session settings").className).toContain("truncate");
  });

  it("qualifies the two settings pages that share a name with a Manage page", () => {
    renderAt("/settings/organizations");
    expect(screen.getByText("Organization settings")).toBeTruthy();
  });

  it.each([
    ["/settings/authentication", "Authentication"],
    ["/settings/social", "Social connections"],
    ["/settings/sessions", "Session settings"],
    ["/settings/organizations", "Organization settings"],
    ["/settings/email-sms", "Email & SMS"],
    ["/settings/appearance", "Appearance"],
  ])("shows the real title for %s instead of the raw slug", (path, label) => {
    renderAt(path);
    expect(screen.getByText(label)).toBeTruthy();
  });

  it("truncates the last crumb in a block box so an ellipsis is possible", () => {
    renderAt("/settings/authentication");
    const crumb = screen.getByText("Authentication");
    expect(crumb.className).toContain("block");
    expect(crumb.className).toContain("truncate");
    expect(crumb.className).toContain("max-w-[32ch]");
  });

  it("lets the last crumb shrink while the trail before it keeps its size", () => {
    const { container } = renderAt("/settings/sessions");
    const list = container.querySelector('ol[data-slot="breadcrumb-list"]')!;
    const items = [...list.querySelectorAll('li[data-slot="breadcrumb-item"]')];
    const root = items.find((item) => item.textContent === "OrbitID")!;
    // The root crumb leaves below lg: it is the first thing to go when the bar is narrow.
    expect(root.className).toContain("hidden");
    expect(root.className).toContain("lg:inline-flex");
    expect(root.className).toContain("shrink-0");
    const middle = items.find((item) => item.textContent === "Configure")!;
    expect(middle.className).toContain("shrink-0");
    expect(middle.className).not.toContain("flex-1");
    const last = items.find((item) => item.textContent === "Session settings")!;
    // A block box is what makes `truncate` clip: no fixed min-width floor may win over the column.
    expect(last.className).toContain("block");
    expect(last.className).toContain("min-w-0");
    expect(last.className).toContain("flex-1");
    expect(last.className).toContain("truncate");
    expect(screen.getByText("Session settings").className).not.toContain("min-w-[8ch]");
  });

  it("renders a registered record name in the same shrinkable last crumb", () => {
    render(
      <MemoryRouter initialEntries={["/users/user_AbCdEfGhIjKlMnOpQrStUvWxYz"]}>
        <BreadcrumbLabelProvider>
          <Breadcrumbs />
          <DetailPage label="Ada Lovelace" />
        </BreadcrumbLabelProvider>
      </MemoryRouter>,
    );
    const crumb = screen.getByText("Ada Lovelace");
    expect(crumb.textContent).toBe("Ada Lovelace");
    expect(crumb.className).toContain("truncate");
    expect(crumb.className).toContain("block");
    const item = crumb.closest("li")!;
    expect(item.className).toContain("min-w-0");
    expect(item.className).toContain("flex-1");
    expect(item.className).toContain("truncate");
  });

  it("shows a short id, not the raw id, while a detail record loads", () => {
    renderAt("/users/user_AbCdEfGhIjKlMnOpQrStUvWxYz");
    expect(screen.getByText(shortId("user_AbCdEfGhIjKlMnOpQrStUvWxYz"))).toBeTruthy();
    expect(screen.queryByText("user_AbCdEfGhIjKlMnOpQrStUvWxYz")).toBeNull();
  });

  it("replaces the id with the name the detail page registers", () => {
    render(
      <MemoryRouter initialEntries={["/users/user_AbCdEfGhIjKlMnOpQrStUvWxYz"]}>
        <BreadcrumbLabelProvider>
          <Breadcrumbs />
          <DetailPage label="Ada Lovelace" />
        </BreadcrumbLabelProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("Ada Lovelace")).toBeTruthy();
    expect(screen.queryByText(/user_AbCd/)).toBeNull();
    expect(screen.getByText("Ada Lovelace").className).toContain("truncate");
  });

  it("registers the organization name on the organization detail crumb", () => {
    render(
      <MemoryRouter initialEntries={["/organizations/org_AsiNef7hCMCifS8fjrVZCHAN0xY"]}>
        <BreadcrumbLabelProvider>
          <Breadcrumbs />
          <DetailPage label="Northwind Traders" />
        </BreadcrumbLabelProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("Northwind Traders")).toBeTruthy();
    expect(screen.queryByText(/org_AsiNef/)).toBeNull();
  });
});
