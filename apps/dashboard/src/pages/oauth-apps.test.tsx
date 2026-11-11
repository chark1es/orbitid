import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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
  post_logout_redirect_uris: ["https://app.example.com/signed-out"],
  scopes: "openid profile email",
  consent_screen_enabled: true,
  pkce_required: true,
  access_token_lifetime_seconds: 3600,
  refresh_token_lifetime_seconds: 2_592_000,
  id_token_lifetime_seconds: 3600,
  groups_claim: "all" as const,
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

describe("OAuth application column visibility", () => {
  it("hides the client id, redirect count, PKCE and created date until they fit", async () => {
    mockWith();
    renderPage(<Page />);
    await screen.findByText("Acme Dashboard");

    for (const name of ["Client ID", "Created"]) {
      const head = screen.getByRole("columnheader", { name });
      expect(head.className).toContain("hidden");
      expect(head.className).toContain("xl:table-cell");
    }
    const type = screen.getByRole("columnheader", { name: "Type" });
    expect(type.className).toContain("hidden");
    expect(type.className).toContain("md:table-cell");
    for (const name of ["Redirect URIs", "PKCE"]) {
      const head = screen.getByRole("columnheader", { name });
      expect(head.className).toContain("hidden");
      expect(head.className).toContain("lg:table-cell");
    }
    expect(screen.getByRole("columnheader", { name: "Application" })).toBeTruthy();
  });
});

describe("OAuth application create form validation", () => {
  it("waits for a save attempt before listing what is missing", async () => {
    mockWith();
    renderPage(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Create application/ }));
    const sheet = await screen.findByRole("dialog");
    expect(within(sheet).queryByText("Fix these before saving")).toBeNull();

    fireEvent.click(within(sheet).getByRole("button", { name: "Create application" }));
    expect(await within(sheet).findByText("Fix these before saving")).toBeTruthy();
    expect(within(sheet).getByText("Application name is required.")).toBeTruthy();
    expect(within(sheet).getByText("Add at least one redirect URI.")).toBeTruthy();
    expect(within(sheet).queryByText(/must be an absolute http/)).toBeNull();
  });
});

describe("OAuth application scopes", () => {
  it("renders duplicate stored scopes once and without a duplicate-key warning", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
    mockApi({
      instance: instanceBody(),
      handle: (call) =>
        call.url.includes("/v1/oauth_applications")
          ? new Response(
              JSON.stringify({
                data: [{ ...APPLICATION, scopes: "openid profile email openid profile email phone" }],
                total_count: 1,
              }),
              { status: 200, headers: { "Content-Type": "application/json" } },
            )
          : undefined,
    });
    renderPage(<Page />);

    fireEvent.click((await screen.findAllByTitle("Details"))[0]!);
    const dialog = await screen.findByRole("dialog");
    const scopeLabel = within(dialog).getByText("Scopes");
    const chips = Array.from(scopeLabel.parentElement!.querySelectorAll("code")).map((chip) => chip.textContent);
    expect(chips).toEqual(["openid", "profile", "email", "phone"]);
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("dedupes scopes on save while keeping their first position", async () => {
    const calls = mockWith();
    renderPage(<Page />);

    fireEvent.click((await screen.findAllByTitle("Edit"))[0]!);
    const sheet = await screen.findByRole("dialog");
    const scopes = within(sheet).getByLabelText(/Scopes/) as HTMLInputElement;
    fireEvent.change(scopes, { target: { value: "openid profile email openid profile email phone" } });
    fireEvent.click(within(sheet).getByRole("button", { name: /Save changes/ }));

    await waitFor(() => {
      expect(calls.find((call) => call.method === "PATCH")?.body).toMatchObject({
        scopes: "openid profile email phone",
      });
    });
  });
});

describe("OAuth application sheet widths", () => {
  it("opens the create form at 576px with short fields paired two to a row", async () => {
    mockWith();
    renderPage(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Create application/ }));
    const sheet = await screen.findByRole("dialog");
    expect(sheet.className).toContain("sm:max-w-xl");
    expect(sheet.className).not.toContain("sm:max-w-3xl");

    const nameField = screen.getByLabelText(/Application name/);
    expect(nameField.closest("div.grid")?.className).toContain("sm:grid-cols-2");
  });

  it("keeps the endpoint detail view wide", async () => {
    mockWith();
    renderPage(<Page />);

    fireEvent.click((await screen.findAllByTitle("Details"))[0]!);
    const sheet = await screen.findByRole("dialog");
    expect(sheet.className).toContain("sm:max-w-3xl");
  });
});
