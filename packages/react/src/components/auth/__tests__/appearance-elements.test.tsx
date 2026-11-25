import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { Badge, Button, ElementSlotProvider, type ElementSlotResolver } from "@orbitid/ui";
import { COMPONENT_ELEMENTS, ELEMENT_KEYS, PRIMITIVE_ELEMENTS, VARIABLE_MAP, type Appearance } from "../../../appearance";
import { SignIn } from "../sign-in";
import { UserProfile } from "../user-profile";
import { authEnvironment, authUser, renderAuth, setupAuth } from "./fake-auth";

const here = dirname(fileURLToPath(import.meta.url));
const reactSrc = resolve(here, "../../..");
const uiSrc = resolve(reactSrc, "../../ui/src/components/ui");
const repoRoot = resolve(reactSrc, "../../..");

function sourceFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : sourceFiles(path);
    return /\.tsx?$/.test(path) ? [path] : [];
  });
}

/** Every component element key the prebuilt components attach, by the ways they can attach one. */
function componentKeysInSource(): Set<string> {
  const keys = new Set<string>();
  const patterns = [
    /\bep\(\s*"(\w+)"/g,
    /\bep\(\s*\[([^\]]+)\]/g,
    /\belement="(\w+)"/g,
    /data-orbitid-element="(\w+)"/g,
    /useElementClasses\("(\w+)"\)/g,
    /\["(rootBox)"/g,
  ];
  for (const file of sourceFiles(join(reactSrc, "components")).concat(sourceFiles(join(reactSrc, "control")))) {
    const text = readFileSync(file, "utf8");
    for (const pattern of patterns) {
      for (const match of text.matchAll(pattern)) {
        for (const key of match[1]!.split(",")) keys.add(key.trim().replace(/"/g, ""));
      }
    }
  }
  return keys;
}

/** Slot keys the `@orbitid/ui` primitives declare literally. */
function primitiveKeysInSource(): Set<string> {
  const keys = new Set<string>();
  for (const file of sourceFiles(uiSrc)) {
    for (const match of readFileSync(file, "utf8").matchAll(/useElementSlot\(\[([^\]]*)\]/g)) {
      for (const key of match[1]!.split(",")) if (key.trim()) keys.add(key.trim().replace(/"/g, ""));
    }
  }
  return keys;
}

describe("element key coverage", () => {
  it("lists every key a component attaches, and every listed component key is attached somewhere", () => {
    const used = componentKeysInSource();
    expect(used.size).toBeGreaterThan(40);
    const unknown = [...used].filter((key) => !(key in ELEMENT_KEYS));
    expect(unknown, "keys used in components but missing from ELEMENT_KEYS").toEqual([]);
    const unused = Object.keys(COMPONENT_ELEMENTS).filter((key) => !used.has(key));
    expect(unused, "keys in COMPONENT_ELEMENTS that no component attaches").toEqual([]);
  });

  it("matches the primitive keys to what the @orbitid/ui primitives declare", () => {
    const declared = primitiveKeysInSource();
    const requested = new Set<string>(declared);
    const record: ElementSlotResolver = (keys) => {
      keys.forEach((key) => requested.add(key));
      return {};
    };
    const variants = ["default", "destructive", "outline", "secondary", "ghost", "link"] as const;
    render(
      <ElementSlotProvider value={record}>
        {variants.map((variant) => (
          <Button key={`b-${variant}`} variant={variant} />
        ))}
        {variants.map((variant) => (
          <Badge key={`c-${variant}`} variant={variant} />
        ))}
      </ElementSlotProvider>,
    );
    expect([...requested].sort()).toEqual(Object.keys(PRIMITIVE_ELEMENTS).sort());
  });

  it("uses only text sizes that scale with appearance.variables.fontSize", () => {
    const fixed: string[] = [];
    for (const file of sourceFiles(join(reactSrc, "components"))) {
      for (const match of readFileSync(file, "utf8").matchAll(/\btext-\[(\d[^\]]*)\]/g)) fixed.push(`${file}: ${match[0]}`);
    }
    expect(fixed).toEqual([]);
  });

  it("documents every element key and every variable in docs/APPEARANCE.md", () => {
    const docs = readFileSync(join(repoRoot, "docs/APPEARANCE.md"), "utf8");
    const missingKeys = Object.keys(ELEMENT_KEYS).filter((key) => !docs.includes(`\`${key}\``));
    expect(missingKeys).toEqual([]);
    const missingVariables = Object.keys(VARIABLE_MAP).filter((key) => !docs.includes(`\`${key}\``));
    expect(missingVariables).toEqual([]);
  });
});

/** Every key gets a probe class and a probe custom property, so the test can see where each one lands. */
function probeAppearance(): Appearance {
  const elements: Record<string, { className: string; style: Record<string, string> }> = {};
  for (const key of Object.keys(ELEMENT_KEYS)) elements[key] = { className: `probe-${key}`, style: { [`--probe-${key}`]: "1" } };
  return { elements, layout: { helpPageUrl: "https://example.com/help" } };
}

function expectApplied(key: string) {
  // The stable class marks an element a component attached the key to (the provider's own wrapper also takes
  // `rootBox` classes, without the stable class).
  const nodes = document.querySelectorAll(`.probe-${key}.orbitid-${key}`);
  expect(nodes.length, `no element carries ${key}`).toBeGreaterThan(0);
  expect((nodes[0] as HTMLElement).style.getPropertyValue(`--probe-${key}`), `${key} lacks its style`).toBe("1");
}

function socialEnvironment() {
  const environment = authEnvironment();
  environment.userSettings.social = {
    google: { enabled: true, name: "Google", strategy: "oauth_google", authenticatable: true, logoUrl: "" },
    github: { enabled: true, name: "GitHub", strategy: "oauth_github", authenticatable: true, logoUrl: "" },
  };
  return environment;
}

describe("elements are applied with className and style", () => {
  it("across the sign-in card, primitives included", async () => {
    const harness = setupAuth({ signedIn: false, environment: socialEnvironment() });
    renderAuth(<SignIn routing="virtual" />, harness, { appearance: probeAppearance() });
    await screen.findByTestId("social-button-google");
    for (const key of [
      "rootBox", "cardBox", "card", "cardHeader", "header", "headerTitle", "headerSubtitle", "logoBox", "logoImage",
      "main", "form", "formField", "formFieldLabel", "label", "formFieldInput", "input", "formButtonPrimary", "button",
      "buttonPrimary", "buttonOutline", "buttonLink", "socialButtons", "socialButtonsBlockButton",
      "socialButtonsBlockButtonText", "dividerRow", "dividerLine", "dividerText", "separator", "footer", "cardFooter",
      "footerAction", "footerActionText", "footerActionLink", "formButtonSecondary", "securedBy", "footerPages",
      "footerPagesLink",
    ]) {
      expectApplied(key);
    }
  });

  it("on the user profile", async () => {
    const harness = setupAuth({ user: authUser() });
    renderAuth(<UserProfile routing="virtual" />, harness, { appearance: probeAppearance() });
    await screen.findByRole("heading", { level: 1 });
    for (const key of ["userProfile", "cardBox", "navbar", "userProfileNavbar", "navbarButton", "navbarButtonIcon", "userProfilePage", "pageScrollBox", "profileSection", "profileSectionTitle", "headerTitle"]) {
      expectApplied(key);
    }
  });

  it("lets a component's appearance add to the provider's, in that order", async () => {
    const harness = setupAuth({ signedIn: false });
    renderAuth(
      <SignIn routing="virtual" appearance={{ elements: { cardBox: "component-card p-9" } }} />,
      harness,
      { appearance: { elements: { cardBox: "provider-card p-1" } } },
    );
    const card = (await screen.findByRole("heading", { level: 2 })).closest(".orbitid-cardBox") as HTMLElement;
    expect(card.className).toContain("provider-card");
    expect(card.className).toContain("component-card");
    expect(card.className).toContain("p-9");
    expect(card.className).not.toMatch(/\bp-1\b/);
  });

  it("drops OrbitID's classes with unstyled but keeps the stable hooks and user classes", async () => {
    const harness = setupAuth({ signedIn: false });
    renderAuth(<SignIn routing="virtual" appearance={{ unstyled: true, elements: { formButtonPrimary: "my-button" } }} />, harness);
    await screen.findByRole("heading", { level: 2 });
    const button = document.querySelector(".orbitid-formButtonPrimary") as HTMLElement;
    expect(button.className.split(" ").sort()).toEqual(
      ["my-button", "orbitid-button", "orbitid-buttonPrimary", "orbitid-formButtonPrimary"].sort(),
    );
  });
});
