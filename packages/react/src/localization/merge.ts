import type { LocalizationResource } from "./types";

/** Deep-merge `override` over `base`; strings win over nested objects. */
export function mergeLocalization(
  base: LocalizationResource,
  override: LocalizationResource | undefined,
): LocalizationResource {
  if (!override) return base;
  const merged: LocalizationResource = { ...base };
  for (const [key, value] of Object.entries(override)) {
    const existing = merged[key];
    merged[key] =
      value && typeof value === "object" && existing && typeof existing === "object"
        ? mergeLocalization(existing, value)
        : value;
  }
  return merged;
}
