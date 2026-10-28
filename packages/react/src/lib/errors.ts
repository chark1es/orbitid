import { ErrorCodes, type ApiErrorItem } from "@orbitid/shared";
import type { TFunction } from "../localization/types";
import { translateErrorCode } from "../localization/translate";

/** Shape of an error thrown by `@orbitid/js` / the API client: `{ errors: [...] }`. */
export interface OrbitApiErrorLike {
  errors: ApiErrorItem[];
  status?: number;
  traceId?: string;
  message?: string;
}

export interface FieldError {
  type: "server" | "manual";
  message: string;
}

export type FieldErrors = Record<string, FieldError>;
export type SetFieldErrors = (fieldErrors: FieldErrors) => void;

/** Error codes that always belong to a specific form field. */
const CODE_TO_FIELD: Record<string, string> = {
  [ErrorCodes.form_identifier_not_found]: "identifier",
  [ErrorCodes.form_identifier_exists]: "emailAddress",
  [ErrorCodes.form_password_incorrect]: "password",
  [ErrorCodes.form_password_pwned]: "password",
  [ErrorCodes.form_password_length_too_short]: "password",
  [ErrorCodes.form_password_not_strong_enough]: "password",
  [ErrorCodes.form_username_invalid_length]: "username",
  [ErrorCodes.form_username_invalid_character]: "username",
  [ErrorCodes.form_code_incorrect]: "code",
  [ErrorCodes.verification_expired]: "code",
  [ErrorCodes.verification_failed]: "code",
  [ErrorCodes.organization_slug_taken]: "slug",
  [ErrorCodes.duplicate_record]: "emailAddress",
  [ErrorCodes.strategy_for_user_invalid]: "strategy",
  [ErrorCodes.last_identification_cannot_be_removed]: "emailAddress",
};

const snakeToCamel = (value: string) => value.replace(/_([a-z0-9])/g, (_, char: string) => char.toUpperCase());

type ErrorCandidate = { errors?: unknown; code?: unknown; message?: unknown; meta?: unknown };

/** True when `error` carries OrbitID API error items. */
export function isOrbitApiError(error: unknown): error is OrbitApiErrorLike {
  if (!error || typeof error !== "object") return false;
  const candidate: ErrorCandidate = error;
  return Array.isArray(candidate.errors) && candidate.errors.length > 0;
}

/** Normalized API error items for any thrown value (empty when it is not an API error). */
export function getErrorItems(error: unknown): ApiErrorItem[] {
  if (isOrbitApiError(error)) return error.errors;
  if (error && typeof error === "object") {
    const candidate: ErrorCandidate = error;
    if (typeof candidate.code === "string") {
      return [{ code: candidate.code, message: typeof candidate.message === "string" ? candidate.message : candidate.code }];
    }
  }
  return [];
}

export function getErrorCode(error: unknown): string | undefined {
  return getErrorItems(error)[0]?.code;
}

/** `session_reverification_required` from any wrapping shape. */
export function isReverificationError(error: unknown): boolean {
  return getErrorItems(error).some((item) => item.code === ErrorCodes.reverification_required);
}

export function isErrorCode(error: unknown, code: string): boolean {
  return getErrorItems(error).some((item) => item.code === code);
}

/** Best human-readable message: localized by code when `t` is given, else the server text. */
export function getErrorMessage(error: unknown, t?: TFunction): string {
  const [first] = getErrorItems(error);
  if (first) {
    if (t) return translateErrorCode(t, first.code, first.message);
    return first.message || first.code;
  }
  if (error instanceof Error && error.message) return error.message;
  return t ? translateErrorCode(t, undefined) : "Something went wrong. Please try again.";
}

export interface MapFieldErrorsResult {
  fieldErrors: FieldErrors;
  /** First error that could not be attributed to a field. */
  globalError: string | null;
}

/** Map API errors to `{ fieldName: { type: 'server', message } }` plus a global message. */
export function mapFieldErrors(error: unknown, t?: TFunction): MapFieldErrorsResult {
  const fieldErrors: FieldErrors = {};
  let globalError: string | null = null;
  for (const item of getErrorItems(error)) {
    const paramName = typeof item.meta?.param_name === "string" ? item.meta.param_name : undefined;
    const field = paramName ? snakeToCamel(paramName) : CODE_TO_FIELD[item.code];
    const message = t ? translateErrorCode(t, item.code, item.message) : item.message || item.code;
    if (field) {
      fieldErrors[field] ??= { type: "server", message };
    } else if (!globalError) {
      globalError = message;
    }
  }
  if (!globalError && Object.keys(fieldErrors).length === 0) {
    globalError = getErrorMessage(error, t);
  }
  return { fieldErrors, globalError };
}

export interface HandleOrbitErrorOptions {
  /** Localized messages (`useLocalizations().t`). */
  t?: TFunction;
  /** Called with the resolved global message (null when every error mapped to a field). */
  setGlobalError?: (message: string | null) => void;
  /** API field name → form field name overrides. */
  fieldAliases?: Record<string, string>;
}

export interface HandledOrbitError {
  fieldErrors: FieldErrors;
  globalError: string | null;
}

/**
 * Wire an API failure into a react-hook-form form: field errors go to `setFieldErrors`,
 * everything else to `setGlobalError`.
 */
export function handleOrbitError(
  error: unknown,
  setFieldErrors?: SetFieldErrors,
  options: HandleOrbitErrorOptions = {},
): HandledOrbitError {
  const { fieldErrors, globalError } = mapFieldErrors(error, options.t);
  const aliased: FieldErrors = {};
  for (const [field, value] of Object.entries(fieldErrors)) {
    aliased[options.fieldAliases?.[field] ?? field] = value;
  }
  if (Object.keys(aliased).length > 0) setFieldErrors?.(aliased);
  options.setGlobalError?.(globalError);
  return { fieldErrors: aliased, globalError };
}
