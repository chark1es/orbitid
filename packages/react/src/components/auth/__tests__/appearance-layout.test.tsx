import { describe, expect, it } from "vitest";
import { screen } from "@testing-library/react";
import type { AppearanceLayout } from "../../../appearance";
import { SignIn } from "../sign-in";
import { SignUp } from "../sign-up";
import { usePortalClass } from "../_shared/appearance";
import { ComponentRoot, scopeDeclarations } from "../_shared/component-root";
import { authEnvironment, renderAuth, setupAuth } from "./fake-auth";

function environment() {
  const env = authEnvironment();
  env.userSettings.social = {
    google: { enabled: true, name: "Google", strategy: "oauth_google", authenticatable: true, logoUrl: "" },
    github: { enabled: true, name: "GitHub", strategy: "oauth_github", authenticatable: true, logoUrl: "" },
  };
  (env.displayConfig as unknown as Record<string, unknown>).developmentMode = true;
  env.displayConfig.termsUrl = "https://example.com/terms";
  return env;
}

async function renderSignIn(layout: AppearanceLayout, where: "provider" | "component" = "component") {
  const harness = setupAuth({ signedIn: false, environment: environment() });
  const appearance = { layout };
  const result = renderAuth(
    <SignIn routing="virtual" appearance={where === "component" ? appearance : undefined} />,
    harness,
    where === "provider" ? { appearance } : {},
  );
  await screen.findByTestId("social-button-google");
  return result;
}

const card = () => document.querySelector('[data-orbit-component="auth-card"]') as HTMLElement;

describe("appearance.layout", () => {
  it("places the logo inside the header by default, above the card, or nowhere", async () => {
    const inside = await renderSignIn({});
    expect(card().querySelector(".orbitid-cardBox .orbitid-logoBox")).not.toBeNull();
    inside.unmount();

    const outside = await renderSignIn({ logoPlacement: "outside", logoImageUrl: "https://example.com/logo.png" });
    const logo = card().querySelector(".orbitid-logoBox") as HTMLElement;
    expect(logo.closest(".orbitid-cardBox")).toBeNull();
    expect(logo.querySelector("img")?.getAttribute("src")).toBe("https://example.com/logo.png");
    outside.unmount();

    await renderSignIn({ logoPlacement: "none" });
    expect(card().querySelector(".orbitid-logoBox")).toBeNull();
  });

  it("puts social buttons above or below the form", async () => {
    const top = await renderSignIn({});
    const order = () => {
      const social = card().querySelector(".orbitid-socialButtons")!;
      const form = card().querySelector("form")!;
      return social.compareDocumentPosition(form) & Node.DOCUMENT_POSITION_FOLLOWING ? "top" : "bottom";
    };
    expect(order()).toBe("top");
    top.unmount();
    await renderSignIn({ socialButtonsPlacement: "bottom" });
    expect(order()).toBe("bottom");
  });

  it("switches social buttons between block and icon variants", async () => {
    const block = await renderSignIn({ socialButtonsVariant: "blockButton" });
    expect(card().querySelectorAll(".orbitid-socialButtonsBlockButton")).toHaveLength(2);
    block.unmount();
    await renderSignIn({ socialButtonsVariant: "iconButton" });
    expect(card().querySelectorAll(".orbitid-socialButtonsIconButton")).toHaveLength(2);
    expect(card().querySelector(".orbitid-socialButtonsBlockButton")).toBeNull();
  });

  it("shows footer pages from layout URLs first, and hides them on request", async () => {
    const shown = await renderSignIn({ helpPageUrl: "https://example.com/help", privacyPageUrl: "https://example.com/privacy" });
    const links = [...card().querySelectorAll(".orbitid-footerPagesLink")].map((link) => [link.textContent, link.getAttribute("href")]);
    expect(links).toEqual([
      ["Help", "https://example.com/help"],
      ["Privacy", "https://example.com/privacy"],
      ["Terms", "https://example.com/terms"],
    ]);
    shown.unmount();
    await renderSignIn({ showFooterPages: false });
    expect(card().querySelector(".orbitid-footerPages")).toBeNull();
  });

  it("hides the branding line and the development banner on request", async () => {
    const defaults = await renderSignIn({});
    expect(card().querySelector(".orbitid-securedBy")).not.toBeNull();
    expect(card().querySelector(".orbitid-developmentModeBanner")).not.toBeNull();
    defaults.unmount();
    await renderSignIn({ showBranding: false, showDevelopmentModeWarning: false });
    expect(card().querySelector(".orbitid-securedBy")).toBeNull();
    expect(card().querySelector(".orbitid-developmentModeBanner")).toBeNull();
  });

  it("turns motion off with animations: false, from the provider too", async () => {
    await renderSignIn({ animations: false }, "provider");
    expect(card().classList).toContain("orbitid-motion-off");
  });

  it("hides optional name fields on sign-up with showOptionalFields: false", async () => {
    const harness = setupAuth({ signedIn: false });
    const shown = renderAuth(<SignUp routing="virtual" />, harness);
    expect(await screen.findByLabelText(/First name/i)).toBeTruthy();
    shown.unmount();
    renderAuth(<SignUp routing="virtual" appearance={{ layout: { showOptionalFields: false } }} />, harness);
    await screen.findAllByLabelText(/Email address/i);
    expect(screen.queryByLabelText(/First name/i)).toBeNull();
  });
});

describe("portaled content", () => {
  it("gets the component's custom properties through a scope class whose rule lives in <head>", async () => {
    function Probe() {
      const portalClass = usePortalClass();
      return <span data-testid="portal" className={portalClass("extra")} />;
    }
    const harness = setupAuth({ signedIn: false });
    const { unmount } = renderAuth(
      <ComponentRoot component="probe">
        <Probe />
      </ComponentRoot>,
      harness,
      { appearance: { variables: { colorPrimary: "#2563eb", borderRadius: "12px" } } },
    );
    const classes = screen.getByTestId("portal").className.split(" ");
    const scope = classes.find((name) => name.startsWith("orbitid-scope-"))!;
    expect(classes).toEqual(expect.arrayContaining(["orbitid-component", "extra"]));
    const rule = document.head.querySelector(`style[data-orbitid-scope="${scope}"]`)?.textContent ?? "";
    expect(rule).toContain(`.${scope}{`);
    expect(rule).toContain("--primary:#2563eb");
    expect(rule).toContain("--radius:12px");
    unmount();
    expect(document.head.querySelector(`style[data-orbitid-scope="${scope}"]`)).toBeNull();
  });

  it("refuses values that could break out of the rule", () => {
    expect(scopeDeclarations({ "--a": "red", "--b": "red;}body{display:none", "not-a-var": "x" })).toBe("--a:red");
  });
});
