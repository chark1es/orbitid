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

function key32(secret: string) { return scryptSync(secret, "orbitid-at-rest", 32); }
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
