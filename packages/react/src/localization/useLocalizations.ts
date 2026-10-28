import { useContext } from "react";
import { LocalizationContext } from "../provider/contexts";
import type { LocalizationContextValue } from "./types";

/**
 * Active localization dictionary.
 *
 * ```tsx
 * const { t } = useLocalizations();
 * <h1>{t('signIn.start.title', { applicationName: 'Acme' })}</h1>
 * ```
 *
 * Resolution order: active locale → `enUS` → the dot-path itself, so a missing key is
 * visible but never crashes a form.
 */
export function useLocalizations(): LocalizationContextValue {
  return useContext(LocalizationContext);
}
