import { afterEach, describe, expect, it } from "vitest";
import { act, cleanup, render, waitFor } from "@testing-library/react";
import { AuthCard } from "../_shared/auth-card";
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

  it("adds no light class on a light page, so the page's own tokens still apply", () => {
    osScheme("light");
    expect(renderCard("light")().classList.contains("light")).toBe(false);
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

describe("provider marks", () => {
  it("draws black marks in the text colour, so they stay visible on a dark button", () => {
    const { container } = render(<ProviderIcon provider="oauth_tiktok" />);
    expect(container.querySelector("svg")?.getAttribute("fill")).toBe("currentColor");
  });
});
