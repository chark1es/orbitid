export interface DecodedJwtPayload {
  iat?: number;
  nbf?: number;
  exp?: number;
  iss?: string;
  sub?: string;
  sid?: string;
  org_id?: string;
  [key: string]: unknown;
}

function base64UrlDecode(input: string): string | null {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  if (typeof atob !== "function") return null;
  let binary: string;
  try {
    binary = atob(padded);
  } catch {
    return null;
  }
  // JWT payloads are UTF-8, but `atob` yields one character per *byte*. Decode the bytes so a
  // non-ASCII claim (a name, custom metadata) does not arrive as mojibake and break comparisons.
  if (typeof TextDecoder === "function") {
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return new TextDecoder().decode(bytes);
  }
  return binary;
}

/** Decodes (without verifying) a JWT payload. Returns null for malformed tokens. */
export function decodeJwtPayload(token: string): DecodedJwtPayload | null {
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return null;
  const json = base64UrlDecode(parts[1]);
  if (!json) return null;
  try {
    const parsed: unknown = JSON.parse(json);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return parsed as DecodedJwtPayload;
  } catch {
    return null;
  }
}

/**
 * Absolute expiry of a token on the *local* clock. `iat` is the server's issue time, so the delta between it and
 * the local clock compensates for client/server clock skew. Call this when the token is received (`now ≈ iat`).
 */
export function tokenExpiresAt(token: string, now: number): number | null {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return null;
  const skew = typeof payload.iat === "number" ? now - payload.iat * 1000 : 0;
  return payload.exp * 1000 + skew;
}

export function isTokenExpired(token: string, now: number, leewayMs = 0): boolean {
  const payload = decodeJwtPayload(token);
  if (!payload?.exp) return true;
  return payload.exp * 1000 - leewayMs <= now;
}
