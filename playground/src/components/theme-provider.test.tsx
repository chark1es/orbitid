// @vitest-environment jsdom
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ThemeProvider, useTheme } from "./theme-provider";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const KEY = "orbitid-playground-theme";

function Probe() {
  const { theme, toggle } = useTheme();
  return (
    <button type="button" onClick={toggle} data-theme={theme}>
      {theme}
    </button>
  );
}

let host: HTMLDivElement;
let root: Root;

const mount = () => {
  act(() => root.render(<ThemeProvider><Probe /></ThemeProvider>));
  return host.querySelector("button")!;
};

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  document.documentElement.classList.remove("dark");
  window.localStorage.clear();
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("playground theme toggle", () => {
  it("starts in the theme the inline script already applied, without a light flash", () => {
    document.documentElement.classList.add("dark");
    const button = mount();
    expect(button.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("switches the page and remembers the choice, then switches back", () => {
    const button = mount();
    expect(button.dataset.theme).toBe("light");

    act(() => button.click());
    expect(button.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
    expect(window.localStorage.getItem(KEY)).toBe("dark");

    act(() => button.click());
    expect(button.dataset.theme).toBe("light");
    expect(document.documentElement.classList.contains("dark")).toBe(false);
    expect(window.localStorage.getItem(KEY)).toBe("light");
  });

  it("still switches when storage is blocked", () => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = () => {
      throw new DOMException("blocked", "SecurityError");
    };
    try {
      const button = mount();
      act(() => button.click());
      expect(button.dataset.theme).toBe("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);
    } finally {
      Storage.prototype.setItem = original;
    }
  });

  it("follows a change made in another tab", () => {
    const button = mount();
    act(() => {
      window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "dark" }));
    });
    expect(button.dataset.theme).toBe("dark");
    expect(document.documentElement.classList.contains("dark")).toBe(true);
  });

  it("does not leak listeners after unmount", () => {
    mount();
    act(() => root.unmount());
    root = createRoot(host);
    window.dispatchEvent(new StorageEvent("storage", { key: KEY, newValue: "dark" }));
    // The unmounted provider must not have touched the page: only the next mount decides the theme.
    expect(document.documentElement.classList.contains("dark")).toBe(false);
  });
});
