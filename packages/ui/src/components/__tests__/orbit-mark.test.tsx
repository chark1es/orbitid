import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { APP_ICON_COLORS, AppIcon, ORBIT_GLYPH, OrbitMark } from "../orbit-mark";

describe("OrbitMark", () => {
  it("draws the light glyph, switching to the dark one under the dark variant, in currentColor", () => {
    const { container } = render(<OrbitMark />);
    const svg = container.querySelector("svg");
    expect(svg?.getAttribute("viewBox")).toBe("0 0 64 64");
    const light = svg?.querySelector('[data-scheme="light"]');
    const dark = svg?.querySelector('[data-scheme="dark"]');
    expect(light?.getAttribute("d")).toBe(ORBIT_GLYPH.light);
    expect(light?.getAttribute("class")).toBe("dark:hidden");
    expect(light?.getAttribute("fill")).toBe("currentColor");
    expect(dark?.getAttribute("d")).toBe(ORBIT_GLYPH.dark);
    expect(dark?.getAttribute("class")).toBe("hidden dark:inline");
    expect(dark?.getAttribute("fill")).toBe("currentColor");
  });

  it("draws only one glyph when the scheme is pinned", () => {
    const { container } = render(<OrbitMark scheme="dark" color="var(--primary)" />);
    const glyphs = container.querySelectorAll('[data-part="glyph"]');
    expect(glyphs).toHaveLength(1);
    expect(glyphs[0]?.getAttribute("d")).toBe(ORBIT_GLYPH.dark);
    expect(glyphs[0]?.getAttribute("fill")).toBe("var(--primary)");
    expect(glyphs[0]?.getAttribute("class")).toBeNull();
  });

  it("names itself only when a title is supplied", () => {
    const { rerender } = render(<OrbitMark />);
    expect(screen.queryByRole("img")).toBeNull();
    rerender(<OrbitMark title="OrbitID" />);
    expect(screen.getByRole("img", { name: "OrbitID" })).toBeTruthy();
  });
});

describe("AppIcon", () => {
  it("draws a paper tile in light mode and an ink tile in dark mode", () => {
    const { container } = render(<AppIcon />);
    const light = container.querySelector('[data-part="tile"][data-scheme="light"]');
    const dark = container.querySelector('[data-part="tile"][data-scheme="dark"]');
    expect(light?.getAttribute("class")).toBe("dark:hidden");
    expect(light?.querySelector("rect")?.getAttribute("fill")).toBe(APP_ICON_COLORS.light.tile);
    expect(light?.querySelector("path")?.getAttribute("fill")).toBe(APP_ICON_COLORS.light.glyph);
    expect(dark?.getAttribute("class")).toBe("hidden dark:inline");
    expect(dark?.querySelector("rect")?.getAttribute("fill")).toBe(APP_ICON_COLORS.dark.tile);
    expect(dark?.querySelector("path")?.getAttribute("fill")).toBe(APP_ICON_COLORS.dark.glyph);
  });

  it("matches the icon files in assets/", () => {
    const root = join(process.cwd(), "../..");
    const light = readFileSync(join(root, "assets/icon.svg"), "utf8");
    const dark = readFileSync(join(root, "assets/icon-dark.svg"), "utf8");
    expect(light).toContain(`d="${ORBIT_GLYPH.light}"`);
    expect(light).toContain(`fill="${APP_ICON_COLORS.light.tile}"`);
    expect(dark).toContain(`d="${ORBIT_GLYPH.dark}"`);
    expect(dark).toContain(`fill="${APP_ICON_COLORS.dark.tile}"`);
  });
});
