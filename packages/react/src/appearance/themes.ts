import type { BaseTheme } from "./types";

/** Baseline tokens — intentionally empty so `@orbitid/ui/styles.css` wins. */
export const defaultTheme: BaseTheme = {
  name: "default",
  classNames: [],
  variables: {},
  layout: {},
  elements: {},
};

/**
 * Light scheme. Adds only the `light` class: `@orbitid/ui/styles.css` gives `.light` the light tokens, so the widget
 * stays light inside a dark page while a light page's own `:root` tokens are left alone.
 */
export const light: BaseTheme = {
  name: "light",
  classNames: ["light"],
  variables: {},
  layout: {},
  elements: {},
};

/** Dark tokens. Mirrors the `--*` values of `.dark` in `@orbitid/ui/styles.css`, so a dark widget matches its page. */
export const dark: BaseTheme = {
  name: "dark",
  classNames: ["dark"],
  variables: {
    colorBackground: "oklch(0.17 0.008 60)",
    colorText: "oklch(0.94 0.006 85)",
    colorTextSecondary: "oklch(0.72 0.008 85)",
    colorPrimary: "oklch(0.94 0.006 85)",
    colorDanger: "oklch(0.68 0.2 27)",
    colorSuccess: "oklch(0.72 0.15 150)",
    colorWarning: "oklch(0.8 0.14 80)",
    colorNeutral: "oklch(0.25 0.008 60)",
    colorBorder: "oklch(0.32 0.01 60)",
    colorRing: "oklch(0.68 0.2 27)",
    colorInputBackground: "oklch(0.21 0.008 60)",
    colorInputText: "oklch(0.94 0.006 85)",
    colorMuted: "oklch(0.25 0.008 60)",
  },
};

export const themes = { defaultTheme, light, dark } as const;
