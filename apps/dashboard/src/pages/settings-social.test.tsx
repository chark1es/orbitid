import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import Page from "./settings-social";
import { instanceBody, mockApi, renderPage } from "./_config/__tests__/harness";

/** The Configure button in the row labelled with that provider name, opening the preset list if needed. */
async function configureFor(label: string): Promise<HTMLElement> {
  await screen.findByLabelText("Search providers");
  let labelNode = screen.queryByText(label);
  if (!labelNode) {
    fireEvent.click(screen.getByRole("button", { name: /More providers \(/ }));
    labelNode = screen.getByText(label);
  }
  const row = labelNode.closest("li")!;
  return within(row).getByRole("button", { name: "Configure" });
}

describe("social connections", () => {
  it("offers team ID, key ID and a .p8 key for Apple instead of a client secret", async () => {
    mockApi();
    renderPage(<Page />);

    // Apple is a preset, shown in the collapsed list behind More providers.
    fireEvent.click(await configureFor("Apple"));

    expect(await screen.findByLabelText(/Team ID/)).toBeTruthy();
    expect(screen.getByLabelText(/Key ID/)).toBeTruthy();
    expect(screen.getByLabelText(/Private key \(\.p8\)/)).toBeTruthy();
    expect(screen.getByText("Client secret (optional)")).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /Apple/ })).toBeTruthy();
    expect(screen.getByText(/BEGIN PRIVATE KEY/)).toBeTruthy();
  });

  it("keeps a stored Apple key and accepts the rest of the credentials", async () => {
    const calls = mockApi({
      instance: instanceBody((settings) => {
        settings.social.apple = {
          enabled: true,
          clientId: "com.example.web",
          clientSecret: "",
          scopes: ["name", "email"],
          authenticatableAtSignIn: true,
          appleTeamId: "TEAM123456",
          appleKeyId: "KEY7890123",
          applePrivateKey: "••••",
        };
      }),
    });
    renderPage(<Page />);

    fireEvent.click(await configureFor("Apple"));
    const key = (await screen.findByLabelText(/Private key \(\.p8\)/)) as HTMLTextAreaElement;
    expect(key.value).toBe("");
    expect(screen.getAllByText("Set").length).toBeGreaterThan(0);

    fireEvent.change(screen.getByLabelText(/Key ID/), { target: { value: "KEY0000000" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const body = calls.find((call) => call.method === "PATCH")?.body as
        | { social?: { apple?: Record<string, unknown> } }
        | undefined;
      expect(body?.social?.apple?.appleKeyId).toBe("KEY0000000");
      // The masked key is never written back.
      expect(body?.social?.apple?.applePrivateKey).toBeUndefined();
    });
  });

  it("treats a stored client secret as configured and never resends the mask", async () => {
    const calls = mockApi({
      instance: instanceBody((settings) => {
        settings.social.google = {
          enabled: true,
          clientId: "google-id",
          clientSecret: "••••",
          scopes: ["openid", "email"],
          authenticatableAtSignIn: true,
        };
      }),
    });
    renderPage(<Page />);

    fireEvent.click(await configureFor("Google"));
    const secret = (await screen.findByLabelText(/Client secret/)) as HTMLInputElement;
    expect(secret.value).toBe("");
    expect(secret.getAttribute("placeholder")).toBe("Stored; leave blank to keep");
    expect(screen.getByLabelText("Display name").getAttribute("placeholder")).toBe("Sign-in button label");

    fireEvent.change(screen.getByLabelText(/Client ID/), { target: { value: "google-id-2" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const body = calls.find((call) => call.method === "PATCH")?.body as
        | { social?: { google?: Record<string, unknown> } }
        | undefined;
      expect(body?.social?.google?.clientId).toBe("google-id-2");
      expect(body?.social?.google?.clientSecret).toBeUndefined();
    });
  });
});

const customProvider = (overrides: Record<string, unknown> = {}) => ({
  enabled: true,
  name: "Acme ID",
  clientId: "acme-id",
  clientSecret: "••••",
  scopes: ["openid", "email"],
  authenticatableAtSignIn: true,
  protocol: "oidc" as const,
  discoveryUrl: "https://auth.acme.test/.well-known/openid-configuration",
  clientAuthMethod: "client_secret_basic" as const,
  pkce: true,
  trustEmailVerified: false,
  claimMapping: { sub: "", email: "", emailVerified: "", name: "", firstName: "", lastName: "", username: "", picture: "" },
  ...overrides,
});

describe("provider list", () => {
  it("keeps enabled providers on top and hides the untouched presets behind a disclosure", async () => {
    mockApi({
      instance: instanceBody((settings) => {
        settings.social.github = {
          enabled: true,
          clientId: "gh-id",
          clientSecret: "••••",
          scopes: ["read:user"],
          authenticatableAtSignIn: true,
        };
      }),
    });
    renderPage(<Page />);

    await screen.findByRole("button", { name: "Configure" });
    const rows = screen.getAllByRole("listitem").filter((row) => row.textContent?.includes("Configure"));
    expect(rows[0]?.textContent).toContain("GitHub");
    // Compact rows and one disclosure instead of a wall of presets.
    expect(rows[0]?.className).toContain("py-2");
    expect(screen.queryByText("Apple")).toBeNull();
    const more = screen.getByRole("button", { name: /More providers \(/ });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(more.getAttribute("aria-controls")).toBe("social-preset-providers");
    expect(screen.getByText(/enabled or configured/).getAttribute("aria-live")).toBe("polite");

    fireEvent.click(more);
    expect(await screen.findByText("Apple")).toBeTruthy();
    expect(document.getElementById("social-preset-providers")).toBeTruthy();
    expect(screen.getByRole("button", { name: /Fewer providers/ }).getAttribute("aria-expanded")).toBe("true");

    // The search box still finds every provider, including the collapsed presets.
    fireEvent.change(screen.getByLabelText("Search providers"), { target: { value: "apple" } });
    expect(screen.getByText("Apple")).toBeTruthy();
    expect(screen.queryByText("GitHub")).toBeNull();
    expect(screen.getByText("1 matching").getAttribute("aria-live")).toBe("polite");
  });
});

describe("custom providers", () => {
  it("waits for a touch or an Add attempt before showing validation messages", async () => {
    mockApi();
    renderPage(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Add custom provider/ }));
    const sheet = await screen.findByRole("dialog", { name: /Add custom provider/ });
    // An empty form is not an error: nothing has been touched and Add has not been pressed.
    expect(within(sheet).queryByText("Fill the required fields")).toBeNull();
    expect(within(sheet).queryByText(/is required/)).toBeNull();

    fireEvent.blur(within(sheet).getByLabelText(/Display name/));
    const summary = await within(sheet).findByText("Fill the required fields");
    expect(summary).toBeTruthy();
    // Only the field that was touched reports; the untouched discovery URL stays quiet.
    expect(within(sheet).getByText("Display name is required.")).toBeTruthy();
    expect(within(sheet).queryByText("Discovery URL is required.")).toBeNull();

    // An Add attempt on the empty form now reports every missing field with "required" copy.
    fireEvent.click(within(sheet).getByRole("button", { name: "Add provider" }));
    expect(await within(sheet).findByText("Discovery URL is required.")).toBeTruthy();
    expect(within(sheet).queryByText(/Discovery URL must be an http/)).toBeNull();
    // Nothing was added while the form still had errors.
    expect(screen.queryByRole("dialog", { name: /Acme/ })).toBeNull();
  });

  it("adds a custom OAuth 2.0 provider with manual endpoints and a nested claim mapping", async () => {
    const calls = mockApi();
    renderPage(<Page />);

    fireEvent.click(await screen.findByRole("button", { name: /Add custom provider/ }));
    fireEvent.change(screen.getByLabelText(/Display name/), { target: { value: "Acme Nested" } });
    fireEvent.change(screen.getByLabelText(/Provider key/), { target: { value: "acme_nested" } });
    fireEvent.click(screen.getByLabelText(/Protocol/));
    fireEvent.click(await screen.findByRole("option", { name: "OAuth 2.0" }));
    fireEvent.click(screen.getByLabelText(/Endpoints/));
    fireEvent.click(await screen.findByRole("option", { name: "Manual endpoints" }));
    fireEvent.change(screen.getByLabelText(/Authorization URL/), { target: { value: "https://acme.test/oauth/authorize" } });
    fireEvent.change(screen.getByLabelText(/Token URL/), { target: { value: "https://acme.test/oauth/token" } });
    fireEvent.change(screen.getByLabelText(/Userinfo URL/), { target: { value: "https://acme.test/oauth/userinfo" } });
    fireEvent.change(screen.getByLabelText(/Client ID/), { target: { value: "nested-id" } });
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: "nested-secret" } });

    fireEvent.click(screen.getByRole("button", { name: "Add provider" }));
    // The provider sheet opens on the new key, ready for claims and a connection test.
    expect(await screen.findByRole("dialog", { name: /Acme Nested/ })).toBeTruthy();
    fireEvent.change(screen.getByLabelText("Subject"), { target: { value: "data.profile.id" } });
    fireEvent.change(screen.getByLabelText("Email"), { target: { value: "data.profile.contact.email" } });
    fireEvent.click(screen.getAllByRole("button", { name: "Close" }).at(-1)!);
    fireEvent.click(await screen.findByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      const body = calls.find((call) => call.method === "PATCH")?.body as
        | { social?: { custom_acme_nested?: Record<string, unknown> } }
        | undefined;
      const provider = body?.social?.custom_acme_nested;
      expect(provider?.protocol).toBe("oauth2");
      expect(provider?.authorizationUrl).toBe("https://acme.test/oauth/authorize");
      expect(provider?.tokenUrl).toBe("https://acme.test/oauth/token");
      expect(provider?.userinfoUrl).toBe("https://acme.test/oauth/userinfo");
      expect(provider?.claimMapping).toMatchObject({ sub: "data.profile.id", email: "data.profile.contact.email" });
    });
  });

  it("shows the callback URL derived from the public API URL and tests the endpoints", async () => {
    mockApi({
      instance: instanceBody((settings) => {
        settings.social.custom_acme = customProvider() as never;
      }),
      handle: (call) =>
        call.url.endsWith("/v1/instance/social/test")
          ? new Response(JSON.stringify({
              ok: false,
              protocol: "oidc",
              issuer: "https://auth.acme.test",
              endpoints: { authorization: "https://auth.acme.test/authorize", token: "https://auth.acme.test/token" },
              checks: [{ name: "Token endpoint", url: "https://auth.acme.test/token", reachable: false, error: "connection refused" }],
              warnings: [],
              errors: ["The discovery document points at a non-public address"],
            }), { status: 200, headers: { "Content-Type": "application/json" } })
          : undefined,
    });
    renderPage(<Page />);

    const configure = await screen.findAllByRole("button", { name: "Configure" });
    expect(configure).toHaveLength(1);
    fireEvent.click(await configureFor("Acme ID"));
    const dialog = await screen.findByRole("dialog", { name: /Acme ID/ });
    expect(within(dialog).getByText("http://localhost:4000/v1/oauth_callback/custom_acme")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Test connection" }));

    const result = await screen.findByTestId("social-test-result");
    expect(within(result).getByText(/connection refused/)).toBeTruthy();
    expect(within(result).getByText(/non-public address/)).toBeTruthy();
    expect(within(result).getByText("https://auth.acme.test")).toBeTruthy();
  });

  it("deletes a custom provider after confirming", async () => {
    const calls = mockApi({
      instance: instanceBody((settings) => {
        settings.social.custom_acme = customProvider() as never;
      }),
      handle: (call) => (call.method === "DELETE" && call.url.includes("/v1/instance/social/custom_acme") ? (() => {
        const body = instanceBody();
        return new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
      })() : undefined),
    });
    renderPage(<Page />);

    const configure = await screen.findAllByRole("button", { name: "Configure" });
    expect(configure).toHaveLength(1);
    fireEvent.click(await configureFor("Acme ID"));
    fireEvent.click(await screen.findByRole("button", { name: "Delete provider" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete provider" }));

    await waitFor(() => {
      expect(calls.some((call) => call.method === "DELETE" && call.url.includes("/v1/instance/social/custom_acme"))).toBe(true);
    });
  });
});
