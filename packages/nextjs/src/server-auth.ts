import { headers as nextHeaders } from "next/headers";
import { redirect } from "next/navigation";
import {
  AUTH_HEADERS,
  createAuthObject,
  type AuthObject,
  type InitialAuthState,
  type RequestAuthState,
} from "./auth-state";
import { buildAuthUrl, getServerEnv, type ResolvedServerEnv } from "./env";
import { resolveRequestAuthState } from "./resolve";
import { orbitIdClient } from "./backend-client";

function requestUrl(headers: Headers): string {
  const forwarded = headers.get(AUTH_HEADERS.url);
  if (forwarded) return forwarded;
  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost";
  const proto = headers.get("x-forwarded-proto") ?? "http";
  const pathname = headers.get("x-orbitid-pathname") ?? "/";
  return `${proto}://${host}${pathname}`;
}

export interface AuthRequestLike {
  headers: Headers | Record<string, string | string[] | undefined>;
  url?: string;
}

export type GetAuthInput = AuthRequestLike | { req: AuthRequestLike };

function normalizeHeaders(input: AuthRequestLike): Headers {
  if (input.headers instanceof Headers) return input.headers;
  const headers = new Headers();
  for (const [key, value] of Object.entries(input.headers)) {
    if (value === undefined) continue;
    headers.set(key, Array.isArray(value) ? value.join(", ") : value);
  }
  return headers;
}

/**
 * Server-side auth for the App Router (RSC, route handlers, server actions).
 * Returns a signed-out AuthObject when the middleware forwarded no auth state.
 */
function buildAuthObject(state: RequestAuthState, env: ResolvedServerEnv): AuthObject {
  return createAuthObject({
    claims: state.claims,
    token: state.token,
    status: state.status,
    reason: state.reason,
    message: state.message,
    url: state.url,
    env,
    // Custom JWT templates are minted by the Backend API; the default token is already in hand.
    getTokenOverride: async (opts) => {
      if (!opts?.template) return state.token;
      const sessionId = state.claims?.sid;
      if (!sessionId || !state.token) return null;
      const { jwt } = await orbitIdClient().sessions.getToken(sessionId, { template: opts.template, sessionToken: state.token });
      return jwt;
    },
  });
}

export async function authWithState(): Promise<{ auth: AuthObject; state: RequestAuthState }> {
  const env = getServerEnv();
  const rawHeaders = await nextHeaders();
  const headers = new Headers(rawHeaders);
  const state = await resolveRequestAuthState(headers, requestUrl(headers), env);
  return { auth: buildAuthObject(state, env), state };
}

/** Async `auth()`: claims, `has()` and `protect()`. */
export async function auth(): Promise<AuthObject> {
  return (await authWithState()).auth;
}

/**
 * Pages Router / route-handler helper. Prefers auth state forwarded by middleware, otherwise
 * verifies the request's bearer token or `__session` cookie itself.
 */
export async function getAuth(input: GetAuthInput): Promise<AuthObject> {
  const request = "req" in input ? input.req : input;
  const headers = normalizeHeaders(request);
  const host = request.url
    ? new URL(request.url, `${headers.get("x-forwarded-proto") ?? "http"}://${headers.get("host") ?? "localhost"}`).toString()
    : requestUrl(headers);
  const env = getServerEnv();
  const state = await resolveRequestAuthState(headers, host, env);
  return buildAuthObject(state, env);
}

/** Server-component snapshot passed to the client provider for hydration. */
export async function initialAuthState(): Promise<InitialAuthState> {
  const { auth: session, state } = await authWithState();
  return {
    status: state.status,
    userId: session.userId,
    sessionId: session.sessionId,
    orgId: session.orgId,
    orgRole: session.orgRole,
    orgSlug: session.orgSlug,
    orgPermissions: session.orgPermissions,
    sessionClaims: session.sessionClaims,
    reason: state.reason,
  };
}

/** Redirect to the configured sign-in page, preserving `redirect_url`. */
export function redirectToSignIn(opts: { returnBackUrl?: string } = {}): never {
  const env = getServerEnv();
  redirect(buildAuthUrl(env.signInUrl, opts.returnBackUrl ?? null));
}

/** Redirect to the configured sign-up page, preserving `redirect_url`. */
export function redirectToSignUp(opts: { returnBackUrl?: string } = {}): never {
  const env = getServerEnv();
  redirect(buildAuthUrl(env.signUpUrl, opts.returnBackUrl ?? null));
}

export type { AuthObject, AuthStatus, InitialAuthState, ProtectParams } from "./auth-state";
