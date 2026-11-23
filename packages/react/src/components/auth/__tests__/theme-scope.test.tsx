import type { ReactNode } from "react";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { AuthCard } from "../_shared/auth-card";
import { ConfirmDialog } from "../_shared/confirm-dialog";
import { ConfirmDialog as OrgConfirmDialog } from "../../org/_shared/ConfirmDialog";
import { OrgRoot } from "../../org/_shared/OrgRoot";
import { ProviderIcon } from "../_shared/provider-icon";
import { dark, light, type Appearance } from "../../../appearance";
import { authEnvironment, renderAuth, setupAuth } from "./fake-auth";

const realMatchMedia = window.matchMedia;

/** The operating system's scheme, as `prefers-color-scheme` reports it. */
function osScheme(scheme: "light" | "dark") {
  window.matchMedia = ((query: string) => ({
    matches: scheme === "dark" && query.includes("dark"),
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
}

/** The instance's branding theme for hosted components. */
function renderCard(brandingTheme: "system" | "light" | "dark", appearance?: Appearance) {
  const environment = authEnvironment();
  environment.displayConfig.theme = brandingTheme;
  // The instance's default brand color: a near-black that only reads on a light surface.
  environment.displayConfig.primaryColor = "#2b2522";
  const harness = setupAuth({ signedIn: false, environment });
  const { container } = renderAuth(<AuthCard title="Sign in">fields</AuthCard>, harness, appearance ? { appearance } : {});
  return () => container.querySelector('[data-orbit-component="auth-card"]') as HTMLElement;
}

afterEach(() => {
  // Unmount first: resetting <html> under a mounted card would re-render it outside act().
  cleanup();
  window.matchMedia = realMatchMedia;
  const root = document.documentElement;
  root.className = "";
  root.removeAttribute("data-theme");
  root.style.colorScheme = "";
});

describe("prebuilt components follow the page's light/dark scheme", () => {
  it("renders dark on a page that marks itself dark, even when the operating system is light", () => {
    osScheme("light");
    document.documentElement.classList.add("dark");
    const card = renderCard("system");
    expect(card().dataset.orbitTheme).toBe("dark");
    expect(card().classList.contains("dark")).toBe(true);
  });

  it("stays light on a page the visitor switched to light, even when the operating system is dark", () => {
    osScheme("dark");
    document.documentElement.classList.add("light");
    const card = renderCard("system");
    expect(card().dataset.orbitTheme).toBe("light");
    expect(card().classList.contains("dark")).toBe(false);
  });

  it("reads the scheme from `data-theme` and from an inline `color-scheme` too", () => {
    osScheme("light");
    document.documentElement.setAttribute("data-theme", "dark");
    expect(renderCard("system")().dataset.orbitTheme).toBe("dark");
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "dark";
    expect(renderCard("system")().dataset.orbitTheme).toBe("dark");
  });

  it("falls back to the operating system on a page that marks no scheme", () => {
    osScheme("dark");
    expect(renderCard("system")().dataset.orbitTheme).toBe("dark");
  });

  it("follows the page when it switches scheme while the component is mounted", async () => {
    osScheme("light");
    const card = renderCard("system");
    expect(card().dataset.orbitTheme).toBe("light");
    act(() => {
      document.documentElement.classList.add("dark");
      document.documentElement.style.colorScheme = "dark";
    });
    await waitFor(() => expect(card().dataset.orbitTheme).toBe("dark"));
    act(() => {
      document.documentElement.classList.remove("dark");
      document.documentElement.style.colorScheme = "light";
    });
    await waitFor(() => expect(card().dataset.orbitTheme).toBe("light"));
  });

  it("keeps a branding theme of light light inside a dark page, with the class that restores light tokens", () => {
    osScheme("dark");
    document.documentElement.classList.add("dark");
    const card = renderCard("light");
    expect(card().dataset.orbitTheme).toBe("light");
    expect(card().classList.contains("light")).toBe(true);
    expect(card().classList.contains("dark")).toBe(false);
  });

  it.each([
    ["a branding theme of light", "light", undefined],
    ["the README's `baseTheme: isDark ? dark : light`", "system", { baseTheme: light }],
  ] as const)("adds no light class on a light page for %s, so the page's own tokens still apply", (_label, branding, appearance) => {
    osScheme("light");
    const environment = authEnvironment();
    environment.displayConfig.theme = branding;
    const { container } = renderAuth(
      <AuthCard title="Sign in">fields</AuthCard>,
      setupAuth({ signedIn: false, environment }),
      appearance ? { appearance } : {},
    );
    const wrapper = container.querySelector("[data-orbitid-theme]") as HTMLElement;
    const card = container.querySelector('[data-orbit-component="auth-card"]') as HTMLElement;
    expect(card.dataset.orbitTheme).toBe("light");
    // `.light` restores the bundled light tokens, which would override the host's own `:root` customisations.
    for (const element of [wrapper, card, ...card.querySelectorAll("*")]) {
      expect(element.classList.contains("light")).toBe(false);
    }
  });

  it("keeps a scheme class off the provider wrapper around the host's own app", () => {
    osScheme("light");
    const { container } = renderAuth(<AuthCard title="Sign in">fields</AuthCard>, setupAuth({ signedIn: false }), {
      appearance: { baseTheme: dark },
    });
    const wrapper = container.querySelector("[data-orbitid-theme]") as HTMLElement;
    expect(wrapper.classList.contains("dark")).toBe(false);
    expect(wrapper.classList.contains("light")).toBe(false);
    // The component itself still renders in the forced scheme.
    expect(container.querySelector('[data-orbit-component="auth-card"]')?.classList.contains("dark")).toBe(true);
  });

  it("lets the integrating app's base theme override the branding theme", () => {
    osScheme("light");
    expect(renderCard("dark", { baseTheme: light })().dataset.orbitTheme).toBe("light");
    expect(renderCard("light", { baseTheme: dark })().dataset.orbitTheme).toBe("dark");
  });

  it("keeps the instance's dark brand color off the dark surface, where it would vanish", () => {
    osScheme("dark");
    document.documentElement.classList.add("dark");
    const card = renderCard("system");
    // On a dark card the button keeps the theme's light primary instead.
    expect(card().style.getPropertyValue("--primary")).toBe("");
  });

  it("applies a dark brand color when the page is light, even if the operating system is dark", () => {
    osScheme("dark");
    document.documentElement.classList.add("light");
    const card = renderCard("system");
    expect(card().style.getPropertyValue("--primary")).toBe("#2b2522");
  });
});

describe("portaled surfaces carry the component's scheme", () => {
  // A portal renders under <body>, outside the component's root and its scheme class.
  function renderForcedDark(ui: ReactNode) {
    osScheme("light");
    return renderAuth(ui, setupAuth({ signedIn: false }), { appearance: { baseTheme: dark } });
  }

  it("puts `dark` on an open confirm dialog when the component is forced dark on a light page", () => {
    renderForcedDark(<ConfirmDialog open onOpenChange={() => {}} title="Remove passkey?" onConfirm={() => {}} />);
    const dialog = screen.getByRole("alertdialog");
    expect(dialog.closest('[data-orbitid-theme]')).toBeNull();
    expect(dialog.classList.contains("dark")).toBe(true);
  });

  it("puts `dark` on an open organization confirm dialog too", () => {
    renderForcedDark(<OrgConfirmDialog open onOpenChange={() => {}} title="Delete organization?" onConfirm={() => {}} />);
    const dialog = screen.getByRole("dialog");
    expect(dialog.closest('[data-orbitid-theme]')).toBeNull();
    expect(dialog.classList.contains("dark")).toBe(true);
  });

  it("renders a forced-dark organization component dark, now that `dark` is not in rootClassName", () => {
    const { container } = renderForcedDark(<OrgRoot requiresOrganizations={false}>members</OrgRoot>);
    expect(container.querySelector(".orbitid-org")?.classList.contains("dark")).toBe(true);
  });

  it("gives every portaled `*Content` in the components the scheme class", () => {
    const tag = /<(?:AlertDialog|Dialog|DropdownMenu|DropdownMenuSub|Popover|Select|Tooltip|Sheet|Drawer|HoverCard|ContextMenu)Content\b(?:=>|[^>])*>/g;
    // Anchored to this file, so the scan works whichever directory vitest starts in.
    const files = tsxFiles(resolve(dirname(fileURLToPath(import.meta.url)), "../.."));
    const tags = files.flatMap((file) => [...readFileSync(file, "utf8").matchAll(tag)].map((match) => ({ file, source: match[0] })));
    // Guards against a scan that silently finds nothing.
    expect(tags.length).toBeGreaterThan(20);
    const offenders = tags
      .filter(({ source }) => !source.includes("portalClass(") && !source.includes("themeClass"))
      .map(({ file, source }) => `${file}: ${source.split("\n")[0]}`);
    expect(offenders).toEqual([]);
  });
});

function tsxFiles(root: string): string[] {
  return readdirSync(root).flatMap((entry) => {
    const path = join(root, entry);
    if (statSync(path).isDirectory()) return entry === "__tests__" ? [] : tsxFiles(path);
    return path.endsWith(".tsx") ? [path] : [];
  });
}

describe("provider marks", () => {
  it("draws black marks in the text colour, so they stay visible on a dark button", () => {
    const { container } = render(<ProviderIcon provider="oauth_tiktok" />);
    expect(container.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
  });
});
