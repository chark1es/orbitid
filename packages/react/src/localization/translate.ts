import { enUS, type TranslationKey } from "./enUS";
import type { LocalizationParams, LocalizationResource, TFunction } from "./types";

export { mergeLocalization } from "./merge";

/** Read a dotted path out of a nested dictionary; `undefined` when absent or non-string. */
export function getByPath(resource: LocalizationResource | undefined, path: string): string | undefined {
  if (!resource) return undefined;
  let current: string | LocalizationResource | undefined = resource;
  for (const segment of path.split(".")) {
    if (typeof current === "string") return undefined;
    current = current?.[segment];
  }
  return typeof current === "string" ? current : undefined;
}

/** Replace every `{{ name }}` with `vars.name`; unknown placeholders stay visible. */
export function interpolate(template: string, vars?: Record<string, unknown>): string {
  if (!vars) return template;
  return template.replace(/\{\{\s*([\w.]+)\s*\}\}/g, (match, key: string) => {
    const value = vars[key];
    return value === undefined || value === null ? match : String(value);
  });
}

function normalizeParams(params?: LocalizationParams): { vars?: Record<string, unknown>; fallback?: string } {
  if (params === undefined) return {};
  if (typeof params === "string") return { fallback: params };
  if (typeof params === "number") return { vars: { count: params } };
  return { vars: params };
}

/**
 * Build a `t()` bound to one resource. Resolution order:
 * requested locale → `enUS` → `params` string fallback → the path itself.
 */
export function createTranslator(
  resource: LocalizationResource,
  fallback: LocalizationResource = enUS,
): TFunction {
  return (path, params) => {
    const { vars, fallback: fallbackMessage } = normalizeParams(params);
    const message = getByPath(resource, path) ?? getByPath(fallback, path) ?? fallbackMessage ?? path;
    return interpolate(message, vars);
  };
}

/** Localized message for an API error code (`unstable__errors.<code>`), or `fallback`. */
export function translateErrorCode(t: TFunction, code: string | undefined, fallback?: string): string {
  if (!code) return fallback ?? t("unstable__errors.unknown_error");
  const message = getByPath(enUS, `unstable__errors.${code}`);
  return message ? t(`unstable__errors.${code}`) : (fallback ?? t("unstable__errors.unknown_error"));
}

function collectKeys(resource: LocalizationResource, prefix: string, into: Set<string>): void {
  for (const [key, value] of Object.entries(resource)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (typeof value === "string") into.add(path);
    else if (value) collectKeys(value, path, into);
  }
}

const keys: Set<string> = new Set();
collectKeys(enUS, "", keys);

/** True when `key` is a dot path defined in `enUS`. Narrows to {@link TranslationKey}. */
export function isTranslationKey(key: string): key is TranslationKey {
  return keys.has(key);
}
