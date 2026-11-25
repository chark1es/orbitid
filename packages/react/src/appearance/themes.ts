import type { BaseTheme } from "./types";

/** Baseline: no tokens, so `@orbitid/ui/styles.css` decides everything. */
export const defaultTheme: BaseTheme = {
  name: "default",
  classNames: [],
  variables: {},
  layout: {},
  elements: {},
};

/**
 * Light scheme. Its `light` class marks the scheme rather than landing in the class names: a component adds `.light`
 * (which `@orbitid/ui/styles.css` gives the light tokens) to its own root only where the inherited tokens would be
 * dark (a dark page, or an unmarked page on a dark OS), so a light page's own `:root` tokens are left alone.
 */
export const light: BaseTheme = {
  name: "light",
  classNames: ["light"],
  variables: {},
  layout: {},
  elements: {},
};

/** Dark scheme. The `.dark` class carries the tokens; the variables mirror it for code that reads them. */
export const dark: BaseTheme = {
  name: "dark",
  classNames: ["dark"],
  variables: {
    colorBackground: "oklch(0.2 0.004 60)",
    colorForeground: "oklch(0.95 0.003 85)",
    colorMutedForeground: "oklch(0.72 0.005 85)",
    colorPrimary: "oklch(0.95 0.003 85)",
    colorDanger: "oklch(0.68 0.19 27)",
    colorSuccess: "oklch(0.74 0.14 150)",
    colorWarning: "oklch(0.8 0.13 80)",
    colorNeutral: "oklch(0.26 0.004 60)",
    colorBorder: "oklch(0.285 0.004 60)",
    colorInput: "oklch(0.55 0.005 60)",
    colorRing: "oklch(0.74 0.006 85)",
    colorMuted: "oklch(0.24 0.004 60)",
  },
};

/** Rounder corners, lighter borders and gentler shadows. Works in both schemes. */
export const soft: BaseTheme = {
  name: "soft",
  classNames: ["orbitid-theme-soft"],
  variables: {
    borderRadius: "0.875rem",
    shadowStrength: 0.7,
    colorBorder: "color-mix(in oklab, var(--foreground) 8%, transparent)",
  },
  layout: { socialButtonsVariant: "blockButton" },
};

/** Strong borders, square-ish corners and no shadows, for high-contrast or low-vision setups. Both schemes. */
export const contrast: BaseTheme = {
  name: "contrast",
  classNames: ["orbitid-theme-contrast"],
  variables: {
    borderRadius: "0.25rem",
    shadowStrength: 0,
    colorBorder: "color-mix(in oklab, var(--foreground) 55%, transparent)",
    colorInput: "var(--foreground)",
    colorRing: "var(--foreground)",
    colorMutedForeground: "color-mix(in oklab, var(--foreground) 80%, var(--card))",
  },
};

/** No elevation: hairlines only, with a slightly smaller radius. Good inside an app that already draws a card. */
export const flat: BaseTheme = {
  name: "flat",
  classNames: ["orbitid-theme-flat"],
  variables: { shadowStrength: 0, borderRadius: "0.375rem" },
  elements: { cardBox: "shadow-none" },
};

export const themes = { defaultTheme, light, dark, soft, contrast, flat } as const;
