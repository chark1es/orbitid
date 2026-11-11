import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as React from "react";
import { renderToString } from "react-dom/server";
import { hydrateRoot, type Root } from "react-dom/client";
import { act } from "react";
import { ThemeProvider, initTheme, themeBootstrapScript, useTheme } from "../../theme-provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const STORAGE_KEY = "orbitid-theme";

function Probe() {
  const { theme, resolvedTheme } = useTheme();
  return <span>{`${theme}:${resolvedTheme}`}</span>;
}

function tree() {
  return (
    <ThemeProvider storageKey={STORAGE_KEY}>
      <Probe />
    </ThemeProvider>
  );
}

/** Render as the server does: no `window`, no `localStorage`, no `matchMedia`. */
function renderOnServer(): string {
  const realWindow = globalThis.window;
  // The test environment is jsdom, so SSR has to be simulated by hiding the browser globals the provider checks.
  delete (globalThis as { window?: Window }).window;
  try {
    return renderToString(tree());
  } finally {
    globalThis.window = realWindow;
  }
}

describe("ThemeProvider hydration", () => {
  let root: Root | null = null;

  beforeEach(() => {
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
  });

  afterEach(() => {
    root?.unmount();
    root = null;
    localStorage.clear();
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    vi.restoreAllMocks();
  });

  it("hydrates without a mismatch when the stored theme is dark but the server rendered light", async () => {
    localStorage.setItem(STORAGE_KEY, "dark");
    // The server cannot see localStorage: deterministic `system:light` markup.
    const html = renderOnServer();
    expect(html).toContain("system:light");

    const container = document.createElement("div");
    container.innerHTML = html;
    document.body.appendChild(container);
    const errors: string[] = [];
    const consoleError = vi.spyOn(console, "error").mockImplementation((...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    });

    // `hydrateRoot` is synchronous in React 19; `act` flushes the post-hydration snapshot switch too.
    await act(async () => {
      root = hydrateRoot(container, tree());
    });

    expect(errors.join("\n")).not.toMatch(/hydration|did not match|server rendered HTML|text content does not match/i);
    // The stored preference wins after hydration, and the document class follows it.
    expect(container.textContent).toBe("dark:dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(document.documentElement.style.colorScheme).toBe("dark");
    expect(consoleError).toHaveBeenCalledTimes(0);
    container.remove();
  });

  it("keeps a client-only app flash-free through initTheme and the pre-paint bootstrap", () => {
    localStorage.setItem(STORAGE_KEY, "dark");
    expect(initTheme(STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);

    // The exported bootstrap applies the same choice before React mounts, for server-rendered apps.
    document.documentElement.classList.remove("dark");
    document.documentElement.style.colorScheme = "";
    localStorage.setItem(STORAGE_KEY, "system");
    new Function(themeBootstrapScript(STORAGE_KEY))();
    // jsdom's matchMedia stub reports light; the point is that the bootstrap ran and set a colour scheme.
    expect(document.documentElement.style.colorScheme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
