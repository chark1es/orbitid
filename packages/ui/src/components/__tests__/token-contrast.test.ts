// @vitest-environment node
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../../styles.css", import.meta.url), "utf8");
const light = css.slice(css.indexOf(":root,"), css.indexOf(".dark {"));
const dark = css.slice(css.indexOf(".dark {"), css.indexOf("@theme inline"));

// Convert OKLCH to linear sRGB, clipping out-of-gamut channels just as the contrast calculation does.
function luminance(block: string, name: string): number {
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
  return 0.2126 * rgb[0]! + 0.7152 * rgb[1]! + 0.0722 * rgb[2]!;
}
function contrast(block: string, foreground: string, background: string): number {
  const a = luminance(block, foreground), b = luminance(block, background);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe.each([["light", light], ["dark", dark]])("%s theme opaque token contrast", (_theme, block) => {
  it("keeps small success and caution text readable on each ordinary surface", () => {
    for (const token of ["go", "caution"]) {
      for (const surface of ["background", "card", "muted", "accent"]) expect(contrast(block, token, surface), `${token} on ${surface}`).toBeGreaterThanOrEqual(4.5);
    }
  });
  it("keeps input/unchecked-control boundaries distinguishable", () => {
    for (const surface of ["background", "card", "muted", "accent"]) expect(contrast(block, "input", surface), `input on ${surface}`).toBeGreaterThanOrEqual(3);
  });
});
