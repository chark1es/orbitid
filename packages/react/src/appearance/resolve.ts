import type { CSSProperties } from "react";
import { cn } from "@orbitid/ui/lib/utils";
import type { ElementSlotResolver, ElementSlotStyle } from "@orbitid/ui";
import { defaultTheme } from "./themes";
import { elementClassName } from "./elements";
import { cssVariablesFrom } from "./variables";
import type {
  Appearance,
  AppearanceElement,
  AppearanceElements,
  AppearanceLayout,
  AppearanceVariables,
  BaseTheme,
  ClassValue,
  ResolvedAppearance,
} from "./types";

export { cssVariablesFrom, contrastForeground, LIGHT_FOREGROUND, DARK_FOREGROUND, VARIABLE_MAP } from "./variables";

interface FlatElement {
  classNames: string[];
  style?: CSSProperties;
  unstyled: boolean;
}

/** Flatten any override shape (string, object, function, list) into classes, style and the unstyled flag. */
export function flattenElement(override: AppearanceElement | undefined): FlatElement {
  const flat: FlatElement = { classNames: [], unstyled: false };
  const visit = (value: AppearanceElement | string | undefined | null) => {
    if (!value) return;
    if (typeof value === "string") {
      flat.classNames.push(value);
    } else if (typeof value === "function") {
      let result: ReturnType<typeof value> | undefined;
      try {
        result = value();
      } catch {
        // A throwing override must not take the whole form down.
        result = undefined;
      }
      visit(result as AppearanceElement | undefined);
    } else if (Array.isArray(value)) {
      for (const entry of value as readonly AppearanceElement[]) visit(entry);
    } else {
      const object = value as Exclude<AppearanceElement, string | readonly AppearanceElement[] | ((...args: unknown[]) => unknown)>;
      if (object.className) flat.classNames.push(object.className);
      if (object.style) flat.style = { ...flat.style, ...object.style };
      if (object.unstyled) flat.unstyled = true;
    }
  };
  visit(override);
  return flat;
}

/** Component classes followed by the override's classes (tailwind-merge keeps the last conflict, so yours win). */
export function resolveElementClass(override: AppearanceElement | undefined, ...classes: ClassValue[]): string {
  const flat = flattenElement(override);
  return cn(...(flat.unstyled ? [] : classes), ...flat.classNames);
}

/** Append `next` to an element override, keeping earlier layers first. */
function appendElement(current: AppearanceElement | undefined, next: AppearanceElement | undefined): AppearanceElement | undefined {
  if (next === undefined || next === null || next === "") return current;
  if (current === undefined) return next;
  return [current, next];
}

function mergeElements(target: Record<string, AppearanceElement>, source: AppearanceElements | undefined) {
  if (!source) return;
  for (const [key, value] of Object.entries(source)) {
    const merged = appendElement(target[key], value);
    if (merged !== undefined) target[key] = merged;
  }
}

const SCHEME_CLASSES = new Set(["dark", "light"]);

const themesOf = (appearance: Appearance | undefined): BaseTheme[] => {
  const configured = appearance?.baseTheme;
  if (configured === undefined) return [];
  return Array.isArray(configured) ? configured : [configured];
};

/**
 * Merge appearance layers into one resolved appearance. Precedence, lowest first, is fixed:
 *
 * 1. `@orbitid/ui` defaults (the stylesheet; not represented here);
 * 2. for each layer in order (the provider's `appearance`, then each component's `appearance` prop):
 *    a. its `baseTheme` entries, in order;
 *    b. its own `variables`, `layout` and `elements`.
 *
 * Variables and layout keys replace earlier values. Element overrides accumulate: every layer's classes are kept,
 * earliest first, and styles merge in the same order, so a later layer wins any conflict without erasing the rest.
 * Instance branding from the dashboard sits under layer 2 (see `useBrandingStyle()`).
 */
export function resolveAppearanceLayers(layers: readonly (Appearance | undefined)[]): ResolvedAppearance {
  const present = layers.filter((layer): layer is Appearance => Boolean(layer));
  const variables: AppearanceVariables = {};
  const layout: AppearanceLayout = {};
  const elements: Record<string, AppearanceElement> = {};
  const explicitVariables: AppearanceVariables = {};
  const explicitLayout: AppearanceLayout = {};
  const explicitElements: Record<string, AppearanceElement> = {};
  const classNames: string[] = ["orbitid-root"];
  const configuredThemes: BaseTheme[] = [];
  let unstyled = false;

  const applyTheme = (theme: BaseTheme) => {
    Object.assign(variables, theme.variables);
    Object.assign(layout, theme.layout);
    mergeElements(elements, theme.elements);
    // `dark`/`light` stay out of `rootClassName`: it also lands on the provider wrapper around the host's own app,
    // where `.light` would reset the host's `:root` tokens. Components read the scheme through `useThemeScope()`.
    classNames.push(
      ...(theme.classNames ?? []).flatMap((entry) => entry.split(/\s+/)).filter((name) => name && !SCHEME_CLASSES.has(name)),
    );
  };

  for (const layer of present) {
    const themes = themesOf(layer);
    configuredThemes.push(...themes);
    themes.forEach(applyTheme);
    Object.assign(variables, layer.variables);
    Object.assign(layout, layer.layout);
    mergeElements(elements, layer.elements);
    Object.assign(explicitVariables, layer.variables);
    Object.assign(explicitLayout, layer.layout);
    mergeElements(explicitElements, layer.elements);
    if (layer.unstyled !== undefined) unstyled = layer.unstyled;
  }

  if (configuredThemes.length === 0) applyTheme(defaultTheme);
  const activeThemes = configuredThemes.length > 0 ? configuredThemes : [defaultTheme];

  const appearance: Appearance = {
    ...(configuredThemes.length > 0 ? { baseTheme: configuredThemes } : {}),
    variables: explicitVariables,
    layout: explicitLayout,
    elements: explicitElements,
    ...(present.some((layer) => layer.unstyled !== undefined) ? { unstyled } : {}),
  };

  return {
    appearance,
    layers: present,
    theme: activeThemes[activeThemes.length - 1]!,
    themes: activeThemes,
    variables,
    layout,
    elements: elements as AppearanceElements,
    unstyled,
    cssVariables: cssVariablesFrom(variables),
    rootClassName: resolveElementClass(elements.rootBox, ...classNames),
  };
}

/** One appearance, resolved on its own (the provider's). */
export function resolveAppearance(appearance: Appearance = {}): ResolvedAppearance {
  return resolveAppearanceLayers([appearance]);
}

/** A component's `appearance` prop as a new layer over the appearance in scope. */
export function extendAppearance(parent: ResolvedAppearance, appearance: Appearance | undefined): ResolvedAppearance {
  if (!appearance) return parent;
  return resolveAppearanceLayers([...parent.layers, appearance]);
}

/**
 * Element resolver for `ElementSlotProvider`: for each key, the stable `orbitid-<key>` class then every override
 * layer, in key order. Global `unstyled` or any key's `unstyled: true` drops OrbitID's own classes.
 */
export function createElementResolver(resolved: Pick<ResolvedAppearance, "elements" | "unstyled">): ElementSlotResolver {
  return (keys) => {
    const classNames: string[] = [];
    let style: CSSProperties | undefined;
    let unstyled = resolved.unstyled;
    for (const key of keys) {
      classNames.push(elementClassName(key));
      const flat = flattenElement(resolved.elements[key]);
      classNames.push(...flat.classNames);
      if (flat.style) style = { ...style, ...flat.style };
      if (flat.unstyled) unstyled = true;
    }
    const result: ElementSlotStyle = { className: classNames.join(" ") };
    if (style) result.style = style;
    if (unstyled) result.unstyled = true;
    return result;
  };
}
