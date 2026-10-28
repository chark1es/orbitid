import { decodePublishableKey, isPublishableKey } from "@orbitid/shared";

/**
 * Environment resolution for `@orbitid/nextjs`.
 *
 * Server code reads `ORBITID_*` variables; browser code (the client provider) must reference
 * `NEXT_PUBLIC_*` variables literally so Next.js can inline them at build time. This module is
 * imported by both entry points, so every public variable is also read through a literal here.
 */

export const ENV_KEYS = {
  publishableKey: "NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY",
  signInUrl: "NEXT_PUBLIC_ORBITID_SIGN_IN_URL",
  signUpUrl: "NEXT_PUBLIC_ORBITID_SIGN_UP_URL",
  afterSignInUrl: "NEXT_PUBLIC_ORBITID_AFTER_SIGN_IN_URL",
  afterSignUpUrl: "NEXT_PUBLIC_ORBITID_AFTER_SIGN_UP_URL",
  apiUrl: "NEXT_PUBLIC_ORBITID_API_URL",
  secretKey: "ORBITID_SECRET_KEY",
  jwtKey: "ORBITID_JWT_KEY",
  authorizedParties: "ORBITID_AUTHORIZED_PARTIES",
  webhookSecret: "ORBITID_WEBHOOK_SECRET",
} as const;

export const DEFAULT_SIGN_IN_URL = "/sign-in";
export const DEFAULT_SIGN_UP_URL = "/sign-up";
export const DEFAULT_AFTER_SIGN_IN_URL = "/";
export const DEFAULT_AFTER_SIGN_UP_URL = "/";
export const DEFAULT_API_URL = "http://localhost:4000";
export const JWKS_PATH = "/.well-known/jwks.json";

/** Literal reads: keep these so Next.js can statically inline them into the client bundle. */
function readPublicEnvLiteral(): Record<string, string | undefined> {
  return {
    [ENV_KEYS.publishableKey]: process.env.NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY,
    [ENV_KEYS.signInUrl]: process.env.NEXT_PUBLIC_ORBITID_SIGN_IN_URL,
    [ENV_KEYS.signUpUrl]: process.env.NEXT_PUBLIC_ORBITID_SIGN_UP_URL,
    [ENV_KEYS.afterSignInUrl]: process.env.NEXT_PUBLIC_ORBITID_AFTER_SIGN_IN_URL,
    [ENV_KEYS.afterSignUpUrl]: process.env.NEXT_PUBLIC_ORBITID_AFTER_SIGN_UP_URL,
    [ENV_KEYS.apiUrl]: process.env.NEXT_PUBLIC_ORBITID_API_URL,
  };
}

/** Read an environment variable without throwing when `process` is unavailable (edge/browser). */
export function readEnv(name: string): string | undefined {
  const literal = readPublicEnvLiteral()[name];
  if (literal) return literal.trim() || undefined;
  const value = typeof process !== "undefined" ? process.env[name] : undefined;
  return value?.trim() || undefined;
}

export function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

/** Frontend API URL encoded in a `pk_test_…` publishable key. `null` for malformed keys. */
export function frontendApiFromPublishableKey(publishableKey: string | undefined): string | null {
  if (!publishableKey || !isPublishableKey(publishableKey)) return null;
  try {
    return stripTrailingSlash(decodePublishableKey(publishableKey).frontendApi);
  } catch {
    return null;
  }
}

export function getPublishableKey(): string | undefined {
  return readEnv(ENV_KEYS.publishableKey);
}

export function getSecretKey(): string | undefined {
  return readEnv(ENV_KEYS.secretKey);
}

export function getJwtKey(): string | undefined {
  return readEnv(ENV_KEYS.jwtKey);
}

/** Resolve the Backend/Frontend API base URL: explicit env, then the publishable key, then localhost. */
export function resolveApiUrl(opts: { publishableKey?: string; apiUrl?: string } = {}): string {
  const publishableKey = opts.publishableKey ?? getPublishableKey();
  const explicit = opts.apiUrl ?? readEnv(ENV_KEYS.apiUrl);
  if (explicit) return stripTrailingSlash(explicit);
  const derived = frontendApiFromPublishableKey(publishableKey);
  return derived ?? DEFAULT_API_URL;
}

export function resolveJwksUrl(apiUrl: string): string {
  if (apiUrl.endsWith(JWKS_PATH)) return apiUrl;
  return `${stripTrailingSlash(apiUrl)}${JWKS_PATH}`;
}

/** `ORBITID_AUTHORIZED_PARTIES` is a comma-separated list of allowed origins. */
export function parseAuthorizedParties(value: string | string[] | undefined): string[] | undefined {
  if (!value) return undefined;
  const list = Array.isArray(value) ? value : value.split(",");
  const parties = list.map((p) => stripTrailingSlash(p.trim())).filter(Boolean);
  return parties.length > 0 ? parties : undefined;
}

export function getAuthorizedParties(): string[] | undefined {
  return parseAuthorizedParties(readEnv(ENV_KEYS.authorizedParties));
}

export interface PublicEnv {
  publishableKey: string | undefined;
  signInUrl: string;
  signUpUrl: string;
  afterSignInUrl: string;
  afterSignUpUrl: string;
  apiUrl: string;
}

/** Environment consumed by the client provider (all `NEXT_PUBLIC_*`). */
export function getPublicEnv(overrides: Partial<PublicEnv> = {}): PublicEnv {
  const publishableKey = overrides.publishableKey ?? getPublishableKey();
  return {
    publishableKey,
    signInUrl: overrides.signInUrl ?? readEnv(ENV_KEYS.signInUrl) ?? DEFAULT_SIGN_IN_URL,
    signUpUrl: overrides.signUpUrl ?? readEnv(ENV_KEYS.signUpUrl) ?? DEFAULT_SIGN_UP_URL,
    afterSignInUrl: overrides.afterSignInUrl ?? readEnv(ENV_KEYS.afterSignInUrl) ?? DEFAULT_AFTER_SIGN_IN_URL,
    afterSignUpUrl: overrides.afterSignUpUrl ?? readEnv(ENV_KEYS.afterSignUpUrl) ?? DEFAULT_AFTER_SIGN_UP_URL,
    apiUrl: resolveApiUrl({ publishableKey, apiUrl: overrides.apiUrl }),
  };
}

export interface ServerEnvOverrides {
  publishableKey?: string;
  secretKey?: string;
  jwtKey?: string;
  apiUrl?: string;
  jwksUrl?: string;
  authorizedParties?: string[] | string;
  signInUrl?: string;
  signUpUrl?: string;
  afterSignInUrl?: string;
  afterSignUpUrl?: string;
  clockSkewInMs?: number;
}

export interface ResolvedServerEnv {
  publishableKey: string | undefined;
  secretKey: string | undefined;
  jwtKey: string | undefined;
  apiUrl: string;
  jwksUrl: string;
  authorizedParties: string[] | undefined;
  signInUrl: string;
  signUpUrl: string;
  afterSignInUrl: string;
  afterSignUpUrl: string;
  clockSkewInMs: number | undefined;
}

/** Merge explicit options with environment variables. Used by middleware, `auth()` and helpers. */
export function getServerEnv(overrides: ServerEnvOverrides = {}): ResolvedServerEnv {
  const publishableKey = overrides.publishableKey ?? getPublishableKey();
  const apiUrl = resolveApiUrl({ publishableKey, apiUrl: overrides.apiUrl });
  return {
    publishableKey,
    secretKey: overrides.secretKey ?? getSecretKey(),
    jwtKey: overrides.jwtKey ?? getJwtKey(),
    apiUrl,
    jwksUrl: overrides.jwksUrl ?? resolveJwksUrl(apiUrl),
    authorizedParties:
      overrides.authorizedParties !== undefined
        ? parseAuthorizedParties(overrides.authorizedParties)
        : getAuthorizedParties(),
    signInUrl: overrides.signInUrl ?? readEnv(ENV_KEYS.signInUrl) ?? DEFAULT_SIGN_IN_URL,
    signUpUrl: overrides.signUpUrl ?? readEnv(ENV_KEYS.signUpUrl) ?? DEFAULT_SIGN_UP_URL,
    afterSignInUrl: overrides.afterSignInUrl ?? readEnv(ENV_KEYS.afterSignInUrl) ?? DEFAULT_AFTER_SIGN_IN_URL,
    afterSignUpUrl: overrides.afterSignUpUrl ?? readEnv(ENV_KEYS.afterSignUpUrl) ?? DEFAULT_AFTER_SIGN_UP_URL,
    clockSkewInMs: overrides.clockSkewInMs,
  };
}

/** Resolve a (possibly relative) app URL against the current origin. */
export function toAbsoluteUrl(url: string, origin: string): string {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) return url;
  return new URL(url, origin).toString();
}

/** Build a sign-in/sign-up URL carrying `redirect_url`, the parameter the sign-in page reads. */
export function buildAuthUrl(baseUrl: string, returnBackUrl?: string | null): string {
  if (!returnBackUrl) return baseUrl;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\//i.test(baseUrl);
  const hashIndex = baseUrl.indexOf("#");
  const hash = hashIndex === -1 ? "" : baseUrl.slice(hashIndex);
  const withoutHash = hashIndex === -1 ? baseUrl : baseUrl.slice(0, hashIndex);
  const url = new URL(withoutHash, "http://placeholder.invalid");
  url.searchParams.set("redirect_url", returnBackUrl);
  const path = `${url.pathname}${url.search}${hash}`;
  return absolute ? `${url.origin}${path}` : path;
}

export function getWebhookSecret(): string | undefined {
  return readEnv(ENV_KEYS.webhookSecret);
}
