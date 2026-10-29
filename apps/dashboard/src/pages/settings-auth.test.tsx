import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import AuthPage from "./settings-auth";
import SessionsPage from "./settings-sessions";
import { instanceBody, mockApi, renderPage } from "./_config/__tests__/harness";

describe("authentication settings", () => {
  it("adds email code as a second factor", async () => {
    const calls = mockApi();
    renderPage(<AuthPage />);

    const toggle = await screen.findByRole("checkbox", { name: /Email one-time code/ });
    fireEvent.click(toggle);
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        attributes: { emailAddress: { usedForSecondFactor: true } },
      });
    });
  });

  it("refuses to require MFA with no second factor at all", async () => {
    mockApi({
      instance: instanceBody((settings) => {
        settings.attributes.authenticatorApp.enabled = false;
        settings.attributes.backupCode.enabled = false;
        settings.attributes.phoneNumber.usedForSecondFactor = false;
        settings.attributes.emailAddress.usedForSecondFactor = false;
        settings.mfa.required = true;
      }),
    });
    renderPage(<AuthPage />);

    expect(await screen.findByText("Enable at least one second factor before requiring MFA.")).toBeTruthy();
  });

  it("explains and saves the anonymous account retention", async () => {
    const calls = mockApi();
    renderPage(<AuthPage />);

    const toggle = await screen.findByRole("switch", { name: /Allow anonymous sign-ups/ });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText(/Delete inactive guests after/), { target: { value: "86400" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        anonymous: { enabled: true, retentionSeconds: 86_400 },
      });
    });
    expect(screen.getByText(/Guests count against your user totals/)).toBeTruthy();
  });
});

describe("session settings", () => {
  it("saves trusted devices with a duration and explains the consequence", async () => {
    const calls = mockApi();
    renderPage(<SessionsPage />);

    const toggle = await screen.findByRole("switch", { name: /Allow trusted devices/ });
    expect(screen.getByText(/skip the second factor on a browser/)).toBeTruthy();
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText(/Trust duration/), { target: { value: "14" } });
    fireEvent.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        session: { trustedDevicesEnabled: true, trustedDeviceDays: 14 },
      });
    });
  });

  it("rejects a trust duration outside 1 to 365 days", async () => {
    mockApi();
    renderPage(<SessionsPage />);

    const toggle = await screen.findByRole("switch", { name: /Allow trusted devices/ });
    fireEvent.click(toggle);
    fireEvent.change(screen.getByLabelText(/Trust duration/), { target: { value: "400" } });

    expect(await screen.findByText(/Trusted device duration must be between 1 and 365 days/)).toBeTruthy();
    expect(screen.getByRole("button", { name: /save changes/i }).hasAttribute("disabled")).toBe(true);
  });
});
