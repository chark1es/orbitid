import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import SettingsSessionsPage from "./settings-sessions";
import { mockApi, pendingApi, renderPage } from "./_config/__tests__/harness";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, statusText: "Error", headers: { "Content-Type": "application/json" } });

describe("session settings page", () => {
  it("shows the settings loading state", () => {
    pendingApi();
    renderPage(<SettingsSessionsPage />);
    expect(screen.getByLabelText("Loading settings")).toBeTruthy();
  });

  it("saves the lifetime and inactivity fields", async () => {
    const calls = mockApi();
    renderPage(<SettingsSessionsPage />);

    fireEvent.change(await screen.findByLabelText(/Maximum session lifetime/), { target: { value: "86400" } });
    fireEvent.change(screen.getByLabelText(/Inactivity timeout/), { target: { value: "3600" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        session: { lifetimeSeconds: 86_400, inactivityTimeoutSeconds: 3_600 },
      });
    });
  });

  it("rejects an inactivity timeout longer than a finite session lifetime", async () => {
    mockApi();
    renderPage(<SettingsSessionsPage />);

    fireEvent.change(await screen.findByLabelText(/Maximum session lifetime/), { target: { value: "3600" } });
    fireEvent.change(screen.getByLabelText(/Inactivity timeout/), { target: { value: "9999999" } });
    expect(await screen.findByText(/Inactivity timeout cannot exceed a finite session lifetime/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(true);
  });

  it("rejects a token lifetime below 30 seconds instead of letting the SDK mint continuously", async () => {
    mockApi();
    renderPage(<SettingsSessionsPage />);

    fireEvent.change(await screen.findByLabelText(/Session token lifetime/), { target: { value: "5" } });
    expect(await screen.findByText(/Token lifetime must be at least 30 seconds/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(true);
    expect((screen.getByLabelText(/Session token lifetime/) as HTMLInputElement).min).toBe("30");
  });

  it("keeps the page description to a 60-character measure", async () => {
    mockApi();
    renderPage(<SettingsSessionsPage />);
    const description = await screen.findByText(/Control how long sessions last/);
    expect(description.className).toContain("max-w-[60ch]");
  });

  it("shows a settings load error", async () => {
    mockApi({
      handle: (call) => (call.url.endsWith("/v1/instance") ? json({ errors: [{ long_message: "Session settings unavailable" }] }, 500) : undefined),
    });
    renderPage(<SettingsSessionsPage />);
    expect(await screen.findByText(/Session settings unavailable/)).toBeTruthy();
  });
});
