export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  signature: string;
}

export type DecodeJwtResult = { ok: true; jwt: DecodedJwt } | { ok: false; error: string };

function decodeBase64Url(segment: string): string {
  if (!/^[A-Za-z0-9_-]*$/.test(segment)) throw new Error("Segment is not base64url");
  const base64 = segment.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new TextDecoder().decode(bytes);
}

function readSegment(segment: string, name: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(decodeBase64Url(segment));
  } catch {
    throw new Error(`The ${name} is not valid base64url JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`The ${name} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

/** Decodes a JWT without verifying it. Display only: the token came from the instance's own SDK. */
export function decodeJwt(token: string): DecodeJwtResult {
  const parts = token.trim().split(".");
  if (parts.length !== 3) {
    return { ok: false, error: `A JWT has three segments separated by dots. This token has ${parts.length}.` };
  }
  try {
    return {
      ok: true,
      jwt: {
        header: readSegment(parts[0]!, "header"),
        claims: readSegment(parts[1]!, "payload"),
        signature: parts[2]!,
      },
    };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : "The token could not be decoded" };
  }
}

export interface TokenExpiry {
  expiresAt: number | null;
  remainingMs: number | null;
}

/** `exp` is in seconds. Returns `null` when the claim is absent or not a number. */
export function tokenExpiry(claims: Record<string, unknown>, now = Date.now()): TokenExpiry {
  const exp = claims.exp;
  if (typeof exp !== "number" || !Number.isFinite(exp)) return { expiresAt: null, remainingMs: null };
  const expiresAt = exp * 1000;
  return { expiresAt, remainingMs: expiresAt - now };
}

/** Countdown text: `42s`, `1m 05s`, `expired`. */
export function formatRemaining(remainingMs: number | null): string {
  if (remainingMs === null) return "No expiry";
  if (remainingMs <= 0) return "Expired";
  const totalSeconds = Math.ceil(remainingMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** Expiry rendered as a clock time, for the claims table. */
export function formatExpiry(expiresAt: number | null): string {
  if (expiresAt === null) return "No expiry claim";
  return new Date(expiresAt).toLocaleTimeString("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** Claims worth showing first, in reading order. Everything else follows. */
export const PRIMARY_CLAIM_KEYS = [
  "sub",
  "sid",
  "iss",
  "aud",
  "azp",
  "iat",
  "nbf",
  "exp",
  "org_id",
  "org_slug",
  "org_role",
  "org_permissions",
  "sts",
  "act",
] as const;

export function orderClaims(claims: Record<string, unknown>): Array<[string, unknown]> {
  const primary = PRIMARY_CLAIM_KEYS.filter((key) => key in claims).map(
    (key) => [key, claims[key]] as [string, unknown],
  );
  const rest = Object.entries(claims)
    .filter(([key]) => !(PRIMARY_CLAIM_KEYS as readonly string[]).includes(key))
    .sort(([left], [right]) => left.localeCompare(right));
  return [...primary, ...rest];
}

/** Timestamps in this token are seconds; render them as readable values in the claims table. */
export function formatClaimValue(key: string, value: unknown): string {
  if (value === null) return "null";
  if (key === "iat" || key === "nbf" || key === "exp") {
    if (typeof value === "number") {
      return `${value} (${new Date(value * 1000).toLocaleTimeString("en-GB")})`;
    }
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}
