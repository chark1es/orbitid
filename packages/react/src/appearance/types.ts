import type { CSSProperties } from "react";
import type { ElementKey } from "./elements";

/** Extra class names accepted by `cn`; kept free of a direct `clsx` dependency. */
export type ClassValue = string | false | null | undefined;

/**
 * Design tokens. Each one maps onto the CSS custom properties `@orbitid/ui/styles.css` reads (see
 * `VARIABLE_MAP` in `./variables.ts` and the table in `docs/APPEARANCE.md`), set on the component root only, so a
 * variable never leaks into the host page.
 */
export interface AppearanceVariables {
  /** Primary buttons, links and the selected state. The text on it is picked automatically unless set. */
  colorPrimary?: string;
  colorPrimaryForeground?: string;
  /** Card and pop-over surface of the component. */
  colorBackground?: string;
  /** Main text color. `colorText` is the older name and still works. */
  colorForeground?: string;
  colorText?: string;
  /** Quiet surfaces: footers, chips, hover rows. */
  colorMuted?: string;
  /** Secondary text. `colorTextSecondary` is the older name and still works. */
  colorMutedForeground?: string;
  colorTextSecondary?: string;
  /** Hover and selected backgrounds for menus and ghost buttons. */
  colorNeutral?: string;
  colorDanger?: string;
  colorSuccess?: string;
  colorWarning?: string;
  colorInfo?: string;
  /** Hairline borders around cards, tables and dividers. */
  colorBorder?: string;
  /** Input, select and checkbox borders. */
  colorInput?: string;
  colorInputBackground?: string;
  /** Typed text in inputs. `colorInputText` is the older name and still works. */
  colorInputForeground?: string;
  colorInputText?: string;
  /** Keyboard focus outline. */
  colorRing?: string;
  /** Ink of every shadow. */
  colorShadow?: string;
  /** Multiplies every shadow's opacity. `0` removes shadows, `1` is the default, `2` doubles them. */
  shadowStrength?: number | string;
  /** Base corner radius for controls; cards use 1.5×, chips 0.75×. `0` makes everything square. */
  borderRadius?: string;
  fontFamily?: string;
  fontFamilyButtons?: string;
  /** Base text size (`14px`, `0.9375rem`). Every text size inside the component scales from it. */
  fontSize?: string;
  fontWeight?: string | number;
  fontWeightBold?: string | number;
  /** The spacing step every padding, gap and margin multiplies (default `0.25rem`). */
  spacingUnit?: string;
  /** Any other token is exposed as `--orbitid-<kebab-case-key>` for your own CSS. */
  [key: string]: string | number | undefined;
}

/**
 * Layout switches shared by every OrbitID component. Components read these through `useAppearance().layout`, so one
 * setting drives the whole tree.
 */
export interface AppearanceLayout {
  /** `blockButton`: one full-width button per provider. `iconButton`: a row of icons. `auto`: icons above 3. */
  socialButtonsVariant?: "blockButton" | "iconButton" | "auto";
  /** Social buttons above (`top`) or below (`bottom`) the form. */
  socialButtonsPlacement?: "top" | "bottom";
  /** Logo inside the card header, above the card, or hidden. */
  logoPlacement?: "inside" | "outside" | "none";
  logoImageUrl?: string;
  logoLinkUrl?: string;
  applicationName?: string;
  /** Show optional sign-up fields (first and last name, username when optional). Default `true`. */
  showOptionalFields?: boolean;
  /** Show the terms, privacy and help links in the card footer. Default `true`. */
  showFooterPages?: boolean;
  /** Show the "Secured by OrbitID" line. Defaults to the instance's branding setting. */
  showBranding?: boolean;
  /** Show the development-mode banner. Default `true` while the instance is in development mode. */
  showDevelopmentModeWarning?: boolean;
  termsPageUrl?: string;
  privacyPageUrl?: string;
  helpPageUrl?: string;
  /** `false` turns off transitions and entrance animations inside the components. Default `true`. */
  animations?: boolean;
  /** @deprecated Use `showDevelopmentModeWarning: false`. */
  unsafe_disableDevelopmentModeWarnings?: boolean;
  shimmer?: boolean;
  [key: string]: unknown;
}

/** Object form of an element override. */
export interface AppearanceElementStyle {
  className?: string;
  style?: CSSProperties;
  /** Drop OrbitID's own classes from this element, keeping only yours. */
  unstyled?: boolean;
}

/**
 * Override for one element: a class string, an object with `className`/`style`/`unstyled`, a function returning
 * either, or a list of those (applied in order).
 */
export type AppearanceElement =
  | string
  | AppearanceElementStyle
  | ((...args: unknown[]) => string | AppearanceElementStyle | undefined)
  | readonly AppearanceElement[];

/** Element overrides keyed by the stable element names in `ELEMENT_KEYS`. Unknown keys are allowed and ignored. */
export type AppearanceElements = Partial<Record<ElementKey, AppearanceElement>> & Record<string, AppearanceElement>;

/**
 * A named bundle of tokens that components merge underneath the `appearance` prop. `baseTheme` accepts one theme or
 * an array (applied in order, later wins).
 */
export interface BaseTheme {
  name: string;
  /**
   * Extra class names for the `orbitid-root` wrapper. `dark`/`light` are not added there: they force the scheme the
   * components render in (see `useThemeScope()`).
   */
  classNames?: string[];
  variables?: AppearanceVariables;
  layout?: AppearanceLayout;
  elements?: AppearanceElements;
}

export interface Appearance {
  /** One theme, or several merged in order. Defaults to `defaultTheme`. */
  baseTheme?: BaseTheme | BaseTheme[];
  variables?: AppearanceVariables;
  layout?: AppearanceLayout;
  elements?: AppearanceElements;
  /**
   * Drop every OrbitID class from every element, keeping only your `elements` classes and the stable
   * `orbitid-<element>` hooks. For a full restyle with Tailwind or your own CSS.
   */
  unstyled?: boolean;
}

/** Fully merged appearance, produced by the provider and by each component's `appearance` prop. */
export interface ResolvedAppearance {
  /** All layers merged into one `Appearance` (for display and for older callers). */
  appearance: Appearance;
  /** The layers in precedence order, lowest first: provider, then each nested component scope. */
  layers: Appearance[];
  /** Last theme across all layers, or `defaultTheme`. */
  theme: BaseTheme;
  themes: BaseTheme[];
  variables: AppearanceVariables;
  layout: AppearanceLayout;
  /** Per element, every override from every layer, lowest precedence first. */
  elements: AppearanceElements;
  unstyled: boolean;
  /** CSS custom properties, ready for a `style` attribute. */
  cssVariables: Record<string, string>;
  /**
   * Wrapper classes: `orbitid-root`, theme class names other than `dark`/`light`, `rootBox` override. The scheme
   * class comes from `useThemeScope()`, which only adds `light` inside a dark page.
   */
  rootClassName: string;
}
