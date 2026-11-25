// @vitest-environment node
import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const light = css.slice(css.indexOf(":root,"), css.indexOf(".dark {"));
const dark = css.slice(css.indexOf(".dark {"), css.indexOf("@theme inline"));

// Convert OKLCH to linear sRGB, clipping out-of-gamut channels just as the contrast calculation does.
function linearRgb(block: string, name: string): [number, number, number] {
  const value = block.match(new RegExp(`--${name}: oklch\\(([^)]+)\\)`))?.[1];
  if (!value) throw new Error(`Missing opaque token: ${name}`);
  const [L, C, h] = value.split(/\s+/).map(Number);
  const a = C! * Math.cos(h! * Math.PI / 180);
  const b = C! * Math.sin(h! * Math.PI / 180);
  const l = (L! + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m = (L! - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s = (L! - 0.0894841775 * a - 1.291485548 * b) ** 3;
  const rgb = [4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s].map((v) => Math.max(0, Math.min(1, v)));
  return rgb as [number, number, number];
}
const toLuminance = (rgb: readonly number[]) => 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
function luminance(block: string, name: string): number {
  return toLuminance(linearRgb(block, name));
}
const encode = (v: number) => (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
const decode = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
/** `text-<foreground>/<alpha>` over `background`, blended in gamma-encoded sRGB as browsers do. */
function compositedContrast(block: string, foreground: string, alpha: number, background: string): number {
  const fg = linearRgb(block, foreground).map(encode);
  const bg = linearRgb(block, background).map(encode);
  const mixed = toLuminance(fg.map((channel, index) => decode(channel * alpha + bg[index]! * (1 - alpha))));
  const base = luminance(block, background);
  return (Math.max(mixed, base) + 0.05) / (Math.min(mixed, base) + 0.05);
}
function contrast(block: string, foreground: string, background: string): number {
  const a = luminance(block, foreground), b = luminance(block, background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/**
 * Every `text-<token>/<alpha>` in the dashboard and the primitives, with the surface it sits on. A new usage fails the
 * scan below until it is listed here, so its contrast gets checked. Icons need 3:1, text 4.5:1.
 */
const TRANSLUCENT_TEXT = [
  { where: "app-shell.tsx (sidebar host name)", token: "sidebar-foreground", alpha: 85, surface: "sidebar", minimum: 4.5 },
  { where: "sidebar/group.tsx (group labels)", token: "sidebar-foreground", alpha: 80, surface: "sidebar", minimum: 4.5 },
  { where: "data-table.tsx (inactive sort icon, decorative)", token: "muted-foreground", alpha: 50, surface: "background", minimum: 1 },
  { where: "alert.tsx (destructive alert description)", token: "destructive", alpha: 90, surface: "card", minimum: 4.5 },
] as const;

describe("translucent text usages are all listed", () => {
  it("finds no text-<token>/<alpha> class outside the list", () => {
    const roots = [new URL("../../", import.meta.url), new URL("../../../../../apps/dashboard/src/", import.meta.url)];
    const found = new Set<string>();
    const walk = (dir: URL) => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (entry.name !== "__tests__" && entry.name !== "node_modules") walk(new URL(`${entry.name}/`, dir));
        } else if (/\.tsx$/.test(entry.name) && !/\.test\.tsx$/.test(entry.name)) {
          const text = readFileSync(new URL(entry.name, dir), "utf8");
          // Any color token with an alpha; `text-sm/6` (size/line-height) is skipped because `sm` is not a color token.
          for (const match of text.matchAll(/\btext-([a-z][a-z0-9-]*)\/(\d+)\b/g)) {
            if (new RegExp(`--${match[1]}:`).test(light)) found.add(`${match[1]}/${match[2]}`);
          }
        }
      }
    };
    roots.forEach(walk);
    const listed = new Set(TRANSLUCENT_TEXT.map((usage) => `${usage.token}/${usage.alpha}`));
    expect([...found].filter((usage) => !listed.has(usage))).toEqual([]);
  });
});

describe.each([["light", light], ["dark", dark]])("%s theme opaque token contrast", (_theme, block) => {
  it("keeps small success and caution text readable on each ordinary surface", () => {
    for (const token of ["go", "caution"]) {
      for (const surface of ["background", "card", "muted", "accent"]) expect(contrast(block, token, surface), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps input/unchecked-control boundaries distinguishable", () => {
    for (const surface of ["background", "card", "muted", "accent"]) expect(contrast(block, "input", surface), `input on ${surface}`).toBeGreaterThanOrEqual(3);
  });
  it("keeps signal text readable where signal is used as type", () => {
    for (const surface of ["background", "card"]) expect(contrast(block, "signal", surface), `signal on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps secondary labels readable on every ordinary surface", () => {
    for (const surface of ["background", "card", "muted", "accent"]) expect(contrast(block, "muted-foreground", surface), `muted-foreground on ${surface}`).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps the sidebar readable, active item included", () => {
    expect(contrast(block, "sidebar-foreground", "sidebar")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(block, "sidebar-foreground", "sidebar-accent")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(block, "sidebar-primary-foreground", "sidebar-primary")).toBeGreaterThanOrEqual(4.5);
    // The active item's icon turns signal red: a graphic, so 3:1.
    expect(contrast(block, "signal", "sidebar-primary")).toBeGreaterThanOrEqual(3);
    // Line codes on the activity board.
    expect(contrast(block, "rail-muted", "rail")).toBeGreaterThanOrEqual(4.5);
  });
  it("keeps translucent text readable on the surface it sits on", () => {
    for (const usage of TRANSLUCENT_TEXT) {
      const ratio = compositedContrast(block, usage.token, usage.alpha / 100, usage.surface);
      expect(ratio, `${usage.where}: text-${usage.token}/${usage.alpha} on ${usage.surface}`).toBeGreaterThanOrEqual(usage.minimum);
    }
  });
  it("keeps the keyboard focus ring visible on every surface", () => {
    for (const surface of ["background", "card", "muted", "sidebar"]) expect(contrast(block, "ring", surface), `ring on ${surface}`).toBeGreaterThanOrEqual(3);
  });
  it("keeps primary buttons legible", () => {
    expect(contrast(block, "primary-foreground", "primary")).toBeGreaterThanOrEqual(4.5);
    expect(contrast(block, "destructive-foreground", "destructive")).toBeGreaterThanOrEqual(4.5);
  });
});
