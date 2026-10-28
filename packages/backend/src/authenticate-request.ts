import { COOKIES, decodePublishableKey, type AuthObject } from "@orbitid/shared";
import { buildAuthObject } from "./auth-object";
import { isTokenVerificationError, verifyToken, type VerifyTokenOptions } from "./verify-token";

export type AuthenticateRequestStatus = "signed-in" | "signed-out" | "handshake";

export type AuthenticateRequestReason =
  | "no-session-token"
  | "client-uat-zero"
  | "session-token-missing-refresh-needed"
  | "session-token-expired"
  | "session-token-expired-refresh-needed"
  | "session-token-invalid";

export interface AuthenticateRequestOptions extends VerifyTokenOptions {
  publishableKey?: string;
  signInUrl?: string;
  returnBackUrl?: string;
  fetch?: (input: string, init?: RequestInit) => Promise<Response>;
}

export interface RequestState {
  status: AuthenticateRequestStatus;
  token: string | null;
  reason: AuthenticateRequestReason | null;
  headers: Record<string, string>;
  /**
   * Absolute URL to send the browser to when a handshake can turn the live client cookie into a fresh
   * `__session` token. `null` when a handshake cannot help (signed in, signed out for real, or no
   * Frontend API URL to build it from). See docs/HANDSHAKE.md.
   */
  handshakeUrl: string | null;
  toAuth(): AuthObject;
}

export function parseCookie(header: string | null, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator) !== name) continue;
    const raw = part.slice(separator + 1);
    try {
      return decodeURIComponent(raw);
    } catch {
      return raw;
    }
  }
  return null;
}

function noStoreHeaders(): Record<string, string> {
  return { "Cache-Control": "private, no-store" };
}

/** Frontend API base URL: explicit `apiUrl` first, then the URL encoded in the publishable key. */
function frontendApiUrl(options: AuthenticateRequestOptions): string | null {
  if (options.apiUrl) return options.apiUrl.replace(/\/+$/, "");
  if (!options.publishableKey) return null;
  try {
    return decodePublishableKey(options.publishableKey).frontendApi.replace(/\/+$/, "");
  } catch {
    return null;
  }
}

function buildHandshakeUrl(request: Request, options: AuthenticateRequestOptions): string | null {
  const apiUrl = frontendApiUrl(options);
  if (!apiUrl) return null;
  const returnUrl = options.returnBackUrl ?? request.url;
  if (!returnUrl) return null;
  return `${apiUrl}/v1/client/handshake?redirect_url=${encodeURIComponent(returnUrl)}`;
}

/**
 * Authenticates an incoming request from the `Authorization: Bearer` header or the `__session` cookie.
 * `__client_uat` short-circuits signed-out visitors and marks a session whose token can be refreshed.
 *
 * When the session token is missing, expired or invalid but the browser still holds a live client
 * (`__client_uat` > 0), the state carries a `handshakeUrl`: redirecting the browser there lets the
 * server mint a fresh `__session` cookie for a hard navigation. Without it (or on a client-side
 * visit, where the browser SDK refreshes the token itself) the request reads as signed out.
 */
export async function authenticateRequest(request: Request, options: AuthenticateRequestOptions = {}): Promise<RequestState> {
  const cookieHeader = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : null;
  const token = bearer || parseCookie(cookieHeader, COOKIES.session);
  const clientUat = parseCookie(cookieHeader, COOKIES.clientUat);
  const clientIsLive = clientUat !== null && clientUat !== "0" && clientUat !== "";

  const signInOptions = { signInUrl: options.signInUrl, returnBackUrl: options.returnBackUrl };

  const signedOut = (reason: AuthenticateRequestReason, handshakeUrl: string | null = null): RequestState => ({
    status: "signed-out",
    token: null,
    reason,
    headers: noStoreHeaders(),
    handshakeUrl,
    toAuth: () => buildAuthObject(null, async () => null, signInOptions),
  });

  // A caller that presented a Bearer token can mint another one; only a browser cookie gets a handshake.
  const handshakeUrl = (): string | null => (clientIsLive && !bearer ? buildHandshakeUrl(request, options) : null);

  if (clientUat === "0") return signedOut("client-uat-zero");
  if (!token) {
    if (!clientIsLive) return signedOut("no-session-token");
    return signedOut("session-token-missing-refresh-needed", handshakeUrl());
  }

  let currentSessionId: string | null = null;

  const getToken: AuthObject["getToken"] = async (tokenOptions) => {
    if (!options.secretKey || !options.apiUrl) return null;
    if (!currentSessionId) return null;
    const path = `/v1/sessions/${currentSessionId}/tokens${tokenOptions?.template ? `/${encodeURIComponent(tokenOptions.template)}` : ""}`;
    const doFetch = options.fetch ?? fetch;
    const response = await doFetch(`${options.apiUrl.replace(/\/+$/, "")}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${options.secretKey}`, Accept: "application/json" },
    });
    if (!response.ok) return null;
    const body = (await response.json()) as { jwt?: string } | null;
    return body?.jwt ?? null;
  };

  try {
    const claims = await verifyToken(token, options);
    currentSessionId = claims.sid;
    return {
      status: "signed-in",
      token,
      reason: null,
      headers: noStoreHeaders(),
      handshakeUrl: null,
      toAuth: () => buildAuthObject(claims, getToken, signInOptions),
    };
  } catch (error) {
    if (!isTokenVerificationError(error)) throw error;
    // Configuration problems (unreachable JWKS, unknown key) are not fixed by a handshake.
    const infrastructureFailure =
      error.reason === "jwks-fetch-failed" || error.reason === "no-matching-key" || error.reason === "unexpected";
    const url = infrastructureFailure ? null : handshakeUrl();
    if (error.reason !== "token-expired") return signedOut("session-token-invalid", url);
    if (!clientIsLive) return signedOut("session-token-expired");
    return url ? signedOut("session-token-expired", url) : signedOut("session-token-expired-refresh-needed");
  }
}
