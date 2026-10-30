import { isRecord } from "../guards";
import {
  isTranslationKey,
  type TranslateParams,
  type TranslationKey,
} from "../../../../localization";

export class AuthUIError extends Error {
  code: string;
  longMessage?: string;
  meta?: Record<string, unknown>;

  constructor(code: string, message?: string, longMessage?: string, meta?: Record<string, unknown>) {
    super(message ?? code);
    this.name = "AuthUIError";
    this.code = code;
    this.longMessage = longMessage;
    this.meta = meta;
  }
}

function firstErrorItem(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;
  const list = value.errors;
  if (!Array.isArray(list) || list.length === 0) return null;
  const first: unknown = list[0];
  return isRecord(first) ? first : null;
}

export function toAuthError(error: unknown): AuthUIError {
  if (error instanceof AuthUIError) return error;
  const item = firstErrorItem(error);
  if (item) {
    const code = typeof item.code === "string" ? item.code : "unexpected";
    const message = typeof item.message === "string" ? item.message : undefined;
    const longMessage = typeof item.long_message === "string" ? item.long_message : undefined;
    const meta = isRecord(item.meta) ? item.meta : undefined;
    return new AuthUIError(code, message, longMessage, meta);
  }
  if (isRecord(error)) {
    const nested = error.error;
    if (isRecord(nested) && typeof nested.code === "string") {
      return new AuthUIError(
        nested.code,
        typeof nested.message === "string" ? nested.message : undefined,
        typeof error.longMessage === "string" ? error.longMessage : undefined,
      );
    }
    if (typeof error.code === "string") {
      return new AuthUIError(
        error.code,
        typeof error.message === "string" ? error.message : undefined,
        typeof error.long_message === "string" ? error.long_message : undefined,
        isRecord(error.meta) ? error.meta : undefined,
      );
    }
  }
  if (error instanceof Error) {
    const network = error.name === "TypeError" && /fetch|network/i.test(error.message);
    return new AuthUIError(network ? "network" : "unexpected", error.message);
  }
  return new AuthUIError("unexpected");
}

/** Localized message for an API/UI error, falling back to the server's long message. */
export function errorMessage(t: (key: TranslationKey, params?: TranslateParams) => string, error: unknown): string {
  const authError = toAuthError(error);
  const meta = authError.meta;
  const params: TranslateParams | undefined = meta
    ? { min: String(meta.min_length ?? ""), max: String(meta.max_length ?? "") }
    : undefined;
  const unstableKey = `unstable__errors.${authError.code}` as TranslationKey;
  const unstable = t(unstableKey, params);
  if (unstable !== unstableKey) return unstable;
  const key = `errors.${authError.code}`;
  if (isTranslationKey(key)) return t(key, params);
  if (authError.longMessage) return authError.longMessage;
  if (authError.message && authError.message !== authError.code) return authError.message;
  return t("errors.unexpected");
}

export function isReverificationError(error: unknown): boolean {
  return toAuthError(error).code === "session_reverification_required";
}

export async function invokeMethod<T = unknown>(
  targets: unknown | unknown[],
  methods: readonly string[],
  args?: Record<string, unknown>,
): Promise<T> {
  for (const target of Array.isArray(targets) ? targets : [targets]) {
    if (!isRecord(target)) continue;
    for (const method of methods) {
      const fn = target[method];
      if (typeof fn === "function") {
        return (await (fn as (params?: unknown) => unknown).call(target, args)) as T;
      }
    }
  }
  throw new AuthUIError("not_supported", `OrbitID resource does not implement ${methods.join(" / ")}`);
}
