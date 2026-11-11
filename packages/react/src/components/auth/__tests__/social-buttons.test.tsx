import { describe, expect, it } from "vitest";
import { screen, within } from "@testing-library/react";
import { SignIn } from "../index";
import { authEnvironment, makeSignIn, renderAuth, setupAuth } from "./fake-auth";

function renderSocialSignIn(harness: ReturnType<typeof setupAuth>) {
  return renderAuth(<SignIn routing="virtual" />, harness);
}

describe("block social buttons", () => {
  it("labels the social provider used last and keeps every label on the same axis", async () => {
    const environment = authEnvironment();
    environment.userSettings.social = {
      google: { enabled: true, name: "Google", strategy: "oauth_google", authenticatable: true, logoUrl: "" },
      github: { enabled: true, name: "GitHub", strategy: "oauth_github", authenticatable: true, logoUrl: "" },
    };
    const harness = setupAuth({ signedIn: false, environment });
    harness.instance.lastUsedStrategy = "oauth_google";
    makeSignIn(harness.instance);
    renderSocialSignIn(harness);

    const google = await screen.findByTestId("social-button-google");
    const badge = within(google).getByText("Last used");
    const positioner = badge.parentElement;
    expect(positioner?.className).toContain("absolute");
    expect(positioner?.className).toContain("right-2");
    expect(google.textContent).toContain("Continue with Google");
    expect(within(google).getByText("Continue with Google").className).toContain("truncate");
    // The badge is 4.75rem wide at the right edge. Every block button reserves that space, so the
    // centred labels keep one left edge instead of shifting the badged one 19px off the column.
    const github = screen.getByTestId("social-button-github");
    for (const button of [google, github]) {
      expect(button.className).toContain("pr-[4.75rem]");
      expect(button.className).toContain("has-[>svg]:pr-[4.75rem]");
    }
    expect(within(github).queryByText("Last used")).toBeNull();
  });

  it("renders a custom provider with its display name and uploaded logo", async () => {
    const environment = authEnvironment();
    environment.userSettings.social = {
      custom_acme: {
        enabled: true,
        name: "Acme ID",
        strategy: "oauth_custom_acme",
        authenticatable: true,
        logoUrl: "https://cdn.acme.test/icon.svg",
      },
    };
    const harness = setupAuth({ signedIn: false, environment });
    makeSignIn(harness.instance);
    renderSocialSignIn(harness);

    const acme = await screen.findByTestId("social-button-custom_acme");
    expect(acme.textContent).toContain("Continue with Acme ID");
    expect(acme.querySelector("img")?.getAttribute("src")).toBe("https://cdn.acme.test/icon.svg");
  });

  it("keeps the reserved padding on inline-svg and logo-url providers alike", async () => {
    const environment = authEnvironment();
    environment.userSettings.social = {
      google: {
        enabled: true,
        name: "Google",
        strategy: "oauth_google",
        authenticatable: true,
        logoUrl: "https://cdn.example.com/google.svg",
      },
      github: { enabled: true, name: "GitHub", strategy: "oauth_github", authenticatable: true, logoUrl: "" },
    };
    const harness = setupAuth({ signedIn: false, environment });
    harness.instance.lastUsedStrategy = "oauth_github";
    makeSignIn(harness.instance);
    renderSocialSignIn(harness);

    const google = await screen.findByTestId("social-button-google");
    const github = screen.getByTestId("social-button-github");
    // A logo_url renders an <img>; a provider without one renders the inline <svg> brand mark.
    expect(google.querySelector("img")).toBeTruthy();
    expect(github.querySelector("svg")).toBeTruthy();
    for (const button of [google, github]) {
      expect(button.className).toContain("pr-[4.75rem]");
      // The base button size applies `has-[>svg]:px-3`, so the reserved padding has to repeat the
      // variant or it is overridden and the badge draws over the label for inline-svg providers.
      expect(button.className).toContain("has-[>svg]:pr-[4.75rem]");
    }
  });

  it("does not reserve badge space on block buttons when no provider is last used", async () => {
    const environment = authEnvironment();
    environment.userSettings.social = {
      google: { enabled: true, name: "Google", strategy: "oauth_google", authenticatable: true, logoUrl: "" },
      github: { enabled: true, name: "GitHub", strategy: "oauth_github", authenticatable: true, logoUrl: "" },
    };
    const harness = setupAuth({ signedIn: false, environment });
    makeSignIn(harness.instance);
    renderSocialSignIn(harness);

    const google = await screen.findByTestId("social-button-google");
    const github = screen.getByTestId("social-button-github");
    for (const button of [google, github]) {
      expect(button.className).not.toContain("pr-[4.75rem]");
      expect(button.className).not.toContain("has-[>svg]:pr-[4.75rem]");
    }
  });

  it("keeps a long custom provider label inside the card", async () => {
    const environment = authEnvironment();
    const longName = `Acme Identity ${"Custom OIDC ".repeat(12)}`.trim();
    environment.userSettings.social = {
      custom_acme: { enabled: true, name: longName, strategy: "oauth_custom_acme", authenticatable: true, logoUrl: "" },
    };
    const harness = setupAuth({ signedIn: false, environment });
    makeSignIn(harness.instance);
    renderSocialSignIn(harness);

    const button = await screen.findByTestId("social-button-custom_acme");
    expect(button.className).toContain("max-w-full");
    expect(button.className).toContain("min-w-0");
    expect(within(button).getByText(`Continue with ${longName}`).className).toContain("truncate");
  });
});
