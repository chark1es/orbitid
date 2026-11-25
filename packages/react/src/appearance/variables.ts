import type { AppearanceVariables } from "./types";
import { devWarn } from "./warn";

interface VariableMapping {
  /** Custom properties that receive the value, in order. */
  targets: readonly string[];
  /** Custom property that receives a legible on-color, computed from the value. */
  foreground?: string;
  /** Transforms the value into extra properties (e.g. a font scale from a base size). */
  derive?: (value: string) => Record<string, string>;
}

const BASE_FONT_SIZE_PX = 14;

/** `15px` → `--font-scale: 1.0714`; rem is read at 16px. Other units cannot scale the components, so they warn. */
function fontScale(value: string): Record<string, string> {
  const match = /^(-?\d*\.?\d+)(px|rem)$/.exec(value.trim());
  if (!match) {
    devWarn(`appearance.variables.fontSize only scales text when given in px or rem; "${value}" was ignored.`);
    return {};
  }
  const px = Number(match[1]) * (match[2] === "rem" ? 16 : 1);
  if (!Number.isFinite(px) || px <= 0) {
    devWarn(`appearance.variables.fontSize must be a positive size; "${value}" was ignored.`);
    return {};
  }
  return { "--font-scale": String(Math.round((px / BASE_FONT_SIZE_PX) * 10000) / 10000) };
}

/** Older variable names and the current name each one stands for. */
export const VARIABLE_ALIASES: Readonly<Record<string, string>> = {
  colorText: "colorForeground",
  colorTextSecondary: "colorMutedForeground",
  colorInputText: "colorInputForeground",
};

/**
 * One layer's variables with older names rewritten to their current names. When a layer sets both, the current
 * name wins. Resolution runs this per layer before merging, so an alias in a later layer still beats an earlier
 * layer's (or a theme's) current name.
 */
export function normalizeVariables(variables: AppearanceVariables): AppearanceVariables {
  const normalized: AppearanceVariables = {};
  for (const [key, value] of Object.entries(variables)) {
    // `undefined` means "not set": it must not erase an alias in the same layer or a value from an earlier one.
    if (value === undefined) continue;
    const canonical = VARIABLE_ALIASES[key];
    if (canonical === undefined) normalized[key] = value;
    else if (variables[canonical] === undefined) normalized[canonical] = value;
  }
  return normalized;
}

/**
 * Variable → custom properties, iterated in this order (so an explicit on-color like `colorPrimaryForeground` lands
 * after the computed one). The table in `docs/APPEARANCE.md` mirrors this map; a test keeps them in step.
 */
export const VARIABLE_MAP: Readonly<Record<string, VariableMapping>> = {
  colorPrimary: { targets: ["--primary", "--orbitid-color-primary"], foreground: "--primary-foreground" },
  colorPrimaryForeground: { targets: ["--primary-foreground"] },
  colorBackground: { targets: ["--card", "--popover", "--orbitid-color-background"] },
  colorForeground: { targets: ["--foreground", "--card-foreground", "--popover-foreground", "--orbitid-color-text"] },
  colorMuted: { targets: ["--muted", "--secondary", "--orbitid-color-muted"] },
  colorMutedForeground: { targets: ["--muted-foreground", "--orbitid-color-text-secondary"] },
  colorNeutral: { targets: ["--accent", "--orbitid-color-neutral"] },
  colorDanger: { targets: ["--destructive", "--orbitid-color-danger"], foreground: "--destructive-foreground" },
  colorSuccess: { targets: ["--go", "--orbitid-color-success"] },
  colorWarning: { targets: ["--caution", "--orbitid-color-warning"] },
  colorInfo: { targets: ["--info", "--orbitid-color-info"] },
  colorBorder: { targets: ["--border", "--orbitid-color-border"] },
  colorInput: { targets: ["--input", "--orbitid-color-input"] },
  colorInputBackground: { targets: ["--input-background", "--orbitid-color-input-background"] },
  colorInputForeground: { targets: ["--input-foreground", "--orbitid-color-input-text"] },
  colorRing: { targets: ["--ring", "--orbitid-color-ring"] },
  colorShadow: { targets: ["--shadow-color", "--orbitid-color-shadow"] },
  shadowStrength: { targets: ["--shadow-strength"] },
  borderRadius: { targets: ["--radius", "--orbitid-border-radius"] },
  fontFamily: { targets: ["--font-sans", "--orbitid-font-family"] },
  fontFamilyButtons: { targets: ["--orbitid-font-family-buttons"] },
  fontSize: { targets: ["--orbitid-font-size"], derive: fontScale },
  fontWeight: { targets: ["--orbitid-font-weight"] },
  fontWeightBold: { targets: ["--orbitid-font-weight-bold"] },
  spacingUnit: { targets: ["--spacing", "--orbitid-spacing-unit"] },
};

const kebab = (value: string) => value.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();

const srgbToLinear = (channel: number) => (channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4);
const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

/** `50%` → 0.5 of `max`; a bare number stays as is. */
function amount(token: string, max: number): number {
  return token.endsWith("%") ? (parseFloat(token) / 100) * max : parseFloat(token);
}

function hueDegrees(token: string): number {
  const value = parseFloat(token);
  if (token.endsWith("turn")) return value * 360;
  if (token.endsWith("rad")) return (value * 180) / Math.PI;
  if (token.endsWith("grad")) return value * 0.9;
  return value;
}

/** Linear-light sRGB channels (0–1) for hex, `rgb()`, `hsl()` and `oklch()` colors; `null` for anything else. */
function linearRgb(color: string): [number, number, number] | null {
  const value = color.trim().toLowerCase();
  const hex = /^#([0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/.exec(value);
  if (hex) {
    let digits = hex[1]!;
    if (digits.length <= 4) digits = digits.split("").map((d) => d + d).join("");
    return [0, 2, 4].map((i) => srgbToLinear(parseInt(digits.slice(i, i + 2), 16) / 255)) as [number, number, number];
  }
  const fn = /^(rgba?|hsla?|oklch)\(\s*([^)]*)\)$/.exec(value);
  if (!fn) return null;
  // Drop the alpha part (`/ 0.5`, or a fourth comma value): contrast is judged on the opaque color.
  const parts = fn[2]!.split("/")[0]!.trim().split(/[\s,]+/).filter(Boolean).slice(0, 3);
  if (parts.length < 3 || parts.some((part) => Number.isNaN(parseFloat(part)))) return null;
  const kind = fn[1]!;
  if (kind.startsWith("rgb")) {
    return parts.map((part) => srgbToLinear(clamp01(amount(part, 255) / 255))) as [number, number, number];
  }
  if (kind.startsWith("hsl")) {
    const h = ((hueDegrees(parts[0]!) % 360) + 360) % 360;
    const s = clamp01(amount(parts[1]!, 1) / (parts[1]!.endsWith("%") ? 1 : 100));
    const l = clamp01(amount(parts[2]!, 1) / (parts[2]!.endsWith("%") ? 1 : 100));
    const k = (n: number) => (n + h / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = (n: number) => l - a * Math.max(-1, Math.min(k(n) - 3, 9 - k(n), 1));
    return [f(0), f(8), f(4)].map(srgbToLinear) as [number, number, number];
  }
  // oklch: L (0–1 or %), C, H in degrees → OKLab → linear sRGB.
  const L = amount(parts[0]!, 1);
  const C = parts[1]!.endsWith("%") ? (parseFloat(parts[1]!) / 100) * 0.4 : parseFloat(parts[1]!);
  const H = (hueDegrees(parts[2]!) * Math.PI) / 180;
  const A = C * Math.cos(H);
  const B = C * Math.sin(H);
  const l = (L + 0.3963377774 * A + 0.2158037573 * B) ** 3;
  const m = (L - 0.1055613458 * A - 0.0638541728 * B) ** 3;
  const sh = (L - 0.0894841775 * A - 1.291485548 * B) ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * sh,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * sh,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * sh,
  ].map(clamp01) as [number, number, number];
}

/** Relative luminance (WCAG) of a color `linearRgb` understands; `null` otherwise. */
export function relativeLuminance(color: string): number | null {
  const rgb = linearRgb(color);
  return rgb ? 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2] : null;
}

export const LIGHT_FOREGROUND = "oklch(0.985 0 0)";
export const DARK_FOREGROUND = "oklch(0.145 0 0)";

/**
 * Black or white text for `color`, whichever reads better; `undefined` for colors it cannot parse (named colors,
 * `var()`, `color-mix()`), in which case the scheme's own foreground stays.
 */
export function contrastForeground(color: string): string | undefined {
  const l = relativeLuminance(color);
  if (l === null) return undefined;
  // Equal contrast against the dark and light foregrounds sits near a relative luminance of 0.18.
  return l > 0.18 ? DARK_FOREGROUND : LIGHT_FOREGROUND;
}

const present = (value: unknown): value is string | number => value !== undefined && value !== null && value !== "";

/** Tokens → CSS custom properties. Unknown tokens become `--orbitid-<kebab-key>`. Deterministic in key order. */
export function cssVariablesFrom(input: AppearanceVariables = {}): Record<string, string> {
  const variables = normalizeVariables(input);
  const css: Record<string, string> = {};
  for (const [key, mapping] of Object.entries(VARIABLE_MAP)) {
    const value = variables[key];
    if (!present(value)) continue;
    const cssValue = String(value);
    for (const target of mapping.targets) css[target] = cssValue;
    if (mapping.foreground) {
      const foreground = contrastForeground(cssValue);
      if (foreground) css[mapping.foreground] = foreground;
      else if (!present(variables[`${key}Foreground`]))
        devWarn(
          `Cannot work out a legible text color for ${key} "${cssValue}"; the theme's default is used. Use a hex, rgb(), hsl() or oklch() color${`${key}Foreground` in VARIABLE_MAP ? `, or set ${key}Foreground` : ""}.`,
        );
    }
    if (mapping.derive) Object.assign(css, mapping.derive(cssValue));
  }
  for (const [key, value] of Object.entries(variables)) {
    if (key in VARIABLE_MAP || !present(value)) continue;
    css[`--orbitid-${kebab(key)}`] = String(value);
  }
  return css;
}
