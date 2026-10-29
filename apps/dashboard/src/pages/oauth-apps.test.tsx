import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import type { InstanceSettings } from "@orbitid/shared";
import Page from "./oauth-apps";
import { instanceBody, mockApi, renderPage } from "./_config/__tests__/harness";

const APPLICATION = {
  object: "oauth_application" as const,
  id: "oa_1",
  name: "Acme Dashboard",
  client_id: "oa_client",
  public: false,
  redirect_uris: ["https://app.example.com/oauth/callback"],
  scopes: "openid profile email",
  consent_screen_enabled: true,
  pkce_required: true,
  created_at: 1_700_000_000_000,
  updated_at: 1_700_000_000_000,
};

function mockWith(settingsExtra?: (settings: InstanceSettings) => void) {
  return mockApi({
    instance: instanceBody((settings) => {
      settings.oidcProvider.accessTokenFormat = "jwt";
      settings.oidcProvider.deviceAuthorizationEnabled = true;
      settings.oidcProvider.deviceCodeIntervalSeconds = 5;
      settings.oidcProvider.deviceCodeLifetimeSeconds = 600;
      settingsExtra?.(settings);
    }),
    handle: (call) => {
      if (call.url.includes("/v1/oauth_applications")) {
        return new Response(JSON.stringify({ data: [APPLICATION], total_count: 1 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return undefined;
    },
  });
}

describe("OAuth applications", () => {
  it("shows the instance-level provider options and saves them", async () => {
    const calls = mockWith();
    renderPage(<Page />);

    expect(await screen.findByText("Provider options")).toBeTruthy();
    expect(screen.getAllByText("JWT access tokens").length).toBeGreaterThan(0);
    expect(screen.getByText(/Access tokens are RS256 JWTs/)).toBeTruthy();

    fireEvent.click(screen.getByRole("switch", { name: /Allow the device authorization grant/ }));
    fireEvent.click(await screen.findByRole("button", { name: /save provider options/i }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toEqual({
        oidcProvider: { deviceAuthorizationEnabled: false },
      });
    });
  });

  it("lists device-flow endpoints when the grant is enabled", async () => {
    mockWith();
    renderPage(<Page />);

    fireEvent.click((await screen.findAllByTitle("Details"))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("Device authorization endpoint");
    expect(dialog.textContent).toContain("http://localhost:4000/oauth/device_authorization");
    expect(dialog.textContent).toContain("http://localhost:4000/oauth/device");
    expect(dialog.textContent).toContain("Device flow is on for this application");
    expect(dialog.textContent).toContain("every 5 seconds");
  });

  it("never shows a client secret again and says so", async () => {
    mockWith();
    renderPage(<Page />);

    fireEvent.click((await screen.findAllByTitle("Details"))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).toContain("not shown again");
    expect(dialog.textContent).toContain("Rotate the secret");
    expect(dialog.querySelector("code")?.textContent).toBe("oa_client");
  });

  it("hides the device-flow endpoints while the grant is off", async () => {
    mockApi({
      instance: instanceBody(),
      handle: (call) =>
        call.url.includes("/v1/oauth_applications")
          ? new Response(JSON.stringify({ data: [APPLICATION], total_count: 1 }), {
              status: 200,
              headers: { "Content-Type": "application/json" },
            })
          : undefined,
    });
    renderPage(<Page />);

    fireEvent.click((await screen.findAllByTitle("Details"))[0]!);
    const dialog = await screen.findByRole("dialog");
    expect(dialog.textContent).not.toContain("Device authorization endpoint");
  });

  it("rejects a polling interval that is not shorter than the code lifetime", async () => {
    mockWith((settings) => {
      settings.oidcProvider.deviceCodeIntervalSeconds = 600;
    });
    renderPage(<Page />);

    expect((await screen.findAllByText(/Polling interval must be shorter than the device code lifetime/)).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /save provider options/i }).hasAttribute("disabled")).toBe(true);
  });
});
