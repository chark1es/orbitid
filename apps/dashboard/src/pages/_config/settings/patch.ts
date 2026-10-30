import {
  defaultInstanceSettings,
  instanceSettingsSchema,
  type InstanceSettings,
} from "@orbitid/shared";

/* ------------------------------------------------------------------------------------------------
 * Plain-object helpers
 * ---------------------------------------------------------------------------------------------- */

export type PlainObject = Record<string, unknown>;
export type DeepPatch = Record<string, unknown>;

export const isPlainObject = (value: unknown): value is PlainObject => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
};

/** Recursively merge a patch into a base value without mutating either argument. Arrays replace. */
export function deepMerge<T>(base: T, patch: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(patch)) return (patch === undefined ? base : patch) as T;
  const out: PlainObject = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    const current = out[key];
    out[key] = isPlainObject(current) && isPlainObject(value) ? deepMerge(current, value) : value;
  }
  return out as T;
}

export function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

const equalJson = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  try {
    return JSON.stringify(a) === JSON.stringify(b);
  } catch {
    return false;
  }
};

/* ------------------------------------------------------------------------------------------------
 * Instance settings: masking, normalizing, and PATCH payload construction
 * ---------------------------------------------------------------------------------------------- */

/** The server masks every stored secret as a run of bullets (`••••`) and drops that mask when it is sent back. */
const MASK_PATTERN = /^•{4,}$/;

/**
 * Only the server's own mask counts. A value the operator typed that merely contains a bullet, or looks like a
 * mask (`xxxx`, `****`), is a real value and must be validated and sent, never silently dropped.
 */
export function isMaskedSecret(value: unknown): boolean {
  return typeof value === "string" && MASK_PATTERN.test(value);
}

/** An empty or masked secret means "keep the stored value". */
export function shouldPreserveSecret(value: unknown): boolean {
  return value === undefined || value === null || value === "" || isMaskedSecret(value);
}

/** Dot paths (with `*` wildcards) whose values must never be overwritten by an empty form field. */
export const SECRET_SETTING_PATHS = [
  "email.smtpUrl",
  "email.resendApiKey",
  "security.captchaSecret",
  "sms.twilioAuthToken",
  "social.*.clientSecret",
  "social.*.applePrivateKey",
] as const;

function pathMatches(pattern: string, path: string): boolean {
  const a = pattern.split(".");
  const b = path.split(".");
  if (a.length !== b.length) return false;
  return a.every((part, index) => part === "*" || part === b[index]);
}

const isSecretPath = (path: string, patterns: readonly string[]) => patterns.some((pattern) => pathMatches(pattern, path));

function setAtPath(target: PlainObject, path: string, value: unknown): void {
  const parts = path.split(".");
  let cursor: PlainObject = target;
  for (let index = 0; index < parts.length - 1; index += 1) {
    const part = parts[index]!;
    const existing = cursor[part];
    if (!isPlainObject(existing)) cursor[part] = {};
    cursor = cursor[part] as PlainObject;
  }
  cursor[parts[parts.length - 1]!] = value;
}

/**
 * Produce a partial `InstanceSettings` PATCH body containing only changed paths.
 * Secret paths keep the stored value when the draft value is empty or masked.
 */
export function buildSettingsPatch(
  baseline: unknown,
  draft: unknown,
  secretPaths: readonly string[] = SECRET_SETTING_PATHS,
): DeepPatch {
  const patch: PlainObject = {};

  const walk = (base: unknown, next: unknown, path: string): void => {
    if (isPlainObject(base) && isPlainObject(next)) {
      const keys = new Set([...Object.keys(base), ...Object.keys(next)]);
      for (const key of keys) {
        const childPath = path ? `${path}.${key}` : key;
        if (!(key in next)) {
          // Settings cannot be deleted through the dashboard; omitted keys are no-ops.
          continue;
        }
        walk(base[key], next[key], childPath);
      }
      return;
    }
    if (equalJson(base, next)) return;
    if (isSecretPath(path, secretPaths) && shouldPreserveSecret(next)) return;
    if (next === undefined) return;
    setAtPath(patch, path, next);
  };

  walk(baseline, draft, "");
  return patch;
}

export const hasPatch = (patch: DeepPatch): boolean => Object.keys(patch).length > 0;

/** Merge a server response (full settings or `{ settings }`) onto a known baseline. */
export function mergeSettingsResponse(response: unknown, baseline: InstanceSettings): InstanceSettings {
  const body = isPlainObject(response) && isPlainObject(response.settings) ? response.settings : response;
  if (!isPlainObject(body) || Object.keys(body).length === 0) return instanceSettingsSchema.parse(baseline);
  return instanceSettingsSchema.parse(deepMerge(cloneJson(baseline), body));
}

/** GET /instance may return bare settings or an `{ settings }` envelope; fill missing defaults. */
export function normalizeInstanceSettings(response: unknown): InstanceSettings {
  const body = isPlainObject(response) && isPlainObject(response.settings) ? response.settings : response;
  const merged = deepMerge(defaultInstanceSettings(), isPlainObject(body) ? cloneJson(body) : {});
  return instanceSettingsSchema.parse(merged);
}

/** Blank hidden inputs while retaining a "configured" marker. */
export function secretInputValue(value: string | null | undefined): string {
  if (!value || isMaskedSecret(value)) return "";
  return value;
}

export function secretIsConfigured(value: string | null | undefined): boolean {
  return Boolean(value && (isMaskedSecret(value) || value.length > 0));
}

/* ------------------------------------------------------------------------------------------------
 * Sign-up and sign-in attributes
 * ---------------------------------------------------------------------------------------------- */
