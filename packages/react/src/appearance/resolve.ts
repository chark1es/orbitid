import { cn } from "@orbitid/ui/lib/utils";
import { defaultTheme } from "./themes";
import type {
  Appearance,
  AppearanceElement,
  AppearanceLayout,
  AppearanceVariables,
  BaseTheme,
  ClassValue,
  ResolvedAppearance,
} from "./types";

interface VariableMapping {
  /** Token names that receive the value, in order. */
  targets: string[];
  /** Token that receives a legible on-color, computed from `targets[0]`. */
  foreground?: string;
}

const VARIABLE_MAP: Record<string, VariableMapping> = {
  colorPrimary: { targets: ["--primary", "--orbitid-color-primary"], foreground: "--primary-foreground" },
  colorBackground: { targets: ["--background", "--orbitid-color-background"] },
  colorText: { targets: ["--foreground", "--orbitid-color-text"] },
  colorDanger: { targets: ["--destructive", "--orbitid-color-danger"] },
  colorBorder: { targets: ["--border", "--orbitid-color-border"] },
  colorRing: { targets: ["--ring", "--orbitid-color-ring"] },
  colorInputBackground: { targets: ["--orbitid-color-input-background"] },
  colorInputText: { targets: ["--orbitid-color-input-text"] },
  colorMuted: { targets: ["--muted", "--orbitid-color-muted"] },
  colorTextSecondary: { targets: ["--orbitid-color-text-secondary"] },
  colorSuccess: { targets: ["--orbitid-color-success"] },
  colorWarning: { targets: ["--orbitid-color-warning"] },
  colorNeutral: { targets: ["--orbitid-color-neutral"] },
  colorShadow: { targets: ["--orbitid-color-shadow"] },
  borderRadius: { targets: ["--radius", "--orbitid-border-radius"] },
  fontFamily: { targets: ["--font-sans", "--orbitid-font-family"] },
  fontFamilyButtons: { targets: ["--orbitid-font-family-buttons"] },
  fontSize: { targets: ["--orbitid-font-size"] },
  fontWeight: { targets: ["--orbitid-font-weight"] },
  fontWeightBold: { targets: ["--orbitid-font-weight-bold"] },
  spacingUnit: { targets: ["--orbitid-spacing-unit"] },
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

/** Black or white text for `color`, whichever reads better. */
export const LIGHT_FOREGROUND = "oklch(0.985 0 0)";

export function contrastForeground(color: string): string | undefined {
  const l = luminance(color);
  if (l === null) return undefined;
  // Equal contrast against the dark and light foregrounds sits near a relative luminance of 0.18.
  return l > 0.18 ? "oklch(0.145 0 0)" : LIGHT_FOREGROUND;
}

/** Tokens → CSS custom properties. Unknown tokens become `--orbitid-<kebab-key>`. */
export function cssVariablesFrom(variables: AppearanceVariables = {}): Record<string, string> {
  const css: Record<string, string> = {};
  for (const [key, value] of Object.entries(variables)) {
    if (value === undefined || value === null || value === "") continue;
    const mapping = VARIABLE_MAP[key];
    const cssValue = String(value);
    if (!mapping) {
      css[`--orbitid-${kebab(key)}`] = cssValue;
      continue;
    }
    for (const target of mapping.targets) css[target] = cssValue;
    if (mapping.foreground) {
      const foreground = contrastForeground(cssValue);
      if (foreground) css[mapping.foreground] = foreground;
    }
  }
  return css;
}

/** Flatten a user override (`string`, `{ className }`, or function) into a class string. */
export function resolveElementClass(override: AppearanceElement | undefined, ...classes: ClassValue[]): string {
  let userClass = "";
  if (typeof override === "string") {
    userClass = override;
  } else if (typeof override === "function") {
    try {
      const result = override();
      if (typeof result === "string") userClass = result;
      else if (result && typeof result === "object") userClass = result.className ?? "";
    } catch {
      // A throwing override must not take the whole form down.
      userClass = "";
    }
  } else if (override) {
    userClass = override.className ?? "";
  }
  // User overrides win over component defaults (tailwind-merge keeps the last conflict).
  return cn(...classes, userClass);
}

/**
 * Merge `appearance` over its base theme(s): theme variables/layout/elements first,
 * then the explicit `appearance` prop. Later entries win.
 */
export function resolveAppearance(appearance: Appearance = {}): ResolvedAppearance {
  const configured = appearance.baseTheme;
  const themes = configured === undefined ? [] : Array.isArray(configured) ? configured : [configured];
  const activeThemes = themes.length > 0 ? themes : [defaultTheme];

  const variables: AppearanceVariables = {};
  const layout: AppearanceLayout = {};
  const elements: Record<string, AppearanceElement> = {};
  const classNames: string[] = ["orbitid-root"];

  const mergeTheme = (theme: BaseTheme) => {
    Object.assign(variables, theme.variables);
    Object.assign(layout, theme.layout);
    Object.assign(elements, theme.elements);
    classNames.push(...(theme.classNames ?? []));
  };
  activeThemes.forEach(mergeTheme);
  Object.assign(variables, appearance.variables);
  Object.assign(layout, appearance.layout);
  Object.assign(elements, appearance.elements);

  return {
    appearance,
    theme: activeThemes[activeThemes.length - 1]!,
    themes: activeThemes,
    variables,
    layout,
    elements: elements as ResolvedAppearance["elements"],
    cssVariables: cssVariablesFrom(variables),
    rootClassName: resolveElementClass(elements.rootBox, ...classNames),
  };
}
