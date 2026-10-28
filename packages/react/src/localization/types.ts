/**
 * Localization dictionary shape. Leaf values are strings; `{{var}}` placeholders are
 * interpolated by `t()`. Missing paths fall back to `enUS`.
 *
 * The index signature keeps the door open: components may add keys to `enUS.ts` without
 * touching this type, and locales may translate only a subset.
 */
export interface LocalizationResource {
  locale?: string;
  [key: string]: string | LocalizationResource | undefined;
}

/** Params accepted by `t`: a vars object, `{{count}}` shorthand, or a literal fallback string. */
export type LocalizationParams = Record<string, string | number | null | undefined> | number | string;

export type TFunction = (path: string, params?: LocalizationParams) => string;

export interface LocalizationContextValue {
  /** BCP-47 locale of the active resource, e.g. `en-US`. */
  locale: string;
  resource: LocalizationResource;
  t: TFunction;
}
