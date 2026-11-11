import { COOKIES } from "@orbitid/shared";
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
    // Only a `signed-in` state carries a token, and it is verified like any other. A forwarded `signed-in`
    // without one is a contradiction (and would be attacker-supplied on a route the middleware does not
    // cover): it is reported as signed out rather than as an authenticated request with no session.
    if (forwarded.status !== "signed-in" || !forwarded.token) {
      if (forwarded.status === "signed-in") return signedOut(url, "no-token");
      return { ...forwarded, url };
    }
    // The header may have been set by the client on a path the middleware does not cover, so the
    // forwarded token is verified like any other.
    const verified = await verifySessionToken(forwarded.token, {
      jwtKey: env.jwtKey,
      jwksUrl: env.jwksUrl,
      apiUrl: env.apiUrl,
      issuer: env.issuer,
      authorizedParties: env.authorizedParties,
      clockSkewInMs: env.clockSkewInMs,
      expClockSkewInMs: env.expClockSkewInMs,
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
    issuer: env.issuer,
    authorizedParties: env.authorizedParties,
    clockSkewInMs: env.clockSkewInMs,
    expClockSkewInMs: env.expClockSkewInMs,
  });

  if (result.valid) {
    return { status: "signed-in", token: result.token, claims: result.claims, url };
  }
  // A dead token next to a live client is exactly what the handshake exists for: ask the Frontend API
  // for a fresh one instead of sending a signed-in visitor to the sign-in page. An expired token and one
  // signed by a key this process cannot verify (a rotation that has not reached its JWKS cache) both
  // qualify; the handshake re-mints from the authoritative session. A token that failed its signature,
  // issuer or party check was tampered with, and a handshake there would let client-writable cookies
  // trigger a fresh credential. It stays signed out.
  if ((result.reason === "expired" || result.reason === "unverifiable-key") && uatActive) {
    return handshake(url, result.reason === "expired" ? AUTH_REASONS.expiredToken : AUTH_REASONS.unverifiableKey);
  }
  // Never forward claims from a token that did not verify: they are attacker-controlled text and callers
  // that read `sessionClaims` would otherwise see a `sub`/`org_role` the signature never backed.
  return signedOut(url, result.reason, result.message);
}

function handshake(url: string, reason: string): RequestAuthState {
  return { status: "handshake", token: null, claims: null, reason, url };
}

function signedOut(
  url: string,
  reason: "no-token" | "expired" | "invalid" | "unverifiable-key" | "no-key" | "unauthorized-party",
  message?: string,
): RequestAuthState {
  const mapped =
    reason === "no-token"
      ? AUTH_REASONS.noSession
      : reason === "expired"
        ? AUTH_REASONS.expiredToken
        : reason === "unverifiable-key"
          ? AUTH_REASONS.unverifiableKey
          : reason === "no-key"
            ? AUTH_REASONS.missingKey
            : reason === "unauthorized-party"
              ? AUTH_REASONS.unauthorizedParty
              : AUTH_REASONS.invalidToken;
  // Signed out means no token and no claims. A caller reading `sessionId`/`sessionClaims` must not see
  // values copied out of an unverified JWT.
  return { status: "signed-out", token: null, claims: null, reason: mapped, message, url };
}
