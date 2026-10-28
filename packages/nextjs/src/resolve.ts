import { COOKIES, type SessionClaims } from "@orbitid/shared";
import {
  AUTH_REASONS,
  authStateFromHeaders,
  type RequestAuthState,
} from "./auth-state";
import type { ResolvedServerEnv } from "./env";
import {
  getSessionToken,
  readCookieValue,
  verifySessionToken,
} from "./token";

/**
 * Resolve signed-in/signed-out/handshake state from raw request headers.
 *
 * Set by `orbitIdMiddleware` or recomputed from the `Authorization`/`__session` token when the app
 * calls `auth()` without middleware. A forwarded `signed-in` state is only honoured after its token
 * has been cryptographically verified.
 */
export async function resolveRequestAuthState(
  headers: Headers,
  url: string,
  env: ResolvedServerEnv,
): Promise<RequestAuthState> {
  const forwarded = authStateFromHeaders(headers);

  if (forwarded) {
    if (forwarded.status !== "signed-in" || !forwarded.token) {
      return { ...forwarded, url };
    }
    // The header may have been set by the client on a path the middleware does not cover, so the
    // forwarded token is verified like any other.
    const verified = await verifySessionToken(forwarded.token, {
      jwtKey: env.jwtKey,
      jwksUrl: env.jwksUrl,
      apiUrl: env.apiUrl,
      authorizedParties: env.authorizedParties,
      clockSkewInMs: env.clockSkewInMs,
    });
    if (!verified.valid) return signedOut(url, verified.reason, verified.message);
    return { status: "signed-in", token: forwarded.token, claims: verified.claims, url };
  }

  const { token } = getSessionToken(headers, COOKIES.session);
  const clientUat = readCookieValue(headers.get("cookie"), COOKIES.clientUat);
  const uatActive = clientUat !== null && Number(clientUat) > 0;

  if (!token) {
    return uatActive
      ? handshake(url, AUTH_REASONS.noToken)
      : signedOut(url, "no-token");
  }

  const result = await verifySessionToken(token, {
    jwtKey: env.jwtKey,
    jwksUrl: env.jwksUrl,
    apiUrl: env.apiUrl,
    authorizedParties: env.authorizedParties,
    clockSkewInMs: env.clockSkewInMs,
  });

  if (result.valid) {
    return { status: "signed-in", token: result.token, claims: result.claims, url };
  }
  // A dead token next to a live client is exactly what the handshake exists for: ask the Frontend API
  // for a fresh one instead of sending a signed-in visitor to the sign-in page.
  if ((result.reason === "expired" || result.reason === "invalid") && uatActive) {
    return handshake(url, result.reason === "expired" ? AUTH_REASONS.expiredToken : AUTH_REASONS.invalidToken);
  }
  return signedOut(url, result.reason, result.message, result.claims ?? null);
}

function handshake(url: string, reason: string): RequestAuthState {
  return { status: "handshake", token: null, claims: null, reason, url };
}

function signedOut(
  url: string,
  reason: "no-token" | "expired" | "invalid" | "no-key" | "unauthorized-party",
  message?: string,
  claims: SessionClaims | null = null,
): RequestAuthState {
  const mapped =
    reason === "no-token"
      ? AUTH_REASONS.noSession
      : reason === "expired"
        ? AUTH_REASONS.expiredToken
        : reason === "no-key"
          ? AUTH_REASONS.missingKey
          : reason === "unauthorized-party"
            ? AUTH_REASONS.unauthorizedParty
            : AUTH_REASONS.invalidToken;
  return { status: "signed-out", token: null, claims, reason: mapped, message, url };
}
