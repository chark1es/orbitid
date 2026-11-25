import type { AppearanceVariables } from "./types";

interface VariableMapping {
  /** Custom properties that receive the value, in order. */
  targets: readonly string[];
  /** Custom property that receives a legible on-color, computed from the value. */
  foreground?: string;
  /** Transforms the value into extra properties (e.g. a font scale from a base size). */
  derive?: (value: string) => Record<string, string>;
}

const BASE_FONT_SIZE_PX = 14;

/** `15px` → `--font-scale: 1.0714`; rem is read at 16px. Anything else only sets `--orbitid-font-size`. */
function fontScale(value: string): Record<string, string> {
  const match = /^(\d*\.?\d+)(px|rem)$/.exec(value.trim());
  if (!match) return {};
  const px = Number(match[1]) * (match[2] === "rem" ? 16 : 1);
  if (!Number.isFinite(px) || px <= 0) return {};
  return { "--font-scale": String(Math.round((px / BASE_FONT_SIZE_PX) * 10000) / 10000) };
}

/**
 * Variable → custom properties. Iterated in this order, so an older alias (`colorText`) is applied before its
 * current name (`colorForeground`) and an explicit on-color (`colorPrimaryForeground`) after the computed one.
 * The table in `docs/APPEARANCE.md` mirrors this map; a test keeps them in step.
 */
export const VARIABLE_MAP: Readonly<Record<string, VariableMapping>> = {
  colorPrimary: { targets: ["--primary", "--orbitid-color-primary"], foreground: "--primary-foreground" },
  colorPrimaryForeground: { targets: ["--primary-foreground"] },
  colorBackground: { targets: ["--card", "--popover", "--orbitid-color-background"] },
  colorText: { targets: ["--foreground", "--card-foreground", "--popover-foreground", "--orbitid-color-text"] },
  colorForeground: { targets: ["--foreground", "--card-foreground", "--popover-foreground", "--orbitid-color-text"] },
  colorMuted: { targets: ["--muted", "--secondary", "--orbitid-color-muted"] },
  colorTextSecondary: { targets: ["--muted-foreground", "--orbitid-color-text-secondary"] },
  colorMutedForeground: { targets: ["--muted-foreground", "--orbitid-color-text-secondary"] },
  colorNeutral: { targets: ["--accent", "--orbitid-color-neutral"] },
  colorDanger: { targets: ["--destructive", "--orbitid-color-danger"], foreground: "--destructive-foreground" },
  colorSuccess: { targets: ["--go", "--orbitid-color-success"] },
  colorWarning: { targets: ["--caution", "--orbitid-color-warning"] },
  colorInfo: { targets: ["--info", "--orbitid-color-info"] },
  colorBorder: { targets: ["--border", "--orbitid-color-border"] },
  colorInput: { targets: ["--input", "--orbitid-color-input"] },
  colorInputBackground: { targets: ["--input-background", "--orbitid-color-input-background"] },
  colorInputText: { targets: ["--input-foreground", "--orbitid-color-input-text"] },
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

/** Relative luminance of `#rgb` / `#rrggbb` colors; `null` for anything else. */
function luminance(color: string): number | null {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color.trim());
  if (!hex) return null;
  let digits = hex[1]!;
  if (digits.length === 3) digits = digits.split("").map((d) => d + d).join("");
  const [r, g, b] = [0, 2, 4].map((i) => {
    const channel = parseInt(digits.slice(i, i + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export const LIGHT_FOREGROUND = "oklch(0.985 0 0)";
export const DARK_FOREGROUND = "oklch(0.145 0 0)";

/** Black or white text for `color`, whichever reads better; `undefined` for colors it cannot parse. */
export function contrastForeground(color: string): string | undefined {
  const l = luminance(color);
  if (l === null) return undefined;
  // Equal contrast against the dark and light foregrounds sits near a relative luminance of 0.18.
  return l > 0.18 ? DARK_FOREGROUND : LIGHT_FOREGROUND;
}

const present = (value: unknown): value is string | number => value !== undefined && value !== null && value !== "";

/** Tokens → CSS custom properties. Unknown tokens become `--orbitid-<kebab-key>`. Deterministic in key order. */
export function cssVariablesFrom(variables: AppearanceVariables = {}): Record<string, string> {
  const css: Record<string, string> = {};
  for (const [key, mapping] of Object.entries(VARIABLE_MAP)) {
    const value = variables[key];
    if (!present(value)) continue;
    const cssValue = String(value);
    for (const target of mapping.targets) css[target] = cssValue;
    if (mapping.foreground) {
      const foreground = contrastForeground(cssValue);
      if (foreground) css[mapping.foreground] = foreground;
    }
    if (mapping.derive) Object.assign(css, mapping.derive(cssValue));
  }
  for (const [key, value] of Object.entries(variables)) {
    if (key in VARIABLE_MAP || !present(value)) continue;
    css[`--orbitid-${kebab(key)}`] = String(value);
  }
  return css;
}
