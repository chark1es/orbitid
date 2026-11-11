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
  /**
   * Clock skew allowed for `nbf`/`iat` when the verifier's clock is *behind* the issuer, in seconds. Defaults to
   * 60, so a 60 s token minted milliseconds apart verifies. This tolerance does not apply to `exp`.
   */
  clockToleranceSeconds?: number;
  /**
   * Clock skew allowed for `exp`, in seconds. Defaults to 10. Keeping this separate from `clockToleranceSeconds`
   * is what bounds revocation: a 60 s JWT stays usable for at most ~70 s after it was minted, not ~120 s.
   */
  expClockToleranceSeconds?: number;
  /**
   * Expected token kind. Defaults to `"session"`, which refuses a JWT-template token even when it is signed with
   * the instance key. Pass `"jwt_template"` to verify a template token deliberately.
   */
  tokenType?: "session" | "jwt_template";
}

export interface TokenVerifierOptions {
  issuer: string;
  audience?: string | string[];
  authorizedParties?: string[];
  clockToleranceSeconds?: number;
  expClockToleranceSeconds?: number;
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

  const earlyTolerance = options.clockToleranceSeconds ?? verifier.clockToleranceSeconds ?? 60;
  const expTolerance = options.expClockToleranceSeconds ?? verifier.expClockToleranceSeconds ?? 10;

  let result: JWTVerifyResult;
  try {
    result = await jwtVerify(token, key, {
      issuer: options.issuer ?? verifier.issuer,
      algorithms: [alg],
      ...(audience === undefined ? {} : { audience }),
      // `jose` applies one tolerance to every time claim. Give it the larger (early) value so `nbf` skew is
      // accepted, then enforce `exp` below with its own, much smaller tolerance.
      clockTolerance: Math.max(earlyTolerance, expTolerance),
    });
  } catch (error) {
    throw mapJoseError(error);
  }

  const payload = result.payload as unknown as SessionClaims;
  const nowSeconds = Date.now() / 1000;
  // A token is not usable past its own `exp` plus the small expiry tolerance. This is the real revocation bound:
  // a 60 s JWT can never be replayed ~120 s after mint because the verifier's clock runs behind.
  if (typeof payload.exp === "number" && payload.exp + expTolerance < nowSeconds) {
    throw verificationError("token-expired", "token_expired", "The session token has expired");
  }
  // `iat`/`nbf` are allowed to be early (verifier behind issuer) by the early tolerance only.
  for (const claim of ["nbf", "iat"] as const) {
    const value = payload[claim];
    if (typeof value === "number" && value > nowSeconds + earlyTolerance) {
      throw verificationError("token-not-active-yet", "token_not_active_yet", "The session token is not active yet");
    }
  }
  // Machine and OIDC tokens share the instance key but carry an audience; they are not sessions.
  if (payload.aud !== undefined && audience === undefined) {
    throw verificationError("not-session-token", "token_not_session", "That token is not a session token");
  }
  // A template token is an integration credential with its own lifetime; it is not proof of a session.
  if (options.tokenType === "jwt_template") {
    if (payload.token_type !== "jwt_template") {
      throw verificationError("not-session-token", "token_not_template", "That token is not a JWT template token");
    }
  } else if (payload.token_type === "jwt_template") {
    throw verificationError("not-session-token", "token_not_session", "JWT template tokens cannot be used as session tokens");
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
