// Password hashing for the Backend API (argon2id at rest, verification of imported digests).
import { createRequire } from "node:module";
import { scryptSync, timingSafeEqual } from "node:crypto";
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";
import { ErrorCodes, OrbitError, type InstanceSettings } from "@orbitid/shared";

export const PASSWORD_HASHERS = ["argon2", "bcrypt", "scrypt"] as const;
export type PasswordHasher = (typeof PASSWORD_HASHERS)[number];

/** bcrypt is optional (only needed to verify digests imported from bcrypt-based systems). */
function optionalBcrypt(): { compare?: (plain: string, hash: string) => Promise<boolean> } | null {
  const require = createRequire(import.meta.url);
  for (const id of ["bcryptjs", "bcrypt"]) {
    try {
      return require(id) as { compare?: (plain: string, hash: string) => Promise<boolean> };
    } catch {
      // not installed — try the next module id
    }
  }
  return null;
}

/** argon2id with @node-rs/argon2 defaults (m=19456, t=2, p=1) — the same PHC string other workers' helpers produce. */
export function hashPassword(password: string): Promise<string> {
  return argonHash(password);
}

/** `scrypt$<N>$<r>$<p>$<saltBase64>$<keyBase64>` */
function verifyScrypt(hash: string, password: string): boolean {
  const [scheme, n, r, p, salt, digest] = hash.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !digest) return false;
  const expected = Buffer.from(digest, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 512 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export async function verifyPassword(hash: string | null | undefined, password: string): Promise<boolean> {
  if (!hash) return false;
  if (hash.startsWith("$argon2")) return argonVerify(hash, password);
  if (/^\$2[abxy]\$/.test(hash)) {
    const bcrypt = optionalBcrypt();
    return bcrypt?.compare ? await bcrypt.compare(password, hash) : false;
  }
  if (hash.startsWith("scrypt$")) return verifyScrypt(hash, password);
  return false;
}

/** Rejects a `password_digest` whose hasher cannot be verified in this deployment. */
export function assertPasswordHasher(hasher: string): PasswordHasher {
  if (!(PASSWORD_HASHERS as readonly string[]).includes(hasher)) {
    throw new OrbitError(422, ErrorCodes.form_param_value_invalid, `password_hasher must be one of ${PASSWORD_HASHERS.join(", ")}.`, { param_name: "password_hasher" });
  }
  if (hasher === "bcrypt" && !optionalBcrypt()) {
    throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "password_hasher bcrypt is not available on this instance (install bcryptjs).", { param_name: "password_hasher" });
  }
  return hasher as PasswordHasher;
}

/** Instance password policy from `settings.password`. */
export function assertPasswordPolicy(settings: InstanceSettings, password: string, paramName = "password"): void {
  const policy = settings.password;
  if (password.length < policy.minLength) {
    throw new OrbitError(422, ErrorCodes.form_password_length_too_short, `Passwords must be at least ${policy.minLength} characters long.`, { param_name: paramName });
  }
  if (password.length > policy.maxLength) {
    throw new OrbitError(422, ErrorCodes.form_password_length_too_short, `Passwords must be at most ${policy.maxLength} characters long.`, { param_name: paramName });
  }
  const missing: string[] = [];
  if (policy.requireLowercase && !/[a-z]/.test(password)) missing.push("a lowercase letter");
  if (policy.requireUppercase && !/[A-Z]/.test(password)) missing.push("an uppercase letter");
  if (policy.requireNumbers && !/[0-9]/.test(password)) missing.push("a number");
  if (policy.requireSpecialCharacter && !/[^A-Za-z0-9]/.test(password)) missing.push("a special character");
  if (missing.length) {
    throw new OrbitError(422, ErrorCodes.form_password_not_strong_enough, `Passwords must contain ${missing.join(", ")}.`, { param_name: paramName });
  }
}
