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

export interface ContentSecurityPolicyOptions {
  directives?: Record<string, string[]> | string[];
  reportOnly?: boolean;
  reportUri?: string;
  nonce?: string;
}

export type ContentSecurityPolicy = string | ContentSecurityPolicyOptions;

export interface OrbitIdMiddlewareOptions extends ServerEnvOverrides {
  /** Accepted for parity with `clerkMiddleware`; consumed by `orbitIdClient()` in server helpers. */
  secretKey?: string;
  debug?: boolean;
  contentSecurityPolicy?: ContentSecurityPolicy;
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

  const auth: MiddlewareAuthObject = {
    userId: claims?.sub ?? null,
    sessionId: claims?.sid ?? null,
    orgId: claims?.org_id ?? null,
    orgRole: claims?.org_role ?? null,
    orgSlug: claims?.org_slug ?? null,
    orgPermissions: claims?.org_permissions ?? null,
    actor: claims?.act ?? null,
    sessionClaims: claims,
    sessionStatus,
    isAuthenticated: state.status === "signed-in" && claims !== null,
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
  if (csp.reportUri) parts.push(`report-uri ${csp.reportUri}`);
  if (csp.nonce) {
    for (let i = 0; i < parts.length; i += 1) {
      parts[i] = parts[i]!.replace(/'nonce-[^']*'/g, `'nonce-${csp.nonce}'`);
    }
  }
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
 * Drop-in equivalent of `clerkMiddleware`.
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
 * export const config = { matcher: ['/((?!_next|.*\\..*).*)'] };
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
    // Internal auth headers are ours to set; anything the client sent is discarded.
    const incoming = new Headers(req.headers);
    for (const name of Object.values(AUTH_HEADERS)) incoming.delete(name);
    const state = await resolveRequestAuthState(incoming, req.url, env);

    if (options.debug) {
      console.debug(`[orbitid] ${req.method} ${req.nextUrl?.pathname ?? req.url} → ${state.status}`, state.reason ?? "");
    }

    if (!handler) {
      return applyCsp(forwardWithAuthHeaders(req, state), options.contentSecurityPolicy);
    }

    const auth = createMiddlewareAuthObject(state, req, env);
    try {
      const result = await handler(auth, req);
      const response = result ?? forwardWithAuthHeaders(req, state);
      return applyCsp(response, options.contentSecurityPolicy);
    } catch (error) {
      if (error instanceof MiddlewareResponseError) {
        return applyCsp(error.response, options.contentSecurityPolicy);
      }
      throw error;
    }
  };
}
