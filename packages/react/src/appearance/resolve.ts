import type { CSSProperties } from "react";
import { cn } from "@orbitid/ui/lib/utils";
import type { ElementSlotResolver, ElementSlotStyle } from "@orbitid/ui";
import { defaultTheme } from "./themes";
import { elementClassName } from "./elements";
import { cssVariablesFrom, normalizeVariables } from "./variables";
import { devWarn } from "./warn";
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

export {
  cssVariablesFrom,
  contrastForeground,
  normalizeVariables,
  LIGHT_FOREGROUND,
  DARK_FOREGROUND,
  VARIABLE_ALIASES,
  VARIABLE_MAP,
} from "./variables";

interface FlatElement {
  classNames: string[];
  style?: CSSProperties;
  /** `undefined` when no override says either way; otherwise the last explicit value. */
  unstyled?: boolean;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Flatten any override shape (string, object, function, list) into classes, style and the unstyled flag. */
export function flattenElement(override: AppearanceElement | undefined): FlatElement {
  const flat: FlatElement = { classNames: [] };
  const visit = (value: unknown) => {
    if (!value) return;
    if (typeof value === "string") {
      flat.classNames.push(value);
    } else if (typeof value === "function") {
      let result: unknown;
      try {
        result = (value as () => unknown)();
      } catch (error) {
        // A throwing override must not take the whole form down.
        devWarn(`An appearance.elements function threw and was ignored: ${error instanceof Error ? error.message : String(error)}`);
        result = undefined;
      }
      visit(result);
    } else if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
    } else if (isObject(value)) {
      if (typeof value.className === "string" && value.className) flat.classNames.push(value.className);
      if (isObject(value.style)) flat.style = { ...flat.style, ...(value.style as CSSProperties) };
      if (typeof value.unstyled === "boolean") flat.unstyled = value.unstyled;
    }
  };
  visit(override);
  return flat;
}

/** Component classes followed by the override's classes (tailwind-merge keeps the last conflict, so yours win). */
export function resolveElementClass(override: AppearanceElement | undefined, ...classes: ClassValue[]): string {
  const flat = flattenElement(override);
  return cn(...(flat.unstyled === true ? [] : classes), ...flat.classNames);
}

/** Append `next` to an element override, keeping earlier layers first. */
function appendElement(current: AppearanceElement | undefined, next: AppearanceElement | undefined): AppearanceElement | undefined {
  if (next === undefined || next === null || next === "") return current;
  if (current === undefined) return next;
  return [current, next];
}

function mergeElements(target: Record<string, AppearanceElement>, source: unknown) {
  if (!isObject(source)) return;
  for (const [key, value] of Object.entries(source)) {
    const merged = appendElement(target[key], value as AppearanceElement);
    if (merged !== undefined) target[key] = merged;
  }
}

const SCHEME_CLASSES = new Set(["dark", "light"]);

/**
 * The scheme a theme forces (`dark` or `light`, the last one in its classes), or `null` when it forces none. The one
 * rule both the resolver and the components' scheme pick use, so the scheme and the kept tokens always agree.
 */
export function schemeOf(theme: BaseTheme): "dark" | "light" | null {
  if (theme.classNames !== undefined && !Array.isArray(theme.classNames)) {
    devWarn(`appearance.baseTheme "${theme.name ?? "?"}" has classNames that is not an array. It was ignored.`);
  }
  const names = Array.isArray(theme.classNames) ? theme.classNames : [];
  let scheme: "dark" | "light" | null = null;
  for (const entry of names) {
    if (typeof entry !== "string") continue;
    for (const name of entry.split(/\s+/)) if (name === "dark" || name === "light") scheme = name;
  }
  return scheme;
}

/**
 * The themes a layer sets, or `null` when it sets none. Falsy and non-object entries are dropped (a string is a
 * common mistake, so it gets a warning); a layer whose entries are all invalid counts as not setting themes.
 */
function themesOf(appearance: Appearance): BaseTheme[] | null {
  const configured = (appearance as { baseTheme?: unknown }).baseTheme;
  if (configured === undefined || configured === null) return null;
  const entries = Array.isArray(configured) ? configured : [configured];
  const themes: BaseTheme[] = [];
  for (const entry of entries) {
    if (typeof entry === "string") {
      devWarn(`appearance.baseTheme takes theme objects (import { dark } from "@orbitid/react"), not the string "${entry}". It was ignored.`);
    } else if (isObject(entry)) {
      themes.push(entry as unknown as BaseTheme);
    }
  }
  if (Array.isArray(configured) && configured.length === 0) return [];
  return themes.length > 0 ? themes : null;
}

const objectOrEmpty = <T,>(value: unknown): T => (isObject(value) ? (value as T) : ({} as T));

/**
 * Merge appearance layers into one resolved appearance. Precedence, lowest first, is fixed:
 *
 * 1. `@orbitid/ui` defaults (the stylesheet; not represented here);
 * 2. instance branding (see `useBrandingStyle()`);
 * 3. the base themes of the **last** layer that sets `baseTheme` (a component's `baseTheme` replaces the provider's,
 *    so the scheme and the theme's variables always come from the same themes);
 * 4. each layer's own `variables`, `layout` and `elements`, provider first, then each component.
 *
 * Variables and layout keys replace earlier values; older variable names are normalized per layer before merging.
 * Element overrides accumulate: every layer's classes are kept, earliest first, and styles merge in the same order,
 * so a later layer wins any conflict without erasing the rest.
 */
export function resolveAppearanceLayers(layers: readonly (Appearance | undefined | null)[]): ResolvedAppearance {
  const present = layers.filter((layer): layer is Appearance => isObject(layer));
  const variables: AppearanceVariables = {};
  const layout: AppearanceLayout = {};
  const elements: Record<string, AppearanceElement> = {};
  const explicitVariables: AppearanceVariables = {};
  const explicitLayout: AppearanceLayout = {};
  const explicitElements: Record<string, AppearanceElement> = {};
  const themeClassNames: string[] = ["orbitid-root"];
  let unstyled = false;

  let configuredThemes: BaseTheme[] | null = null;
  for (const layer of present) configuredThemes = themesOf(layer) ?? configuredThemes;
  const activeThemes = configuredThemes && configuredThemes.length > 0 ? configuredThemes : [defaultTheme];

  // In `[dark, light]` the scheme ends up light, so the earlier `dark` preset's tokens must not be written either:
  // a scheme theme's variables apply only when it forces the final scheme. Same-scheme themes (`[myDark, dark]`)
  // still merge in order.
  const finalScheme = activeThemes.reduce<"dark" | "light" | null>((last, theme) => schemeOf(theme) ?? last, null);
  activeThemes.forEach((theme) => {
    const scheme = schemeOf(theme);
    if (scheme === null || scheme === finalScheme) {
      Object.assign(variables, normalizeVariables(objectOrEmpty(theme.variables)));
    }
    Object.assign(layout, objectOrEmpty(theme.layout));
    mergeElements(elements, theme.elements);
    // `dark`/`light` never become classes here: components read the scheme through `useThemeScope()`.
    const names = Array.isArray(theme.classNames) ? theme.classNames.filter((name) => typeof name === "string") : [];
    themeClassNames.push(...names.flatMap((entry) => entry.split(/\s+/)).filter((name) => name && !SCHEME_CLASSES.has(name)));
  });

  for (const layer of present) {
    const own = normalizeVariables(objectOrEmpty(layer.variables));
    Object.assign(variables, own);
    Object.assign(explicitVariables, own);
    Object.assign(layout, objectOrEmpty(layer.layout));
    Object.assign(explicitLayout, objectOrEmpty(layer.layout));
    mergeElements(elements, layer.elements);
    mergeElements(explicitElements, layer.elements);
    if (typeof layer.unstyled === "boolean") unstyled = layer.unstyled;
  }

  const appearance: Appearance = {
    ...(configuredThemes ? { baseTheme: configuredThemes } : {}),
    variables: explicitVariables,
    layout: explicitLayout,
    elements: explicitElements,
    ...(present.some((layer) => typeof layer.unstyled === "boolean") ? { unstyled } : {}),
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
    themeClassNames,
    rootClassName: resolveElementClass(elements.rootBox, ...themeClassNames),
  };
}

/** One appearance, resolved on its own (the provider's). */
export function resolveAppearance(appearance: Appearance = {}): ResolvedAppearance {
  return resolveAppearanceLayers([appearance]);
}

/** A component's `appearance` prop as a new layer over the appearance in scope. */
export function extendAppearance(parent: ResolvedAppearance, appearance: Appearance | undefined | null): ResolvedAppearance {
  if (!isObject(appearance)) return parent;
  return resolveAppearanceLayers([...parent.layers, appearance]);
}

/**
 * Element resolver for `ElementSlotProvider`: for each key, the stable `orbitid-<key>` class then every override
 * layer, in key order. `unstyled` starts from the global setting; each key's explicit `unstyled` (true or false)
 * replaces it, the most specific key last.
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
      if (flat.unstyled !== undefined) unstyled = flat.unstyled;
    }
    const result: ElementSlotStyle = { className: classNames.join(" ") };
    if (style) result.style = style;
    if (unstyled) result.unstyled = true;
    return result;
  };
}
