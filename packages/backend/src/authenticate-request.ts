import { COOKIES, type AuthObject } from "@orbitid/shared";
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

/**
 * Authenticates an incoming request from the `Authorization: Bearer` header or the `__session` cookie.
 * `__client_uat` short-circuits signed-out visitors and marks a refreshable (expired-token) session.
 *
 * OrbitID does not implement Clerk's handshake: an expired token with a live client (`__client_uat` > 0)
 * returns `signed-out` with reason `session-token-expired-refresh-needed`, and the browser SDK refreshes
 * the token on its next visit.
 */
export async function authenticateRequest(request: Request, options: AuthenticateRequestOptions = {}): Promise<RequestState> {
  const cookieHeader = request.headers.get("cookie");
  const authorization = request.headers.get("authorization");
  const bearer = authorization?.toLowerCase().startsWith("bearer ") ? authorization.slice(7).trim() : null;
  const token = bearer || parseCookie(cookieHeader, COOKIES.session);
  const clientUat = parseCookie(cookieHeader, COOKIES.clientUat);
  const clientIsLive = clientUat !== null && clientUat !== "0" && clientUat !== "";

  const signInOptions = { signInUrl: options.signInUrl, returnBackUrl: options.returnBackUrl };

  const signedOut = (reason: AuthenticateRequestReason): RequestState => ({
    status: "signed-out",
    token: null,
    reason,
    headers: noStoreHeaders(),
    toAuth: () => buildAuthObject(null, async () => null, signInOptions),
  });

  if (clientUat === "0") return signedOut("client-uat-zero");
  if (!token) return signedOut(clientIsLive ? "session-token-missing-refresh-needed" : "no-session-token");

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
      toAuth: () => buildAuthObject(claims, getToken, signInOptions),
    };
  } catch (error) {
    if (!isTokenVerificationError(error)) throw error;
    if (error.reason === "token-expired") {
      return signedOut(clientIsLive ? "session-token-expired-refresh-needed" : "session-token-expired");
    }
    return signedOut("session-token-invalid");
  }
}
