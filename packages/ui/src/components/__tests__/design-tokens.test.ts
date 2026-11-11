import { readFileSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { describe, expect, it } from "vitest";
import { buttonVariants } from "../ui/button";
import { badgeVariants } from "../ui/badge";

const UI_DIR = join(process.cwd(), "src/components/ui");

/** Overlays are the one place DESIGN.md allows a single soft shadow. */
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
  it("allows no elevation shadow outside overlays", () => {
    for (const file of primitiveFiles) {
      if (OVERLAY_FILES.has(file.name)) continue;
      expect(file.text, `${file.name} must not carry a shadow`).not.toMatch(/shadow-(?:xs|sm|md|lg|xl|2xl)\b/);
      expect(file.text, `${file.name} must not carry a shadow`).not.toMatch(/(?<!overlay-)shadow-(?!none)\w/);
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

  it("styles controls with the ruled outline, not a shadow", () => {
    expect(buttonVariants()).not.toMatch(/shadow-(?:xs|sm|md|lg)\b/);
    expect(badgeVariants()).not.toMatch(/shadow-(?:xs|sm|md|lg)\b/);
  });

  it("declares the signal-red keyboard ring once, so SDK components cannot lose it", () => {
    const styles = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
    expect(styles).toMatch(/:focus-visible\s*\{[^}]*outline:\s*2px solid var\(--ring\)/);
    expect(styles).toMatch(/--ring:\s*oklch\(0\.57 0\.235 28\)/);
  });
});
