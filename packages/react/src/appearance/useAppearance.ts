import { useCallback, useContext, useMemo } from "react";
import { AppearanceContext } from "../provider/contexts";
import { resolveElementClass } from "./resolve";
import type { ClassValue, ResolvedAppearance } from "./types";

export interface UseAppearanceReturn extends ResolvedAppearance {
  /** `ae('formButtonPrimary', 'w-full')` → merged class string for that element. */
  ae: (elementName: string, ...classes: ClassValue[]) => string;
  /** Resolved `className` of one element override, without extra classes. */
  getElementClass: (elementName: string) => string;
}

/**
 * Merged appearance (theme + provider/appearance-prop overrides), plus class helpers.
 *
 * Components should prefer `useElementClasses(name)`; `useAppearance()` is for layout
 * switches (`socialButtonsVariant`, logo placement, …) and CSS variables.
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
 * Per-element class helper bound to one element name:
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
