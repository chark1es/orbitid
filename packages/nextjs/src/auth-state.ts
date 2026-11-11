import { redirect, notFound } from "next/navigation";
import type {
  AuthObject as BaseAuthObject,
  ReverificationConfig,
  SessionClaims,
} from "@orbitid/shared";
import { buildAuthUrl, getServerEnv, toAbsoluteUrl, type ResolvedServerEnv } from "./env";

/**
 * `protect()` targets come from app code, which may build them from a query parameter. Resolve them the same
 * way the middleware does, so `redirect()` never receives `//evil.test`, `/\evil.test` or `javascript:`.
 */
function safeRedirectTarget(target: string, requestUrl: string | undefined, fallback: string): string {
  if (requestUrl) return toAbsoluteUrl(target, requestUrl);
  // No request URL to resolve against: only an unambiguous same-app path is accepted.
  if (!target.startsWith("/") || target.startsWith("//") || /[\u0000-\u001f\u007f\\]/.test(target)) return fallback;
  return target;
}

/** Status carried from middleware to `auth()` through request headers. */
export type AuthStatus = "signed-in" | "signed-out" | "handshake";

export const AUTH_STATUS = {
  signedIn: "signed-in",
  signedOut: "signed-out",
  handshake: "handshake",
} as const satisfies Record<string, AuthStatus>;

export const AUTH_REASONS = {
  noSession: "no-session",
  noToken: "session-token-missing",
  expiredToken: "session-token-expired",
  invalidToken: "session-token-invalid",
  unverifiableKey: "session-token-unverifiable-key",
  missingKey: "session-token-unverifiable",
  unauthorizedParty: "unauthorized-party",
  handshake: "handshake",
} as const;

export type AuthReason = (typeof AUTH_REASONS)[keyof typeof AUTH_REASONS] | (string & {});

/** Internal, verified auth state attached to the request by `orbitIdMiddleware`. */
export interface RequestAuthState {
  status: AuthStatus;
  /** Raw `__session` JWT. Omitted for `handshake` so the client refreshes it. */
  token: string | null;
  reason?: AuthReason;
  message?: string;
  claims: SessionClaims | null;
  /** Absolute request URL, used for `redirect_url` on sign-in redirects. */
  url?: string;
}

export const AUTH_HEADERS = {
  status: "x-orbitid-auth-status",
  token: "x-orbitid-auth-token",
  reason: "x-orbitid-auth-reason",
  message: "x-orbitid-auth-message",
  url: "x-orbitid-auth-url",
} as const;

export function authStateToHeaders(state: RequestAuthState): Headers {
  const headers = new Headers();
  headers.set(AUTH_HEADERS.status, state.status);
  if (state.token) headers.set(AUTH_HEADERS.token, state.token);
  if (state.reason) headers.set(AUTH_HEADERS.reason, state.reason);
  if (state.message) headers.set(AUTH_HEADERS.message, state.message);
  if (state.url) headers.set(AUTH_HEADERS.url, state.url);
  return headers;
}

export function authStateFromHeaders(headers: Headers): RequestAuthState | null {
  const status = headers.get(AUTH_HEADERS.status);
  if (status !== "signed-in" && status !== "signed-out" && status !== "handshake") return null;
  const token = headers.get(AUTH_HEADERS.token);
  return {
    status,
    token: token || null,
    reason: headers.get(AUTH_HEADERS.reason) ?? undefined,
    message: headers.get(AUTH_HEADERS.message) ?? undefined,
    url: headers.get(AUTH_HEADERS.url) ?? undefined,
    claims: null,
  };
}

export interface ProtectParams {
  role?: string;
  permission?: string;
  feature?: string;
  /** Escape hatch for arbitrary checks; receives the same `AuthObject`. */
  has?: (auth: BaseAuthObject) => boolean;
  /** Signed-out handling. Default `redirect`; `throw` raises instead of navigating. */
  unauthenticated?: "redirect" | "throw";
  /** Signed-in-but-unauthorized handling. Default `notFound`. */
  unauthorized?: "notFound" | "redirect" | "throw";
  /** Signed-in-but-unauthorized redirect target (overrides `unauthorized`). */
  unauthorizedUrl?: string;
  /** Sign-in redirect override. */
  redirectUrl?: string;
  returnBackUrl?: string;
}

export interface AuthObject extends BaseAuthObject {
  /** Throws/redirects unless the caller satisfies the checks; returns itself when allowed. */
  protect: (params?: ProtectParams) => Promise<AuthObject>;
  redirectToSignIn: (opts?: { returnBackUrl?: string }) => never;
}

export interface CreateAuthObjectParams {
  claims: SessionClaims | null;
  token: string | null;
  status: AuthStatus;
  reason?: AuthReason;
  message?: string;
  /** Absolute URL of the current request (for `redirect_url`). */
  url?: string;
  env?: ResolvedServerEnv;
  /** Overrides the default `__session` token, e.g. for custom JWT templates. */
  getTokenOverride?: (opts?: { template?: string }) => Promise<string | null>;
}

const REVERIFICATION_PRESETS = {
  strict_mfa: { level: "multi_factor", afterMinutes: 10 },
  strict: { level: "first_factor", afterMinutes: 10 },
  moderate: { level: "first_factor", afterMinutes: 60 },
  lax: { level: "first_factor", afterMinutes: 1440 },
} as const;

function reverificationSatisfied(
  config: ReverificationConfig,
  factorVerificationAge: [number, number] | undefined,
  sessionStatus: "active" | "pending" | null,
): boolean {
  if (sessionStatus === "pending") return false;
  const resolved = typeof config === "string" ? REVERIFICATION_PRESETS[config] : config;
  if (!factorVerificationAge) return false;
  const [firstFactorAge, secondFactorAge] = factorVerificationAge;
  const firstOk = firstFactorAge >= 0 && firstFactorAge <= resolved.afterMinutes;
  const secondOk = secondFactorAge >= 0 && secondFactorAge <= resolved.afterMinutes;
  switch (resolved.level) {
    case "first_factor":
      return firstOk;
    case "second_factor":
      return secondOk;
    case "multi_factor":
      return firstOk && secondOk;
    default:
      return false;
  }
}

function featureList(claims: SessionClaims): string[] {
  const raw = claims.fea ?? claims.features;
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .filter(([, enabled]) => Boolean(enabled))
      .map(([feature]) => feature);
  }
  return [];
}

/** Instance role keys (`app:...`) from the token; the union of their permissions is `role_permissions`. */
function instanceRoleKeys(claims: SessionClaims | null): string[] {
  const raw = claims?.roles;
  return Array.isArray(raw) ? raw.filter((role): role is string => typeof role === "string") : [];
}

function instanceRolePermissions(claims: SessionClaims | null): string[] {
  const raw = claims?.role_permissions;
  return Array.isArray(raw) ? raw.filter((permission): permission is string => typeof permission === "string") : [];
}

/** True when a granted list covers `requested`, honouring a `prefix:*` wildcard grant. */
function grantsPermission(granted: string[], requested: string): boolean {
  return granted.some((permission) => permission === requested || (permission.endsWith(":*") && requested.startsWith(permission.slice(0, -1))));
}

/** Build the public `has()` predicate from verified claims. */
export function createHasChecker(
  claims: SessionClaims | null,
  sessionStatus: "active" | "pending" | null,
): BaseAuthObject["has"] {
  return (check) => {
    if (!claims) return false;
    if (sessionStatus === "pending") return false;
    // `has({})` asks nothing; answering `true` would let a gate built from missing parameters pass. `protect()`
    // with no checks is unaffected: it calls `has()` only for the checks the caller actually passed.
    if (
      check.role === undefined &&
      check.permission === undefined &&
      check.feature === undefined &&
      check.reverification === undefined
    ) {
      return false;
    }
    if (check.role !== undefined) {
      // Instance roles (`app:...`) are independent of the organization role; `{ role }` matches either.
      const owned = new Set(instanceRoleKeys(claims));
      if (typeof claims.org_role === "string") owned.add(claims.org_role);
      if (!owned.has(check.role)) return false;
    }
    if (check.permission !== undefined) {
      if (
        !grantsPermission(claims.org_permissions ?? [], check.permission) &&
        !grantsPermission(instanceRolePermissions(claims), check.permission)
      ) {
        return false;
      }
    }
    if (check.feature !== undefined) {
      if (!featureList(claims).includes(check.feature)) return false;
    }
    if (check.reverification !== undefined) {
      return reverificationSatisfied(check.reverification, claims.fva, sessionStatus);
    }
    return true;
  };
}

function satisfiesProtectChecks(auth: AuthObject, params: ProtectParams): boolean {
  if (params.role !== undefined && !auth.has({ role: params.role })) return false;
  if (params.permission !== undefined && !auth.has({ permission: params.permission })) return false;
  if (params.feature !== undefined && !auth.has({ feature: params.feature })) return false;
  if (params.has && !params.has(auth)) return false;
  return true;
}

/**
 * Build an AuthObject from verified claims. `protect()` and `redirectToSignIn()` are bound to
 * Next's navigation primitives, so this is server-only (RSC, route handlers, server actions).
 */
export function createAuthObject(params: CreateAuthObjectParams): AuthObject {
  const { token, status } = params;
  const claims = status === "signed-in" ? params.claims : null;
  const env = params.env ?? getServerEnv();
  const sessionStatus = claims?.sts ?? (status === "signed-in" ? "active" : null);
  const userToken = params.getTokenOverride ?? (async () => token);
  // A pending session (e.g. required MFA not yet set up) is not a signed-in user.
  const authenticated = sessionStatus === "pending" ? null : claims;

  const auth: AuthObject = {
    userId: authenticated?.sub ?? null,
    sessionId: claims?.sid ?? null,
    orgId: authenticated?.org_id ?? null,
    orgRole: authenticated?.org_role ?? null,
    orgSlug: authenticated?.org_slug ?? null,
    orgPermissions: authenticated?.org_permissions ?? null,
    // Instance-wide roles (`app:...`) are separate from the organization role; a pending session has neither.
    roles: instanceRoleKeys(authenticated),
    rolePermissions: instanceRolePermissions(authenticated),
    actor: authenticated?.act ?? null,
    sessionClaims: claims,
    sessionStatus,
    isAuthenticated: status === "signed-in" && authenticated !== null,
    getToken: userToken,
    has: createHasChecker(claims, sessionStatus),
    redirectToSignIn(opts?: { returnBackUrl?: string }): never {
      const url = buildAuthUrl(env.signInUrl, opts?.returnBackUrl ?? params.url ?? null);
      redirect(url);
    },
    async protect(protectParams: ProtectParams = {}) {
      if (auth.isAuthenticated && satisfiesProtectChecks(auth, protectParams)) return auth;

      if (!auth.isAuthenticated) {
        if (protectParams.unauthenticated === "throw") {
          throw new Error(
            `Not authenticated: ${params.reason ?? "no-session"}${params.message ? ` (${params.message})` : ""}`,
          );
        }
        const redirectUrl =
          protectParams.redirectUrl !== undefined
            ? safeRedirectTarget(protectParams.redirectUrl, params.url, env.signInUrl)
            : buildAuthUrl(
                env.signInUrl,
                protectParams.returnBackUrl ?? params.url ?? null,
              );
        redirect(redirectUrl);
      }

      if (protectParams.unauthorizedUrl) {
        redirect(safeRedirectTarget(protectParams.unauthorizedUrl, params.url, env.signInUrl));
      }
      if (protectParams.unauthorized === "redirect") {
        redirect(safeRedirectTarget(protectParams.redirectUrl ?? env.signInUrl, params.url, env.signInUrl));
      }
      if (protectParams.unauthorized === "throw") {
        throw new Error("Not authorized");
      }
      notFound();
    },
  };

  return auth;
}

/** Auth state forwarded to the client provider for SSR hydration. */
export interface InitialAuthState {
  status: AuthStatus;
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  orgSlug: string | null;
  orgPermissions: string[] | null;
  sessionClaims: SessionClaims | null;
  reason?: string;
}

export function toInitialAuthState(auth: BaseAuthObject, status: AuthStatus, reason?: string): InitialAuthState {
  return {
    status,
    userId: auth.userId,
    sessionId: auth.sessionId,
    orgId: auth.orgId,
    orgRole: auth.orgRole,
    orgSlug: auth.orgSlug,
    orgPermissions: auth.orgPermissions,
    sessionClaims: auth.sessionClaims,
    reason,
  };
}
