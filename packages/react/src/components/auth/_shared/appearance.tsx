import { useEffect, useMemo, useState, type ReactNode } from "react";
import { AppearanceContext } from "../../../provider";
import {
  resolveAppearance,
  useAppearance,
  type Appearance,
  type ResolvedAppearance,
} from "../../../appearance";
import { useAuthRuntime } from "./w6";

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

/** Theme class names from the active base theme, falling back to the environment's theme. */
export function useResolvedTheme(fallbackTheme?: string): ResolvedTheme {
  const appearance = useAppearance();
  const runtime = useAuthRuntime();
  const classNames = appearance.theme.classNames ?? [];
  const configured = fallbackTheme === "dark" || fallbackTheme === "light" ? fallbackTheme : runtime.environment.app.theme;
  const forced: ResolvedTheme | null = classNames.includes("dark")
    ? "dark"
    : classNames.includes("light")
      ? "light"
      : null;
  const [resolved, setResolved] = useState<ResolvedTheme>(configured === "dark" ? "dark" : "light");

  useEffect(() => {
    if (configured === "dark" || configured === "light") {
      setResolved(configured);
      return;
    }
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      setResolved("light");
      return;
    }
    const query = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setResolved(query.matches ? "dark" : "light");
    update();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, [configured]);

  return forced ?? resolved;
}
