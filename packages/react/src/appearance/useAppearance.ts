import { useCallback, useContext, useMemo, type CSSProperties } from "react";
import { mergeElementSlot, useElementSlotResolver, type ElementSlotResolver } from "@orbitid/ui";
import { AppearanceContext } from "../provider/contexts";
import { resolveElementClass } from "./resolve";
import type { ElementKey } from "./elements";
import type { ClassValue, ResolvedAppearance } from "./types";

export interface UseAppearanceReturn extends ResolvedAppearance {
  /** `ae('formButtonPrimary', 'w-full')` → merged class string for that element (classes only). */
  ae: (elementName: string, ...classes: ClassValue[]) => string;
  /** Resolved `className` of one element override, without extra classes. */
  getElementClass: (elementName: string) => string;
}

/**
 * Merged appearance (theme + provider/appearance-prop overrides), plus class helpers.
 *
 * Inside a prebuilt component prefer `useElementProps()`, which also applies `style`, `unstyled` and the stable
 * `orbitid-<key>` class. `useAppearance()` is for layout switches and CSS variables.
 */
export function useAppearance(): UseAppearanceReturn {
  const resolved = useContext(AppearanceContext);
  const getElementClass = useCallback(
    (elementName: string) => resolveElementClass(resolved.elements[elementName]),
    [resolved.elements],
  );
  const ae = useCallback(
    (elementName: string, ...classes: ClassValue[]) => resolveElementClass(resolved.elements[elementName], ...classes),
    [resolved.elements],
  );
  return useMemo(() => ({ ...resolved, ae, getElementClass }), [resolved, ae, getElementClass]);
}

/**
 * Per-element class helper bound to one element name (classes only; kept for custom components that only need the
 * class string):
 *
 * ```tsx
 * const card = useElementClasses('card');
 * <div className={card('rounded-lg border p-6')} />
 * ```
 */
export function useElementClasses(elementName: string): (...classes: ClassValue[]) => string {
  const resolved = useContext(AppearanceContext);
  const override = resolved.elements[elementName];
  return useCallback((...classes: ClassValue[]) => resolveElementClass(override, ...classes), [override]);
}

/** Props `ep()` returns: spread them on a DOM element or an `@orbitid/ui` primitive. */
export interface ElementProps {
  className: string;
  style?: CSSProperties;
  "data-orbitid-element": string;
}

export type ElementPropsFn = (keys: ElementKey | readonly ElementKey[], ...classes: ClassValue[]) => ElementProps;

/** Pure form of {@link useElementProps}, for a resolver you already hold. */
export function elementProps(
  resolver: ElementSlotResolver | null,
  keys: ElementKey | readonly ElementKey[],
  classes: ClassValue[],
): ElementProps {
  const list = typeof keys === "string" ? [keys] : [...keys];
  const explicit = list.join(" ");
  const merged = mergeElementSlot(resolver, [], classes, { "data-orbitid-element": explicit });
  const props: ElementProps = { className: merged.className, "data-orbitid-element": explicit };
  if (merged.style) props.style = merged.style;
  return props;
}

/**
 * `ep(key, ...classes)` → `{ className, style, "data-orbitid-element" }` for one or more component element keys.
 * OrbitID's classes come first, then every `appearance.elements[key]` override in layer order, so overrides win.
 * Spread the result on the element: `<p {...ep("footerActionText", "text-muted-foreground")}>`. On a primitive the
 * primitive's own keys (`button`, `buttonPrimary`) apply first and the component key last.
 */
export function useElementProps(): ElementPropsFn {
  const resolver = useElementSlotResolver();
  return useCallback<ElementPropsFn>((keys, ...classes) => elementProps(resolver, keys, classes), [resolver]);
}
