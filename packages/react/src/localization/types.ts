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

/** Interpolation variables for the component translate function. */
export type TranslateParams = Record<string, string | number | null | undefined>;

/**
 * `Override` deep-merged over `Base`: nested objects merge, any other value in `Override` wins.
 * Mirrors {@link mergeLocalization} at the type level so the key union covers both dictionaries.
 */
export type DeepMerge<Base, Override> = {
  [K in keyof Base | keyof Override]: K extends keyof Override
    ? K extends keyof Base
      ? Base[K] extends string
        ? Override[K] extends string
          ? Override[K]
          : Base[K]
        : Override[K] extends string
          ? Override[K]
          : DeepMerge<Base[K], Override[K]>
      : Override[K]
    : K extends keyof Base
      ? Base[K]
      : never;
};

/**
 * Every dot path that resolves to a string in a nested dictionary.
 *
 * ```ts
 * type Key = DotPaths<{ a: { b: "x" } }>; // "a.b"
 * ```
 */
export type DotPaths<T> = {
  [K in keyof T & string]: T[K] extends string
    ? K
    : T[K] extends Record<string, unknown>
      ? `${K}.${DotPaths<T[K]>}`
      : never;
}[keyof T & string];

export type TFunction = (path: string, params?: LocalizationParams) => string;

export interface LocalizationContextValue {
  /** BCP-47 locale of the active resource, e.g. `en-US`. */
  locale: string;
  resource: LocalizationResource;
  t: TFunction;
}
