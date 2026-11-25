import { useId, useInsertionEffect, useMemo, type CSSProperties, type ReactNode } from "react";
import { ElementSlotProvider, cn, useElementSlotResolver } from "@orbitid/ui";
import { createElementResolver, elementProps, useAppearance, type ElementKey } from "../../../appearance";
import { ComponentScopeContext, useBrandingStyle, useThemeScope, type ResolvedTheme } from "./appearance";

/** A custom-property value that cannot close the declaration block it is written into. */
const SAFE_VALUE = /^[^;{}<>\\]*$/;

/** `--primary: #fff; --radius: 8px` for the scoped rule portaled content reads. */
export function scopeDeclarations(style: Record<string, string>): string {
  return Object.entries(style)
    .filter(([name, value]) => /^--[\w-]+$/.test(name) && SAFE_VALUE.test(value))
    .map(([name, value]) => `${name}:${value}`)
    .join(";");
}

/**
 * Keeps `.<scopeClass>{<declarations>}` in `<head>` while the component is mounted. Portaled content (dialogs, menus)
 * only ever opens in the browser, so the rule needs no server rendering.
 */
function useScopeRule(scopeClass: string, declarations: string) {
  useInsertionEffect(() => {
    if (!declarations || typeof document === "undefined") return;
    const element = document.createElement("style");
    element.setAttribute("data-orbitid-scope", scopeClass);
    element.textContent = `.${scopeClass}{${declarations}}`;
    document.head.appendChild(element);
    return () => element.remove();
  }, [scopeClass, declarations]);
}

export interface ComponentRootProps {
  /** `data-orbit-component` value, e.g. `auth-card`. */
  component: string;
  /** Extra component element keys for the root, after `rootBox`. */
  element?: ElementKey;
  className?: string;
  style?: CSSProperties;
  children: ReactNode | ((theme: ResolvedTheme) => ReactNode);
  [data: `data-${string}`]: string | undefined;
}

/**
 * The outermost element of a prebuilt component. It carries, in order: the scheme class, the instance branding, the
 * resolved `appearance.variables`, the theme class names, `elements.rootBox` and the motion setting. Content the
 * component portals under `<body>` gets the same custom properties through a scope class whose rule lives in `<head>`
 * (see `usePortalClass`).
 */
export function ComponentRoot({ component, element, className, style, children, ...data }: ComponentRootProps) {
  const appearance = useAppearance();
  const { theme, className: themeClass } = useThemeScope();
  const branding = useBrandingStyle(theme);
  // Normally `AuthAppearanceScope` already installed the resolver; a root rendered on its own installs one.
  const inherited = useElementSlotResolver();
  const resolver = useMemo(() => inherited ?? createElementResolver(appearance), [inherited, appearance]);
  const rawId = useId();
  const scopeClass = `orbitid-scope-${rawId.replace(/[^\w-]/g, "")}`;
  const motionOff = appearance.layout.animations === false ? "orbitid-motion-off" : undefined;
  const variables = useMemo(() => ({ ...branding, ...appearance.cssVariables }), [branding, appearance.cssVariables]);
  const declarations = useMemo(() => scopeDeclarations(variables), [variables]);
  useScopeRule(scopeClass, declarations);
  const root = elementProps(resolver, element ? ["rootBox", element] : ["rootBox"], []);
  const scope = useMemo(
    () => ({ portalClassName: cn(declarations ? scopeClass : null, "orbitid-component", motionOff) }),
    [declarations, scopeClass, motionOff],
  );

  return (
    <ElementSlotProvider value={resolver}>
      <ComponentScopeContext.Provider value={scope}>
        <div
          {...data}
          data-orbit-component={component}
          data-orbit-theme={theme}
          data-orbitid-element={root["data-orbitid-element"]}
          className={cn(themeClass, "orbitid-component", motionOff, appearance.rootClassName, className, root.className)}
          style={{ ...variables, ...style, ...root.style } as CSSProperties}
        >
          {typeof children === "function" ? children(theme) : children}
        </div>
      </ComponentScopeContext.Provider>
    </ElementSlotProvider>
  );
}
