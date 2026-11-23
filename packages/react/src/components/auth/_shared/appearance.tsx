import { useCallback, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { cn } from "@orbitid/ui";
import { AppearanceContext } from "../../../provider";
import {
  resolveAppearance,
  useAppearance,
  type Appearance,
  type BaseTheme,
  type ClassValue,
  type ResolvedAppearance,
} from "../../../appearance";
import { useAuthRuntime } from "./w6";
import {
  pageSchemeSnapshot,
  parsePageSchemeSnapshot,
  serverPageSchemeSnapshot,
  subscribePageScheme,
} from "./page-theme";

export type ElementName =
  | "rootBox"
  | "card"
  | "cardBox"
  | "header"
  | "headerTitle"
  | "headerSubtitle"
  | "logoBox"
  | "logoImage"
  | "headerLogo"
  | "socialButtons"
  | "socialButtonsBlockButton"
  | "socialButtonsBlockButtonText"
  | "dividerLine"
  | "dividerText"
  | "form"
  | "formField"
  | "formFieldLabel"
  | "formFieldInput"
  | "formFieldInputGroup"
  | "formFieldHintText"
  | "formFieldErrorText"
  | "formButtonPrimary"
  | "formButtonReset"
  | "formButtonSecondary"
  | "footer"
  | "footerAction"
  | "footerActionLink"
  | "footerActionText"
  | "footerPages"
  | "alert"
  | "alertText"
  | "badge"
  | "avatarBox"
  | "avatarImage"
  | "userButtonBox"
  | "userButtonTrigger"
  | "userButtonAvatarBox"
  | "userButtonOuterIdentifier"
  | "userProfile"
  | "userProfilePage"
  | "userProfileNavbar"
  | "navbar"
  | "navbarButton"
  | "navbarButtonIcon"
  | "profileSection"
  | "profileSectionTitle"
  | "profileSectionContent"
  | "profileSectionPrimaryButton"
  | "menuList"
  | "menuItem"
  | "modalContent"
  | "modalBackdrop"
  | "otpCodeFieldInput"
  | "formResendCodeLink"
  | "identityPreview"
  | "identityPreviewText"
  | "identityPreviewEditButton"
  | "pageScrollBox"
  | "table"
  | "tableHead"
  | "tableBody"
  | "tableRow"
  | "tableCell"
  | "captcha";

/**
 * Merge a component's `appearance` prop over the provider appearance and publish it to the same
 * context `useAppearance()` reads.
 */
export function AuthAppearanceScope({ appearance, children }: { appearance?: Appearance; children: ReactNode }) {
  const parent = useAppearance();
  const resolved = useMemo(() => {
    if (!appearance) return parent;
    const base = parent.appearance;
    return resolveAppearance({
      ...base,
      ...appearance,
      elements: { ...base.elements, ...appearance.elements },
      variables: { ...base.variables, ...appearance.variables },
      layout: { ...base.layout, ...appearance.layout },
    });
  }, [parent, appearance]);
  return <AppearanceContext.Provider value={resolved}>{children}</AppearanceContext.Provider>;
}

export function useAuthAppearance(): ResolvedAppearance {
  return useAppearance();
}

export interface ElementClasses {
  el: (name: ElementName | string) => string | undefined;
  appearance: ResolvedAppearance;
  primaryColor: string;
  cssVariables: Record<string, string>;
  rootClassName: string;
}

/** Resolve `appearance.elements.<name>` classes, including function/object overrides. */
export function useElementClasses(): ElementClasses {
  const appearance = useAppearance();
  const runtime = useAuthRuntime();
  const primaryColor =
    (typeof appearance.variables.colorPrimary === "string" && appearance.variables.colorPrimary) ||
    runtime.environment.app.primaryColor;
  return useMemo(
    () => ({
      el: (name: ElementName | string) => appearance.getElementClass(name),
      appearance,
      primaryColor,
      cssVariables: appearance.cssVariables,
      rootClassName: appearance.rootClassName,
    }),
    [appearance, primaryColor],
  );
}

export type ResolvedTheme = "light" | "dark";

export interface ThemeScope {
  /** The scheme the component renders in. */
  theme: ResolvedTheme;
  /**
   * Class for the component's outermost element (and for anything it portals, such as a menu or a dialog), or
   * `undefined` when the inherited tokens already match. `light` is only added inside a dark page: on a light page it
   * would reset tokens the host may have customised on `:root`. Likewise, when the page declares no scheme and the
   * operating system is dark, a component forced light gets no `light` class, so host tokens defined only under a
   * `prefers-color-scheme: dark` media query are not reset.
   */
  className: "dark" | "light" | undefined;
}

/** The last `dark`/`light` class among the configured base themes, so `[dark, myBrandTheme]` stays dark. */
function forcedTheme(themes: readonly BaseTheme[]): ResolvedTheme | null {
  for (let index = themes.length - 1; index >= 0; index -= 1) {
    // An entry may hold several classes ("dark brand").
    const classNames = (themes[index]?.classNames ?? []).flatMap((entry) => entry.split(/\s+/));
    if (classNames.includes("dark")) return "dark";
    if (classNames.includes("light")) return "light";
  }
  return null;
}

/**
 * Which scheme the prebuilt components render in, in order of precedence:
 *
 * 1. a `dark`/`light` base theme in `appearance` (the integrating app decides);
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
  const className = theme === "dark" ? "dark" : declared === "dark" ? "light" : undefined;
  return useMemo(() => ({ theme, className }), [theme, className]);
}

/**
 * `className` builder for content a component portals under `<body>` (dialogs, menus, selects, tooltips). A portal
 * leaves the component's DOM subtree, so it loses the scheme class on the component's root; this puts it back:
 * `<DialogContent className={portalClass("max-w-md")}>`.
 */
export function usePortalClass(): (...classes: ClassValue[]) => string {
  const { className } = useThemeScope();
  return useCallback((...classes: ClassValue[]) => cn(className, ...classes), [className]);
}

/** See {@link useThemeScope}. */
export function useResolvedTheme(fallbackTheme?: string): ResolvedTheme {
  return useThemeScope(fallbackTheme).theme;
}
