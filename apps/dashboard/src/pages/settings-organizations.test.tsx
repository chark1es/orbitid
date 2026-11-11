import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import SettingsOrganizationsPage from "./settings-organizations";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("organization settings page", () => {
  it("shows the settings loading state", () => {
    pendingApi();
    renderPage(<SettingsOrganizationsPage />);
    expect(screen.getByLabelText("Loading settings")).toBeTruthy();
  });

  it("turns organizations on and saves the membership limit", async () => {
    const calls = mockApi();
    renderPage(<SettingsOrganizationsPage />);

    fireEvent.click(await screen.findByRole("switch", { name: /Enable organizations/ }));
    fireEvent.change(screen.getByLabelText(/Maximum memberships per user/), { target: { value: "25" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        organizations: { enabled: true, maxAllowedMemberships: 25 },
      });
    });
  });

  it("treats zero memberships as no limit", async () => {
    mockApi();
    renderPage(<SettingsOrganizationsPage />);

    fireEvent.change(await screen.findByLabelText(/Maximum memberships per user/), { target: { value: "0" } });
    expect(screen.queryByText(/Maximum memberships must be 0/)).toBeNull();
    expect(screen.queryByRole("alert")).toBeNull();
    // 0 is the default and means "no limit", so no change is pending.
    expect(screen.queryByRole("button", { name: /save changes/i })).toBeNull();
  });

  it("shows a settings load error", async () => {
    mockApi({
      handle: (call) => (call.url.endsWith("/v1/instance") ? json({ errors: [{ long_message: "Settings unavailable" }] }, 500) : undefined),
    });
    renderPage(<SettingsOrganizationsPage />);
    expect(await screen.findByText(/Settings unavailable/)).toBeTruthy();
  });
});
