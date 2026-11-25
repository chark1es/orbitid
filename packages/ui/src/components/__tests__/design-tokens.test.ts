import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "../ui/button";
import { badgeVariants } from "../ui/badge";

const UI_DIR = join(process.cwd(), "src/components/ui");

/** Overlays are the only primitives that may carry the deep `shadow-overlay` elevation. */
const OVERLAY_FILES = new Set([
  "alert-dialog",
  "command",
  "dialog",
  "drawer",
  "dropdown-menu",
  "popover",
  "select",
  "sheet",
  "tooltip",
]);

const primitiveFiles = readdirSync(UI_DIR)
  .filter((file) => file.endsWith(".tsx"))
  .map((file) => ({ name: basename(file, ".tsx"), text: readFileSync(join(UI_DIR, file), "utf8") }));

describe("design tokens in UI primitives", () => {
  it("uses only the elevation tokens, never Tailwind's stock or arbitrary shadows", () => {
    // DESIGN.md: a 1px border plus `shadow-xs` on resting surfaces, `shadow-card` on the auth card,
    // `shadow-overlay` on overlays. Every one is scaled by `--shadow-strength`.
    for (const file of primitiveFiles) {
      expect(file.text, `${file.name} must use an elevation token`).not.toMatch(/\bshadow-(?:md|lg|xl|2xl)\b/);
      expect(file.text, `${file.name} must use an elevation token`).not.toMatch(/\bshadow-\[/);
    }
  });

  it("keeps the single subtle shadow on overlays only", () => {
    for (const file of primitiveFiles) {
      if (!file.text.includes("shadow-overlay")) continue;
      expect(OVERLAY_FILES.has(file.name), `${file.name} is not an overlay`).toBe(true);
    }
  });

  it("never uses the off-spec 2px radius", () => {
    for (const file of primitiveFiles) {
      expect(file.text, `${file.name} must use a 3/4/6px radius`).not.toContain("rounded-[2px]");
      expect(file.text, `${file.name} must use a 3/4/6px radius`).not.toMatch(/\brounded-xs\b/);
    }
    expect(buttonVariants({ variant: "outline" })).not.toContain("rounded-[2px]");
    expect(badgeVariants()).not.toContain("rounded-[2px]");
  });

  it("lifts controls by a hairline at most", () => {
    expect(buttonVariants()).toContain("shadow-xs");
    expect(buttonVariants()).not.toMatch(/shadow-(?:sm|md|lg|card|overlay)\b/);
    expect(badgeVariants()).not.toMatch(/\bshadow-/);
  });

  it("declares the keyboard ring once, so SDK components cannot lose it", () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ring\)/);
    expect(styles.match(/:focus-visible\s*\{/g)?.length).toBe(2);
  });

  it("scales every elevation from one strength token", () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    for (const token of ["--shadow-xs", "--shadow-sm", "--shadow-card", "--shadow-overlay"]) {
      const declaration = styles.slice(styles.indexOf(`${token}:`), styles.indexOf(";", styles.indexOf(`${token}:`)));
      expect(declaration, token).toContain("var(--shadow-strength)");
    }
  });
});

describe("the dark: variant", () => {
  const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
  const block = styles.slice(styles.indexOf("@custom-variant dark {"), styles.indexOf(":root,"));
  // Each `&<selector> { @slot; }` rule of the variant, as a selector the browser can match on its own.
  const selectors = [...block.matchAll(/^\s*&(.+?)\s*\{\s*$/gm)].map((match) => match[1]!);

  /** Nest `<div class=…>` for each class (outermost first) and say whether the innermost gets `dark:` utilities. */
  function darkAt(...classes: string[]): boolean {
    let parent: HTMLElement = document.body;
    for (const name of classes) {
      const child = document.createElement("div");
      if (name) child.className = name;
      parent.appendChild(child);
      parent = child;
    }
    const matched = selectors.some((selector) => parent.matches(selector));
    document.body.innerHTML = "";
    return matched;
  }

  it("is declared", () => {
    expect(selectors.length).toBeGreaterThan(0);
  });

  it("applies inside a dark page and on a dark element itself", () => {
    expect(darkAt("dark", "")).toBe(true);
    expect(darkAt("dark")).toBe(true);
    expect(darkAt("light", "dark", "")).toBe(true);
  });

  it("does not apply on a light page", () => {
    expect(darkAt("", "")).toBe(false);
    expect(darkAt("light", "")).toBe(false);
  });

  it("does not leak into a light surface inside a dark page", () => {
    expect(darkAt("dark", "light", "")).toBe(false);
    expect(darkAt("dark", "light")).toBe(false);
  });

  it("applies again to a dark surface inside that light one", () => {
    expect(darkAt("dark", "light", "dark", "")).toBe(true);
  });
});
