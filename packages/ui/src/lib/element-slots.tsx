import * as React from "react"
import { cn } from "./utils"

/**
 * Element slots: how an embedding SDK restyles the primitives in this package without forking them.
 *
 * Every primitive declares one or more stable slot keys (`button`, `buttonPrimary`, `input`, `card`, …). Inside an
 * {@link ElementSlotProvider} it asks the provider's resolver for overrides for those keys, plus any explicit keys the
 * caller passed in `data-orbitid-element` (space-separated, most specific last). Outside a provider nothing changes:
 * the dashboard renders exactly the classes it always did.
 *
 * Precedence on one element is fixed: the primitive's own classes, then the caller's `className`, then the resolver's
 * classes for each key in order (generic slot keys first, explicit keys last). tailwind-merge keeps the last
 * conflicting utility, so a later key wins a conflict. Styles merge in the same order.
 */
export interface ElementSlotStyle {
  className?: string
  style?: React.CSSProperties
  /** Drop the primitive's own classes and the caller's `className`, keeping only the resolver's. */
  unstyled?: boolean
}

export type ElementSlotResolver = (keys: readonly string[]) => ElementSlotStyle

const ElementSlotContext = React.createContext<ElementSlotResolver | null>(null)

export const ElementSlotProvider = ElementSlotContext.Provider

/** The resolver in scope, or `null` outside an SDK component. */
export function useElementSlotResolver(): ElementSlotResolver | null {
  return React.useContext(ElementSlotContext)
}

type SlotKey = string | false | null | undefined

interface SlotInput {
  className?: string
  style?: React.CSSProperties
  "data-orbitid-element"?: string
}

/** Split explicit keys out of `data-orbitid-element` and append them after the slot keys, without duplicates. */
export function slotKeys(slots: readonly SlotKey[], explicit?: string): string[] {
  const keys: string[] = []
  for (const key of [...slots, ...(explicit ? explicit.split(/\s+/) : [])]) {
    if (key && !keys.includes(key)) keys.push(key)
  }
  return keys
}

/**
 * Classes that carry theming context rather than styling: the scheme class (`dark`/`light`) and OrbitID's scope
 * classes (`orbitid-component`, `orbitid-motion-off`, `orbitid-scope-*`). Pop-ups receive them through `className`
 * (they render outside their component's root), so they survive `unstyled`.
 */
const THEMING_CLASS = /^(?:dark|light|orbitid-component|orbitid-motion-off|orbitid-scope-[\w-]+)$/

/** The theming classes in a class list, in order. */
export function themingClasses(...classes: Parameters<typeof cn>): string {
  return cn(...classes)
    .split(/\s+/)
    .filter((name) => THEMING_CLASS.test(name))
    .join(" ")
}

/** Pure merge used by {@link useElementSlot}; exported for tests and for non-hook callers. */
export function mergeElementSlot(
  resolver: ElementSlotResolver | null,
  slots: readonly SlotKey[],
  base: Parameters<typeof cn>[0],
  props: SlotInput,
): { className: string; style?: React.CSSProperties } {
  if (!resolver) return { className: cn(base, props.className), style: props.style }
  const keys = slotKeys(slots, props["data-orbitid-element"])
  // A part with no key (a keyless use of a key-optional primitive) keeps its own classes.
  if (keys.length === 0) return { className: cn(base, props.className), style: props.style }
  const resolved = resolver(keys)
  // `unstyled` drops the primitive's recipe and the caller's styling classes, never the theming context.
  const className = resolved.unstyled
    ? cn(themingClasses(base, props.className), resolved.className)
    : cn(base, props.className, resolved.className)
  const style = resolved.style ? { ...props.style, ...resolved.style } : props.style
  return { className, style }
}

/**
 * `className` and `style` for a primitive. `base` is the primitive's own recipe (variants included); `className` and
 * `style` are the caller's; `rest` is the remaining props, read only for `data-orbitid-element`. Returns the caller's
 * values untouched (merged with `base`) when no provider is in scope.
 */
export function useElementSlot(
  slots: readonly SlotKey[],
  base: Parameters<typeof cn>[0],
  className: string | undefined,
  style: React.CSSProperties | undefined,
  rest?: object,
): { className: string; style?: React.CSSProperties } {
  const explicit = (rest as { "data-orbitid-element"?: unknown } | undefined)?.["data-orbitid-element"]
  return mergeElementSlot(useElementSlotResolver(), slots, base, {
    className,
    style,
    "data-orbitid-element": typeof explicit === "string" ? explicit : undefined,
  })
}

/** `button` → `buttonPrimary` style variant keys shared by buttons and badges. */
export function variantSlot(prefix: string, variant: string | null | undefined): string {
  const name = !variant || variant === "default" ? "primary" : variant === "destructive" ? "danger" : variant
  return `${prefix}${name.charAt(0).toUpperCase()}${name.slice(1)}`
}

/** `slotKeysFor("button", "outline")` → `["button", "buttonOutline"]`. */
export function slotKeysFor(prefix: string, variant: string | null | undefined): string[] {
  return [prefix, variantSlot(prefix, variant)]
}
