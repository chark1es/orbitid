// Password hashing for the Backend API (argon2id at rest, verification of imported digests).
import { hash as argonHash } from "@node-rs/argon2";
import { ErrorCodes, OrbitError, type InstanceSettings } from "@orbitid/shared";
import { passwordDigestKind } from "../../lib/password-digest";
import { optionalBcrypt, verifyPassword } from "../../services/passwords";

export { verifyPassword };

export const PASSWORD_HASHERS = ["argon2", "bcrypt", "scrypt"] as const;
export type PasswordHasher = (typeof PASSWORD_HASHERS)[number];

/** argon2id with @node-rs/argon2 defaults (m=19456, t=2, p=1). */
export function hashPassword(password: string): Promise<string> {
  return argonHash(password);
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

/** Reject malformed, mismatched or excessive-cost digests before persisting imported credentials. */
export function assertPasswordDigest(digest: string, hasher: string): void {
  assertPasswordHasher(hasher);
  if (passwordDigestKind(digest) !== hasher) {
    throw new OrbitError(422, ErrorCodes.form_param_value_invalid, "password_digest is malformed, does not match password_hasher, or exceeds the supported cost limits.", { param_name: "password_digest" });
  }
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
