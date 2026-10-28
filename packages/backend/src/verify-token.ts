import { createRemoteJWKSet, decodeProtectedHeader, errors, importSPKI, jwtVerify, type JWTVerifyGetKey, type KeyLike } from "jose";
import type { SessionClaims } from "@orbitid/shared";

export type TokenVerificationErrorReason =
  | "token-missing"
  | "token-invalid"
  | "token-expired"
  | "token-not-active-yet"
  | "invalid-signature"
  | "invalid-issuer"
  | "invalid-audience"
  | "invalid-authorized-party"
  | "jwks-fetch-failed"
  | "no-matching-key"
  | "unexpected";

export class TokenVerificationError extends Error {
  constructor(
    public readonly reason: TokenVerificationErrorReason,
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "TokenVerificationError";
  }
}

export function isTokenVerificationError(error: unknown): error is TokenVerificationError {
  return error instanceof TokenVerificationError || (!!error && typeof error === "object" && (error as { name?: string }).name === "TokenVerificationError");
}

export interface VerifyTokenOptions {
  /** JWKS endpoint; defaults to `${apiUrl}/.well-known/jwks.json` when `apiUrl` is provided. */
  jwksUrl?: string;
  /** PEM-encoded public key (SPKI). Enables networkless verification. */
  jwtKey?: string;
  secretKey?: string;
  apiUrl?: string;
  authorizedParties?: string[];
  audience?: string | string[];
  clockSkewInMs?: number;
  issuer?: string;
}

const jwksCache = new Map<string, JWTVerifyGetKey>();
const keyCache = new Map<string, KeyLike | Uint8Array>();

function resolveJwksUrl(options: VerifyTokenOptions): URL {
  if (options.jwksUrl) return new URL(options.jwksUrl);
  if (options.apiUrl) return new URL(`${options.apiUrl.replace(/\/+$/, "")}/.well-known/jwks.json`);
  throw new TokenVerificationError("token-invalid", "verifyToken requires either jwksUrl, jwtKey or apiUrl");
}

function getRemoteKeySet(url: URL): JWTVerifyGetKey {
  const cacheKey = url.toString();
  const cached = jwksCache.get(cacheKey);
  if (cached) return cached;
  const keySet = createRemoteJWKSet(url, { cooldownDuration: 30_000, cacheMaxAge: 600_000 });
  jwksCache.set(cacheKey, keySet);
  return keySet;
}

async function importPublicKey(pem: string, alg: string): Promise<KeyLike | Uint8Array> {
  const cacheKey = `${alg}:${pem}`;
  const cached = keyCache.get(cacheKey);
  if (cached) return cached;
  const key = await importSPKI(pem, alg);
  keyCache.set(cacheKey, key);
  return key;
}

function mapJoseError(error: unknown): TokenVerificationError {
  if (error instanceof TokenVerificationError) return error;
  if (error instanceof errors.JWTExpired) return new TokenVerificationError("token-expired", "Session token has expired", error);
  if (error instanceof errors.JWTClaimValidationFailed) {
    const claim = error.claim;
    if (claim === "nbf") return new TokenVerificationError("token-not-active-yet", "Session token is not active yet", error);
    if (claim === "iss") return new TokenVerificationError("invalid-issuer", "Session token issuer is invalid", error);
    if (claim === "aud") return new TokenVerificationError("invalid-audience", "Session token audience is invalid", error);
    return new TokenVerificationError("token-invalid", `Session token claim "${claim}" is invalid`, error);
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) return new TokenVerificationError("invalid-signature", "Session token signature is invalid", error);
  if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
    return new TokenVerificationError("no-matching-key", "No matching key found in the JWKS", error);
  }
  if (error instanceof errors.JWKSTimeout) return new TokenVerificationError("jwks-fetch-failed", "Timed out fetching the JWKS", error);
  return new TokenVerificationError("unexpected", error instanceof Error ? error.message : "Token verification failed", error);
}

/**
 * Verifies a session JWT offline against the instance JWKS (cached, 30 s cooldown) or a PEM public key,
 * checking `exp`, `nbf`, `iss`, `aud` and `azp`.
 */
export async function verifyToken(token: string, options: VerifyTokenOptions = {}): Promise<SessionClaims> {
  if (!token) throw new TokenVerificationError("token-missing", "No session token provided");

  let remoteKeySet: JWTVerifyGetKey | null = null;
  let publicKey: KeyLike | Uint8Array | null = null;
  let algorithm: string | undefined;
  if (options.jwtKey) {
    try {
      algorithm = decodeProtectedHeader(token).alg;
    } catch (error) {
      throw new TokenVerificationError("token-invalid", "Session token is malformed", error);
    }
    if (!algorithm) throw new TokenVerificationError("token-invalid", "Session token has no signing algorithm");
    publicKey = await importPublicKey(options.jwtKey, algorithm);
  } else {
    remoteKeySet = getRemoteKeySet(resolveJwksUrl(options));
  }

  const issuer = options.issuer ?? options.apiUrl;
  let payload: Record<string, unknown>;
  try {
    const verifyOptions = {
      issuer,
      audience: options.audience,
      clockTolerance: (options.clockSkewInMs ?? 0) / 1000,
    };
    const result = publicKey
      ? await jwtVerify(token, publicKey, { ...verifyOptions, algorithms: algorithm ? [algorithm] : undefined })
      : await jwtVerify(token, remoteKeySet!, { ...verifyOptions, algorithms: ["RS256", "ES256", "EdDSA"] });
    payload = result.payload;
  } catch (error) {
    throw mapJoseError(error);
  }

  if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
    throw new TokenVerificationError("token-invalid", "Session token is missing the sub/sid claims");
  }
  // Machine and OIDC tokens share the signing key but carry an audience; session tokens do not.
  if (payload.aud !== undefined && options.audience === undefined) {
    throw new TokenVerificationError("token-invalid", "Token is not a session token");
  }

  if (options.authorizedParties) {
    const azp = payload.azp;
    if (typeof azp !== "string" || !options.authorizedParties.includes(azp)) {
      throw new TokenVerificationError("invalid-authorized-party", "Session token was not issued for an authorized party");
    }
  }

  return payload as unknown as SessionClaims;
}
