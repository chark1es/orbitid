import { NextResponse, type NextFetchEvent, type NextRequest } from "next/server";
import {
  AUTH_HEADERS,
  authStateToHeaders,
  createHasChecker,
  type AuthObject,
  type ProtectParams,
  type RequestAuthState,
} from "./auth-state";
import {
  buildAuthUrl,
  getServerEnv,
  toAbsoluteUrl,
  type ResolvedServerEnv,
  type ServerEnvOverrides,
} from "./env";
import { resolveRequestAuthState } from "./resolve";
import {
  completeHandshake,
  handshakeUnavailableFor,
  hasHandshakeMarker,
  hasHandshakeRetryMarker,
  isNavigationRequest,
  redirectToHandshake,
  resetHandshakeRetries,
  type HandshakeOptions,
} from "./handshake";

export interface ContentSecurityPolicyOptions {
  directives?: Record<string, string[]> | string[];
  reportOnly?: boolean;
  reportUri?: string;
  nonce?: string;
}

export type ContentSecurityPolicy = string | ContentSecurityPolicyOptions;

export interface OrbitIdMiddlewareOptions extends ServerEnvOverrides {
  /** Consumed by `orbitIdClient()` in server helpers, not by the middleware itself. */
  secretKey?: string;
  debug?: boolean;
  contentSecurityPolicy?: ContentSecurityPolicy;
  /**
   * Server-side handshake for hard navigations. Enabled by default; set `{ enabled: false }` to keep
   * forwarding `handshake` state and let the browser SDK refresh the token instead.
   */
  handshake?: HandshakeOptions;
}

/** Auth object handed to the middleware handler. Redirects return Next responses instead of throwing. */
export interface MiddlewareAuthObject extends Omit<AuthObject, "protect" | "redirectToSignIn"> {
  protect: (params?: ProtectParams) => Promise<MiddlewareAuthObject>;
  redirectToSignIn: (opts?: { returnBackUrl?: string }) => NextResponse;
}

export type MiddlewareHandler = (
  auth: MiddlewareAuthObject,
  req: NextRequest,
) => Response | void | Promise<Response | void>;

export type MiddlewareResult = (req: NextRequest, event?: NextFetchEvent) => Promise<Response>;

/** Internal control-flow signal so handlers can throw a ready-made middleware response. */
class MiddlewareResponseError extends Error {
  constructor(readonly response: Response) {
    super("OrbitID middleware response");
    this.name = "MiddlewareResponseError";
  }
}

function normalizeArgs(
  handlerOrOptions?: MiddlewareHandler | OrbitIdMiddlewareOptions,
  maybeOptions?: OrbitIdMiddlewareOptions,
): { handler?: MiddlewareHandler; options: OrbitIdMiddlewareOptions } {
  if (typeof handlerOrOptions === "function") {
    return { handler: handlerOrOptions, options: maybeOptions ?? {} };
  }
  return { handler: undefined, options: handlerOrOptions ?? maybeOptions ?? {} };
}

function signInResponse(req: NextRequest, env: ResolvedServerEnv, returnBackUrl?: string | null): NextResponse {
  const signInUrl = toAbsoluteUrl(env.signInUrl, req.url);
  return NextResponse.redirect(buildAuthUrl(signInUrl, returnBackUrl ?? req.url));
}

function unauthorizedResponse(req: NextRequest, params: ProtectParams): Response {
  if (params.unauthorizedUrl) {
    return NextResponse.redirect(toAbsoluteUrl(params.unauthorizedUrl, req.url));
  }
  if (params.unauthorized === "redirect") {
    return NextResponse.redirect(toAbsoluteUrl(params.redirectUrl ?? "/", req.url));
  }
  if (params.unauthorized === "throw") {
    throw new Error("Not authorized");
  }
  // Middleware cannot render Next's not-found boundary; answer with a plain 404.
  return new NextResponse("Not Found", { status: 404, statusText: "Not Found" });
}

function satisfiesProtectChecks(auth: MiddlewareAuthObject, params: ProtectParams): boolean {
  if (params.role !== undefined && !auth.has({ role: params.role })) return false;
  if (params.permission !== undefined && !auth.has({ permission: params.permission })) return false;
  if (params.feature !== undefined && !auth.has({ feature: params.feature })) return false;
  if (params.has && !params.has(auth)) return false;
  return true;
}

function createMiddlewareAuthObject(
  state: RequestAuthState,
  req: NextRequest,
  env: ResolvedServerEnv,
): MiddlewareAuthObject {
  const claims = state.status === "signed-in" ? state.claims : null;
  const sessionStatus = claims?.sts ?? (state.status === "signed-in" ? "active" : null);
  // A pending session (required MFA not yet set up) is not a signed-in user, here as in `auth()`.
  const authenticatedClaims = sessionStatus === "pending" ? null : claims;

  const auth: MiddlewareAuthObject = {
    userId: authenticatedClaims?.sub ?? null,
    sessionId: claims?.sid ?? null,
    orgId: authenticatedClaims?.org_id ?? null,
    orgRole: authenticatedClaims?.org_role ?? null,
    orgSlug: authenticatedClaims?.org_slug ?? null,
    orgPermissions: authenticatedClaims?.org_permissions ?? null,
    // Instance-wide roles live outside the organization claims; a pending session holds neither.
    roles: Array.isArray(authenticatedClaims?.roles)
      ? authenticatedClaims.roles.filter((role): role is string => typeof role === "string")
      : [],
    rolePermissions: Array.isArray(authenticatedClaims?.role_permissions)
      ? authenticatedClaims.role_permissions.filter((permission): permission is string => typeof permission === "string")
      : [],
    actor: claims?.act ?? null,
    sessionClaims: claims,
    sessionStatus,
    isAuthenticated: state.status === "signed-in" && authenticatedClaims !== null,
    getToken: async (opts) =>
      opts?.template ? null : state.token,
    has: createHasChecker(claims, sessionStatus),
    redirectToSignIn(opts) {
      return signInResponse(req, env, opts?.returnBackUrl);
    },
    async protect(params: ProtectParams = {}) {
      if (auth.isAuthenticated && satisfiesProtectChecks(auth, params)) return auth;
      if (!auth.isAuthenticated) {
        if (params.unauthenticated === "throw") {
          throw new Error(`Not authenticated: ${state.reason ?? "no-session"}`);
        }
        throw new MiddlewareResponseError(signInResponse(req, env, params.returnBackUrl));
      }
      throw new MiddlewareResponseError(unauthorizedResponse(req, params));
    },
  };

  return auth;
}

/** Build `NextResponse.next()` with the internal auth headers forwarded to RSC/route handlers. */
function forwardWithAuthHeaders(req: NextRequest, state: RequestAuthState): NextResponse {
  const headers = new Headers(req.headers);
  for (const name of Object.values(AUTH_HEADERS)) headers.delete(name);
  authStateToHeaders(state).forEach((value, key) => headers.set(key, value));
  return NextResponse.next({ request: { headers } });
}

function serializeCsp(csp: ContentSecurityPolicyOptions): string {
  const parts: string[] = [];
  if (Array.isArray(csp.directives)) {
    parts.push(...csp.directives);
  } else if (csp.directives) {
    for (const [directive, values] of Object.entries(csp.directives)) {
      parts.push(`${directive} ${values.join(" ")}`.trim());
    }
  }
  // A nonce is generated per request; it has to replace or add the `'nonce-…'` token of `script-src`.
  // Substituting in place only worked when the directive already listed a placeholder, so a policy configured
  // without one silently shipped no nonce and the page's inline bootstrap was blocked.
  if (csp.nonce) {
    // A nonce is base64-ish by definition; anything else (quotes, spaces, `;`) would let a configured value
    // inject or corrupt the header, so an unusable one is dropped rather than serialized verbatim.
    const safeNonce = /^[A-Za-z0-9+/_-]+=*$/.test(csp.nonce) ? csp.nonce : null;
    if (safeNonce) {
      const nonceToken = `'nonce-${safeNonce}'`;
      const target = "script-src";
      let scriptSrcSeen = false;
      let scriptSrcNonced = false;
      for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i]!;
        // Every directive that already carries a placeholder gets the fresh nonce, so a policy written for
        // the old nonce never ships a stale one. Only `script-src` is where a missing one is added: it is the
        // one directive the policy server owns for the page's own bootstrap. Synthesising `script-src-elem`,
        // `style-src` or `style-src-elem` would silently narrow or broaden what the operator allow-listed.
        const [name] = part.trim().split(/\s+/, 1);
        const isTarget = name === target;
        if (isTarget) scriptSrcSeen = true;
        if (!/'nonce-[^']*'/.test(part)) continue;
        if (isTarget) scriptSrcNonced = true;
        parts[i] = part.replace(/\s*'nonce-[^']*'/g, ` ${nonceToken}`).replace(/\s+/g, " ").trim();
      }
      if (scriptSrcSeen && !scriptSrcNonced) {
        // A configured `script-src` without a placeholder still needs this request's nonce appended.
        for (let i = 0; i < parts.length; i += 1) {
          if (parts[i]!.trim().split(/\s+/, 1)[0] === target) {
            parts[i] = `${parts[i]} ${nonceToken}`.trim();
            scriptSrcNonced = true;
            break;
          }
        }
      }
      if (!scriptSrcSeen && parts.some((part) => part.trim().split(/\s+/, 1)[0] === "default-src")) {
        parts.push(`script-src 'self' ${nonceToken}`);
      }
    }
  }
  if (csp.reportUri) parts.push(`report-uri ${csp.reportUri}`);
  return parts.join("; ");
}

function applyCsp(response: Response, csp: ContentSecurityPolicy | undefined): Response {
  if (!csp) return response;
  const value = typeof csp === "string" ? csp : serializeCsp(csp);
  const reportOnly = typeof csp === "object" && csp.reportOnly === true;
  response.headers.set(
    reportOnly ? "content-security-policy-report-only" : "content-security-policy",
    value,
  );
  return response;
}

/**
 * Protects routes and forwards verified auth state to the server helpers.
 *
 * ```ts
 * // middleware.ts
 * import { orbitIdMiddleware, createRouteMatcher } from '@orbitid/nextjs';
 *
 * const isProtectedRoute = createRouteMatcher(['/dashboard(.*)']);
 * const isAdminRoute = createRouteMatcher(['/admin(.*)']);
 *
 * export default orbitIdMiddleware(async (auth, req) => {
 *   if (isProtectedRoute(req)) await auth.protect();
 *   if (isAdminRoute(req)) await auth.protect({ permission: 'org:sys_memberships:manage' });
 * });
 *
 * export const config = { matcher: ['/((?!_next|.*\\.(?:svg|png|jpe?g|gif|ico|webp|woff2?|css|js|map|txt|xml)$).*)'] };
 * ```
 */
export function orbitIdMiddleware(options?: OrbitIdMiddlewareOptions): MiddlewareResult;
export function orbitIdMiddleware(handler: MiddlewareHandler, options?: OrbitIdMiddlewareOptions): MiddlewareResult;
export function orbitIdMiddleware(
  handlerOrOptions?: MiddlewareHandler | OrbitIdMiddlewareOptions,
  maybeOptions?: OrbitIdMiddlewareOptions,
): MiddlewareResult {
  const { handler, options } = normalizeArgs(handlerOrOptions, maybeOptions);

  return async (req: NextRequest): Promise<Response> => {
    const env = getServerEnv(options);
    const handshakeOptions = options.handshake ?? {};
    const handshakeEnabled = handshakeOptions.enabled !== false;

    // A return from the Frontend API handshake carries a token in the URL: verify it, write the SDK
    // cookies and redirect to the same URL without the parameter before anything else looks at auth.
    if (handshakeEnabled && req.method === "GET") {
      // The terminal 503 page's manual "Try again" link: clear the bounded-retry counter, then continue to the
      // clean URL, where the next navigation starts a fresh handshake with a full retry budget.
      const reset = resetHandshakeRetries(req, handshakeOptions);
      if (reset) return applyCsp(reset, options.contentSecurityPolicy);
      const completed = await completeHandshake(req, env, handshakeOptions);
      if (completed) return applyCsp(completed.response, options.contentSecurityPolicy);
    }

    // Internal auth headers are ours to set; anything the client sent is discarded.
    const incoming = new Headers(req.headers);
    for (const name of Object.values(AUTH_HEADERS)) incoming.delete(name);
    const state = await resolveRequestAuthState(incoming, req.url, env);

    if (options.debug) {
      // Never log the token or the claims: only method, path and the coarse status/reason.
      console.debug(
        `[orbitid] ${req.method} ${req.nextUrl?.pathname ?? new URL(req.url).pathname} → ${state.status}`,
        state.reason ?? "",
      );
    }

    // Expired/missing `__session` with a live `__client_uat` on a top-level navigation: one handshake
    // attempt is worth it. A caller with a Bearer token mints its own tokens, so it never gets one.
    // The marker cookie stops a browser from bouncing when the API keeps failing; with the marker
    // already set the visitor continues signed out instead of looping.
    let effectiveState = state;
    const cookieAuth = !incoming.get("authorization");
    if (handshakeEnabled && cookieAuth && state.status === "handshake") {
      if (isNavigationRequest(req)) {
        if (!hasHandshakeMarker(req)) {
          return applyCsp(redirectToHandshake(req, env, handshakeOptions), options.contentSecurityPolicy);
        }
        // The last attempt hit a transient API failure. Retry instead of treating a live visitor as signed out;
        // if the API is still down the return is another 503 page, never a sign-in redirect.
        if (hasHandshakeRetryMarker(req)) {
          return applyCsp(redirectToHandshake(req, env, handshakeOptions), options.contentSecurityPolicy);
        }
        // Marker already set after a completed attempt: keep the loop guard and treat this navigation as
        // signed-out for the handler, but never clear the credentials here.
        effectiveState = { ...state, status: "signed-out", token: null };
      } else if (hasHandshakeRetryMarker(req)) {
        // A fetch/API request while the API is known to be down gets an explicit 503, not a sign-in redirect.
        return applyCsp(handshakeUnavailableFor(req, req.url), options.contentSecurityPolicy);
      }
    }

    if (!handler) {
      return applyCsp(forwardWithAuthHeaders(req, effectiveState), options.contentSecurityPolicy);
    }

    const auth = createMiddlewareAuthObject(effectiveState, req, env);
    try {
      const result = await handler(auth, req);
      const response = result ?? forwardWithAuthHeaders(req, effectiveState);
      return applyCsp(response, options.contentSecurityPolicy);
    } catch (error) {
      if (error instanceof MiddlewareResponseError) {
        return applyCsp(error.response, options.contentSecurityPolicy);
      }
      throw error;
    }
  };
}
