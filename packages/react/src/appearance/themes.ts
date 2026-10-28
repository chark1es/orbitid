import type { BaseTheme } from "./types";

/** Baseline tokens — intentionally empty so `@orbitid/ui/styles.css` wins. */
export const defaultTheme: BaseTheme = {
  name: "default",
  classNames: [],
  variables: {},
  layout: {},
  elements: {},
};

/** Dark tokens. Mirrors the `--*` values of `.dark` in `@orbitid/ui/styles.css`. */
export const dark: BaseTheme = {
  name: "dark",
  classNames: ["dark"],
  variables: {
    colorBackground: "oklch(0.145 0 0)",
    colorText: "oklch(0.985 0 0)",
    colorTextSecondary: "oklch(0.708 0 0)",
    colorPrimary: "oklch(0.922 0 0)",
    colorDanger: "oklch(0.704 0.191 22.216)",
    colorSuccess: "oklch(0.696 0.17 162.48)",
    colorWarning: "oklch(0.828 0.189 84.429)",
    colorNeutral: "oklch(0.269 0 0)",
    colorBorder: "oklch(1 0 0 / 10%)",
    colorRing: "oklch(0.556 0 0)",
    colorInputBackground: "oklch(0.205 0 0)",
    colorInputText: "oklch(0.985 0 0)",
    colorMuted: "oklch(0.269 0 0)",
  },
};

export const themes = { defaultTheme, dark } as const;
