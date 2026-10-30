import {
  createRemoteJWKSet,
  decodeJwt,
  importPKCS8,
  importSPKI,
  importX509,
  jwtVerify,
  type JWTVerifyGetKey,
  type KeyLike,
} from "jose";
import type { SessionClaims } from "@orbitid/shared";
import { stripTrailingSlash } from "./env";

/**
 * Offline verification of OrbitID session JWTs (`__session`).
 *
 * Mirrors what `@orbitid/backend#verifyToken` does, kept local (jose only) so the Next.js
 * middleware stays edge-compatible and does not import the Node-flavoured backend SDK.
 */

export type JwtKey = string | Uint8Array | KeyLike;

export interface VerifySessionTokenOptions {
  /** PEM (SPKI/certificate) public key, raw HMAC secret as bytes, or an imported jose key. */
  jwtKey?: JwtKey;
  /** Explicit JWKS endpoint; takes precedence over `apiUrl`. */
  jwksUrl?: string;
  /** Frontend API URL; `${apiUrl}/.well-known/jwks.json` is used when no `jwtKey` is given. */
  apiUrl?: string;
  /** Required `iss` claim: the server's public URL. Tokens from any other issuer are refused. */
  issuer?: string;
  /** Values accepted in the `azp` claim (app origins). */
  authorizedParties?: string[];
  audience?: string;
  clockSkewInMs?: number;
}

export type SessionVerificationFailureReason =
  | "no-token"
  | "no-key"
  | "expired"
  | "invalid"
  | "unauthorized-party";

export type SessionVerification =
  | { valid: true; claims: SessionClaims; token: string }
  | { valid: false; reason: SessionVerificationFailureReason; message?: string; claims?: SessionClaims | null };

const keyCache = new Map<string, Promise<KeyLike | Uint8Array>>();
const jwksCache = new Map<string, JWTVerifyGetKey>();

function isPem(value: string): boolean {
  return value.includes("-----BEGIN ");
}

/**
 * Instance session tokens are RS256 and machine/OIDC tokens share the key but carry an audience. Only the
 * asymmetric set is ever accepted for a PEM `jwtKey`, so a public key can never be replayed as an HMAC secret
 * ("algorithm confusion"). HMAC is opt-in, explicitly:
 *
 * - `hs256:<secret>` — a shared secret given as a string (the only way to supply it through an env var);
 * - a `Uint8Array` — the same thing as bytes.
 *
 * A bare string is refused: it is almost always a public key pasted without its PEM header, and treating it as
 * an HMAC secret would let anyone holding that public key mint accepted tokens.
 */
const ASYMMETRIC_ALGORITHMS = ["RS256", "ES256", "PS256"] as const;
const HMAC_PREFIX = "hs256:";

async function importJwtKey(jwtKey: JwtKey): Promise<{ key: KeyLike | Uint8Array; algorithms: string[] }> {
  if (typeof jwtKey === "string") {
    if (jwtKey.startsWith(HMAC_PREFIX)) {
      const secret = jwtKey.slice(HMAC_PREFIX.length);
      if (secret.length < 16) {
        throw new Error("@orbitid/nextjs: an HMAC `jwtKey` secret must be at least 16 characters");
      }
      return { key: new TextEncoder().encode(secret), algorithms: ["HS256"] };
    }
    if (!isPem(jwtKey)) {
      throw new Error(
        "@orbitid/nextjs: `jwtKey` must be a PEM public key. For an HMAC (HS256) secret, prefix it with `hs256:` or pass a Uint8Array.",
      );
    }
    const cached = keyCache.get(jwtKey);
    if (cached) return { key: await cached, algorithms: [...ASYMMETRIC_ALGORITHMS] };
    const imported = (async () => {
      const body = jwtKey.trim();
      if (body.includes("PUBLIC KEY")) return importSPKI(body, "RS256");
      // An X.509 certificate is not a bare SPKI block: `importSPKI` would reject it, so it needs `importX509`.
      if (body.includes("CERTIFICATE")) return importX509(body, "RS256");
      // A private key also carries the public half; verifying with it is fine and never leaves this process.
      if (body.includes("PRIVATE KEY")) return importPKCS8(body, "RS256");
      throw new Error("@orbitid/nextjs: unsupported PEM key type for `jwtKey`");
    })();
    keyCache.set(jwtKey, imported);
    return { key: await imported, algorithms: [...ASYMMETRIC_ALGORITHMS] };
  }
  if (jwtKey instanceof Uint8Array) return { key: jwtKey, algorithms: ["HS256"] };
  return { key: jwtKey as KeyLike, algorithms: [...ASYMMETRIC_ALGORITHMS] };
}

function jwksFor(url: string): JWTVerifyGetKey {
  const normalized = stripTrailingSlash(url);
  const cached = jwksCache.get(normalized);
  if (cached) return cached;
  const jwks = createRemoteJWKSet(new URL(normalized));
  jwksCache.set(normalized, jwks);
  return jwks;
}

function isExpiredError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  if ("code" in error && error.code === "ERR_JWT_EXPIRED") return true;
  return error instanceof Error && error.name === "JWTExpired";
}

function normalizeParty(value: string): string {
  return stripTrailingSlash(value.trim()).toLowerCase();
}

function partyMatches(azp: string | undefined, authorizedParties: string[] | undefined): boolean {
  if (!authorizedParties || authorizedParties.length === 0) return true;
  if (!azp) return false;
  const normalized = normalizeParty(azp);
  return authorizedParties.some((party) => normalizeParty(party) === normalized);
}

/** Decode claims without verifying the signature. Only safe for headers set by our middleware. */
export function decodeSessionClaims(token: string): SessionClaims | null {
  try {
    return decodeJwt(token) as unknown as SessionClaims;
  } catch {
    return null;
  }
}

export async function verifySessionToken(
  token: string | null | undefined,
  options: VerifySessionTokenOptions = {},
): Promise<SessionVerification> {
  if (!token) return { valid: false, reason: "no-token" };

  let key: KeyLike | Uint8Array | null = null;
  let getKey: JWTVerifyGetKey | null = null;
  let algorithms: string[];
  if (options.jwtKey) {
    try {
      const imported = await importJwtKey(options.jwtKey);
      key = imported.key;
      algorithms = imported.algorithms;
    } catch (error) {
      return {
        valid: false,
        reason: "no-key",
        message: error instanceof Error ? error.message : String(error),
      };
    }
  } else {
    const jwksUrl = options.jwksUrl ?? (options.apiUrl ? `${stripTrailingSlash(options.apiUrl)}/.well-known/jwks.json` : undefined);
    if (!jwksUrl) return { valid: false, reason: "no-key", message: "Provide `jwtKey`, `jwksUrl` or `apiUrl` to verify session tokens" };
    getKey = jwksFor(jwksUrl);
    algorithms = [...ASYMMETRIC_ALGORITHMS];
  }

  const verifyOptions = {
    algorithms,
    issuer: options.issuer ? stripTrailingSlash(options.issuer) : undefined,
    audience: options.audience,
    clockTolerance: options.clockSkewInMs !== undefined ? options.clockSkewInMs / 1000 : undefined,
  };

  try {
    const { payload } = getKey
      ? await jwtVerify(token, getKey, verifyOptions)
      : await jwtVerify(token, key!, verifyOptions);
    const claims = payload as unknown as SessionClaims;
    if (payload.aud !== undefined && options.audience === undefined) {
      return { valid: false, reason: "invalid", message: "Token is not a session token" };
    }
    // Same shape check as the server and the Node SDK: a token without a subject and a session is not a session,
    // however valid its signature. Without it a machine token or an ID token could be treated as a session.
    if (typeof payload.sub !== "string" || typeof payload.sid !== "string" || !payload.sub || !payload.sid) {
      return { valid: false, reason: "invalid", message: "Token is missing the sub/sid claims", claims };
    }
    if (!partyMatches(claims.azp, options.authorizedParties)) {
      return { valid: false, reason: "unauthorized-party", claims };
    }
    return { valid: true, claims, token };
  } catch (error) {
    if (isExpiredError(error)) {
      // Decoded, unverified claims are only useful for diagnostics: callers get `valid: false` and no
      // authorization from them (see `resolveRequestAuthState`).
      return { valid: false, reason: "expired", message: "Session token has expired" };
    }
    return {
      valid: false,
      reason: "invalid",
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

export function tokenFromAuthorizationHeader(headers: Headers): string | null {
  const header = headers.get("authorization");
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

/** Parse a raw `Cookie` header without relying on a framework. */
export function readCookieValue(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const index = part.indexOf("=");
    if (index === -1) continue;
    if (part.slice(0, index).trim() === name) {
      const value = part.slice(index + 1).trim();
      try {
        return decodeURIComponent(value);
      } catch {
        return value;
      }
    }
  }
  return null;
}

export type SessionTokenSource = "header" | "cookie" | null;

/**
 * Session token precedence used everywhere: `Authorization: Bearer` first, then the `__session`
 * cookie. Mirrors the contract in docs/ARCHITECTURE.md.
 */
export function getSessionToken(
  headers: Headers,
  cookieName = "__session",
): { token: string | null; source: SessionTokenSource } {
  const bearer = tokenFromAuthorizationHeader(headers);
  if (bearer) return { token: bearer, source: "header" };
  const cookie = readCookieValue(headers.get("cookie"), cookieName);
  if (cookie) return { token: cookie, source: "cookie" };
  return { token: null, source: null };
}
