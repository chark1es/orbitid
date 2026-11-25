import { createContext, useCallback, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { ElementSlotProvider, cn } from "@orbitid/ui";
import { AppearanceContext } from "../../../provider";
import {
  contrastForeground,
  createElementResolver,
  extendAppearance,
  LIGHT_FOREGROUND,
  useAppearance,
  useElementProps,
  type Appearance,
  type BaseTheme,
  type ClassValue,
  type ElementKey,
  type ElementPropsFn,
  type ResolvedAppearance,
} from "../../../appearance";
import { useAuthRuntime } from "./w6";
import {
  pageSchemeSnapshot,
  parsePageSchemeSnapshot,
  serverPageSchemeSnapshot,
  subscribePageScheme,
} from "./page-theme";

/** @deprecated Use `ElementKey` from the appearance module. */
export type ElementName = ElementKey;

/**
 * Publishes a component's `appearance` prop as a new layer over the appearance in scope (see
 * `resolveAppearanceLayers` for the precedence), and the element resolver every `@orbitid/ui` primitive inside reads.
 * Every prebuilt component renders inside one, so primitives pick up `appearance.elements` even with no prop.
 */
export function AuthAppearanceScope({ appearance, children }: { appearance?: Appearance; children: ReactNode }) {
  const parent = useAppearance();
  const resolved = useMemo(() => extendAppearance(parent, appearance), [parent, appearance]);
  const resolver = useMemo(() => createElementResolver(resolved), [resolved]);
  return (
    <AppearanceContext.Provider value={resolved}>
      <ElementSlotProvider value={resolver}>{children}</ElementSlotProvider>
    </AppearanceContext.Provider>
  );
}

export function useAuthAppearance(): ResolvedAppearance {
  return useAppearance();
}

export interface ElementClasses {
  /** `ep(key, ...classes)` → `{ className, style, "data-orbitid-element" }`. */
  ep: ElementPropsFn;
  appearance: ResolvedAppearance;
}

/** Element helpers for the component in scope. */
export function useComponentElements(): ElementClasses {
  const appearance = useAppearance();
  const ep = useElementProps();
  return useMemo(() => ({ ep, appearance }), [appearance, ep]);
}

export type ResolvedTheme = "light" | "dark";

export interface ThemeScope {
  /** The scheme the component renders in. */
  theme: ResolvedTheme;
  /**
   * Class for the component's outermost element (and for anything it portals, such as a menu or a dialog), or
   * `undefined` when the inherited tokens already match. `light` is only added where the inherited tokens would be
   * dark (a dark page, or a page that declares nothing on a dark OS): on a light page it would reset tokens the host
   * may have customised on `:root`. The class sits on the component root, never on the host's wrapper.
   */
  className: "dark" | "light" | undefined;
}

/** The last `dark`/`light` class among the configured base themes, so `[dark, myBrandTheme]` stays dark. */
function forcedTheme(themes: readonly BaseTheme[]): ResolvedTheme | null {
  for (let index = themes.length - 1; index >= 0; index -= 1) {
    // An entry may hold several classes ("dark brand").
    const entries = themes[index]?.classNames;
    const classNames = (Array.isArray(entries) ? entries : [])
      .filter((entry): entry is string => typeof entry === "string")
      .flatMap((entry) => entry.split(/\s+/));
    if (classNames.includes("dark")) return "dark";
    if (classNames.includes("light")) return "light";
  }
  return null;
}

/**
 * Which scheme the prebuilt components render in, in order of precedence:
 *
 * 1. a `dark`/`light` base theme in `appearance` (the integrating app decides; a component's own prop wins over the
 *    provider's because its themes come later);
 * 2. `fallbackTheme`, then the instance's branding theme when it is `light` or `dark`;
 * 3. otherwise ("system"): the scheme the page declares on `<html>` (a `dark`/`light` class, `data-theme` or
 *    `color-scheme`), and only when it declares none, `prefers-color-scheme`.
 *
 * Server rendering and the hydration render use light for "system", then the client snapshot takes over.
 */
export function useThemeScope(fallbackTheme?: string): ThemeScope {
  const appearance = useAppearance();
  const runtime = useAuthRuntime();
  const snapshot = useSyncExternalStore(subscribePageScheme, pageSchemeSnapshot, serverPageSchemeSnapshot);
  const { declared, system } = parsePageSchemeSnapshot(snapshot);
  const configured = fallbackTheme === "dark" || fallbackTheme === "light" ? fallbackTheme : runtime.environment.app.theme;
  const theme: ResolvedTheme =
    forcedTheme(appearance.themes) ??
    (configured === "dark" || configured === "light" ? configured : (declared ?? system));
  // `light` is added only where the inherited tokens would be dark: inside a dark page, or on a page that declares
  // nothing while the OS is dark (the component was forced light). On a light page it would reset the host's own
  // `:root` tokens, so it stays off there.
  const className = theme === "dark" ? "dark" : (declared ?? system) === "dark" ? "light" : undefined;
  return useMemo(() => ({ theme, className }), [theme, className]);
}

/** What a component root hands to the content it portals under `<body>`. */
export interface ComponentScope {
  /** Scope class carrying the root's custom properties, font and motion setting. */
  portalClassName?: string;
}

export const ComponentScopeContext = createContext<ComponentScope>({});

/**
 * `className` builder for content a component portals under `<body>` (dialogs, menus, selects, tooltips). A portal
 * leaves the component's DOM subtree, so it loses the scheme class and the custom properties on the component's root;
 * this puts both back: `<DialogContent className={portalClass("max-w-md")}>`.
 */
export function usePortalClass(): (...classes: ClassValue[]) => string {
  const { className } = useThemeScope();
  const { portalClassName } = useContext(ComponentScopeContext);
  return useCallback((...classes: ClassValue[]) => cn(className, portalClassName, ...classes), [className, portalClassName]);
}

/** See {@link useThemeScope}. */
export function useResolvedTheme(fallbackTheme?: string): ResolvedTheme {
  return useThemeScope(fallbackTheme).theme;
}

/**
 * Instance branding (the dashboard's primary color) as custom properties. It sits under every `appearance` layer:
 * any `variables.colorPrimary` replaces it. A dark brand color would vanish on a dark surface, so dark mode keeps the
 * theme's own primary in that case.
 */
export function useBrandingStyle(theme: ResolvedTheme): Record<string, string> {
  const appearance = useAppearance();
  const runtime = useAuthRuntime();
  const primaryColor = runtime.environment.app.primaryColor;
  return useMemo(() => {
    if (appearance.variables.colorPrimary || !primaryColor) return {};
    const foreground = contrastForeground(primaryColor);
    if (theme === "dark" && foreground === LIGHT_FOREGROUND) return {};
    const style: Record<string, string> = { "--primary": primaryColor };
    if (foreground) style["--primary-foreground"] = foreground;
    return style;
  }, [appearance.variables.colorPrimary, primaryColor, theme]);
}

export type { ElementKey };
