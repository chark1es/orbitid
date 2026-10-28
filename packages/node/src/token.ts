import { decodeProtectedHeader, errors, jwtVerify, type JWTVerifyResult } from "jose";
import type { SessionClaims } from "@orbitid/shared";
import { OrbitIdError, isOrbitIdError, type OrbitIdErrorReason } from "./errors";
import { JwksCache } from "./jwks";

/** Algorithms the OrbitID server signs session tokens with (RS256 keys, plus template keys). */
export const ALLOWED_ALGORITHMS = ["RS256", "ES256", "ES384", "ES512", "EdDSA"] as const;

export interface VerifyTokenOptions {
  /** The token to verify. Required. */
  token: string;
  /** Accepted issuer; defaults to the verifier's (the instance base URL). */
  issuer?: string;
  /** Accepted `aud`. Session tokens carry none, so this is only set for custom audiences. */
  audience?: string | string[];
  /** Accepted `azp` values (your app origins). */
  authorizedParties?: string[];
  /** Clock skew allowed for `exp`/`nbf`, in seconds. Defaults to 5. */
  clockToleranceSeconds?: number;
}

export interface TokenVerifierOptions {
  issuer: string;
  audience?: string | string[];
  authorizedParties?: string[];
  clockToleranceSeconds?: number;
  jwks: JwksCache;
}

function verificationError(reason: OrbitIdErrorReason, code: string, message: string, cause?: unknown): OrbitIdError {
  return new OrbitIdError({ code, reason, message, cause });
}

function mapJoseError(error: unknown): OrbitIdError {
  if (isOrbitIdError(error)) return error;
  if (error instanceof errors.JWTExpired) return verificationError("token-expired", "token_expired", "The session token has expired", error);
  if (error instanceof errors.JWTClaimValidationFailed) {
    switch (error.claim) {
      case "nbf":
        return verificationError("token-not-active-yet", "token_not_active_yet", "The session token is not active yet", error);
      case "iss":
        return verificationError("invalid-issuer", "token_invalid_issuer", "The session token was issued by a different instance", error);
      case "aud":
        return verificationError("invalid-audience", "token_invalid_audience", "The session token audience is invalid", error);
      default:
        return verificationError("invalid-claims", "token_invalid", `The session token claim "${error.claim}" is invalid`, error);
    }
  }
  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return verificationError("invalid-signature", "token_invalid_signature", "The session token signature is invalid", error);
  }
  if (error instanceof errors.JOSEAlgNotAllowed) {
    return verificationError("invalid-algorithm", "token_invalid_algorithm", "The session token uses a signing algorithm this SDK does not accept", error);
  }
  if (error instanceof errors.JWKSNoMatchingKey || error instanceof errors.JWKSMultipleMatchingKeys) {
    return verificationError("no-matching-key", "jwks_no_matching_key", "The session token was signed with an unknown key", error);
  }
  if (error instanceof errors.JWKSTimeout) {
    return verificationError("jwks-fetch-failed", "jwks_fetch_failed", "Timed out fetching the instance JWKS", error);
  }
  // Anything else thrown while verifying is about this token — a key that does not match the
  // declared algorithm, an unusable header, a malformed signature. It is never an outage, so it
  // must not surface as a 503.
  return verificationError("invalid-claims", "token_invalid", "The session token could not be verified", error);
}

/**
 * Verifies a session JWT: signature against the cached JWKS, then `iss`, `aud`, `exp` and `nbf`.
 * Only asymmetric signing algorithms are accepted, so a token cannot downgrade to `alg: none`
 * or a symmetric algorithm keyed with the public key.
 */
export async function verifySessionToken(options: VerifyTokenOptions, verifier: TokenVerifierOptions): Promise<SessionClaims> {
  const token = options.token?.trim();
  if (!token) throw verificationError("token-missing", "token_missing", "No session token was provided");

  let header: ReturnType<typeof decodeProtectedHeader>;
  try {
    header = decodeProtectedHeader(token);
  } catch (error) {
    throw verificationError("invalid-claims", "token_invalid", "The session token is malformed", error);
  }
  const alg = header.alg;
  if (!alg || !(ALLOWED_ALGORITHMS as readonly string[]).includes(alg)) {
    throw verificationError("invalid-algorithm", "token_invalid_algorithm", `The session token uses an unsupported algorithm (${alg ?? "none"})`);
  }

  const key = await verifier.jwks.getKey(typeof header.kid === "string" ? header.kid : undefined, alg);
  const audience = options.audience ?? verifier.audience;

  let result: JWTVerifyResult;
  try {
    result = await jwtVerify(token, key, {
      issuer: options.issuer ?? verifier.issuer,
      algorithms: [alg],
      ...(audience === undefined ? {} : { audience }),
      clockTolerance: options.clockToleranceSeconds ?? verifier.clockToleranceSeconds ?? 5,
    });
  } catch (error) {
    throw mapJoseError(error);
  }

  const payload = result.payload as unknown as SessionClaims;
  // Machine and OIDC tokens share the instance key but carry an audience; they are not sessions.
  if (payload.aud !== undefined && audience === undefined) {
    throw verificationError("not-session-token", "token_not_session", "That token is not a session token");
  }
  if (typeof payload.sub !== "string" || typeof payload.sid !== "string") {
    throw verificationError("invalid-claims", "token_invalid", "The session token is missing the sub/sid claims");
  }
  if (payload.sts === "pending") {
    throw verificationError("session-pending", "session_pending", "The session is pending verification");
  }

  const parties = options.authorizedParties ?? verifier.authorizedParties;
  if (parties?.length) {
    const azp = payload.azp;
    if (typeof azp !== "string" || !parties.includes(azp)) {
      throw verificationError("invalid-authorized-party", "token_invalid_authorized_party", "The session token was not issued for this application");
    }
  }

  return payload;
}
