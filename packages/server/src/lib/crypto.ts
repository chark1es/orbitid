import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, scryptSync, timingSafeEqual } from "node:crypto";

export const sha256 = (v: string) => createHash("sha256").update(v).digest("hex");
export const randomToken = (bytes = 32) => randomBytes(bytes).toString("base64url");
/** Numeric one-time code of `len` digits, zero padded. */
export const randomCode = (len = 6) => String(randomInt(0, 10 ** len)).padStart(len, "0");
export function safeEqual(a: string, b: string) {
  const ba = Buffer.from(a), bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}
export const hmacSha256 = (key: string | Buffer, data: string) => createHmac("sha256", key).update(data).digest();

/**
 * Deriving a key costs one scrypt run, so results are memoised per (purpose, secret). Without the cache every
 * token decryption (TOTP check, OAuth token read, settings read) would pay it synchronously on the event loop.
 *
 * The AES salt is `orbitid-at-rest` and must never change: existing ciphertext, signing keys and TOTP secrets are
 * all sealed with it. New purposes get their own salt, so an HMAC key can never double as an encryption key.
 */
const derivedKeys = new Map<string, Buffer>();
function deriveKey(purpose: string, secret: string, salt: string) {
  const cacheKey = `${purpose}\u0000${secret}`;
  const cached = derivedKeys.get(cacheKey);
  if (cached) return cached;
  const key = scryptSync(secret, salt, 32);
  if (derivedKeys.size > 16) derivedKeys.delete(derivedKeys.keys().next().value!);
  derivedKeys.set(cacheKey, key);
  return key;
}
/** AES-256-GCM key (the original derivation; changing it would orphan every stored secret). */
function key32(secret: string) { return deriveKey("aes", secret, "orbitid-at-rest"); }
/** Separate key for keyed digests of low-entropy values. */
function digestKey(secret: string) { return deriveKey("digest", secret, "orbitid-at-rest/digest/v1"); }

/** Prefix of a keyed digest produced by {@link hashLowEntropy}. */
export const KEYED_DIGEST_PREFIX = "h1:";

/**
 * Digest for values an attacker could enumerate offline: numeric one-time codes (10^6) and short backup
 * codes. A plain sha256 of a 6-digit code falls to a table lookup; deriving it from the instance encryption
 * key means a database dump alone cannot recover pending codes. Returns `<prefix><hex>`.
 */
export function hashLowEntropy(secret: string, value: string): string {
  return `${KEYED_DIGEST_PREFIX}${createHmac("sha256", digestKey(secret)).update(value).digest("hex")}`;
}

/** Compares a presented low-entropy value against a stored digest (keyed now, plain sha256 in older rows). */
export function verifyLowEntropy(secret: string, value: string, stored: string | null | undefined): boolean {
  if (!stored) return false;
  const expected = stored.startsWith(KEYED_DIGEST_PREFIX) ? hashLowEntropy(secret, value) : sha256(value);
  return safeEqual(expected, stored);
}

/** AES-256-GCM → `v1.<iv>.<tag>.<ciphertext>` (base64url). */
export function encrypt(secret: string, plaintext: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key32(secret), iv);
  const enc = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  return ["v1", iv.toString("base64url"), c.getAuthTag().toString("base64url"), enc.toString("base64url")].join(".");
}
export function decrypt(secret: string, payload: string): string {
  const [v, iv, tag, enc] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !enc) throw new Error("Invalid ciphertext");
  const d = createDecipheriv("aes-256-gcm", key32(secret), Buffer.from(iv, "base64url"));
  d.setAuthTag(Buffer.from(tag, "base64url"));
  return Buffer.concat([d.update(Buffer.from(enc, "base64url")), d.final()]).toString("utf8");
}
