// Password policy + argon2id hashing + optional HIBP check.
import { createRequire } from "node:module";
import { createHash, scryptSync, timingSafeEqual } from "node:crypto";
import { hash, verify } from "@node-rs/argon2";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import type { InstanceSettings } from "@orbitid/shared";

/** Argon2id parameters. Test runs use a cheaper cost so the suite stays fast (verification still works for both). */
const isTest = process.env.NODE_ENV === "test" || !!process.env.VITEST;
const HASH_OPTIONS = isTest
  ? { algorithm: 2, memoryCost: 4096, timeCost: 1, parallelism: 1 }
  : { algorithm: 2, memoryCost: 19456, timeCost: 2, parallelism: 1 };

export const hashPassword = (password: string): Promise<string> => hash(password, HASH_OPTIONS);

/** bcrypt is optional (only needed to verify digests imported from bcrypt-based systems). */
export function optionalBcrypt(): { compare?: (plain: string, hash: string) => Promise<boolean> } | null {
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

/** `scrypt$<N>$<r>$<p>$<saltBase64>$<keyBase64>` */
function verifyScrypt(hash: string, password: string): boolean {
  const [scheme, n, r, p, salt, digest] = hash.split("$");
  if (scheme !== "scrypt" || !n || !r || !p || !salt || !digest) return false;
  const expected = Buffer.from(digest, "base64");
  const actual = scryptSync(password, Buffer.from(salt, "base64"), expected.length, { N: Number(n), r: Number(r), p: Number(p), maxmem: 512 * 1024 * 1024 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/** Checks a stored digest of any supported format: argon2id (native), bcrypt and scrypt (imported users). */
export async function verifyPassword(passwordHash: string | null | undefined, password: string): Promise<boolean> {
  if (!passwordHash) return false;
  try {
    if (passwordHash.startsWith("$argon2")) return await verify(passwordHash, password);
    if (/^\$2[abxy]\$/.test(passwordHash)) {
      const bcrypt = optionalBcrypt();
      return bcrypt?.compare ? await bcrypt.compare(password, passwordHash) : false;
    }
    if (passwordHash.startsWith("scrypt$")) return verifyScrypt(passwordHash, password);
    return false;
  } catch {
    return false;
  }
}

const sha1 = (v: string) => createHash("sha1").update(v).digest("hex").toUpperCase();

/**
 * HaveIBeenPwned k-anonymity range API. Fails **open** on network/HTTP errors so password changes never depend on a
 * third party being reachable.
 */
export async function isPasswordPwned(password: string): Promise<boolean> {
  try {
    const digest = sha1(password);
    const prefix = digest.slice(0, 5);
    const suffix = digest.slice(5);
    const res = await fetch(`https://api.pwnedpasswords.com/range/${prefix}`, {
      headers: { "Add-Padding": "true", "User-Agent": "OrbitID" },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) return false;
    const body = await res.text();
    for (const line of body.split("\n")) {
      const [hashSuffix, count] = line.trim().split(":");
      if (hashSuffix?.toUpperCase() === suffix && Number(count) > 0) return true;
    }
    return false;
  } catch {
    return false;
  }
}

export interface PasswordPolicyProblem { code: string; message: string }

/** Returns the policy violations of `password` (empty array = valid). Pure, used by the Backend API too. */
export function passwordProblems(password: string, policy: InstanceSettings["password"]): PasswordPolicyProblem[] {
  const problems: PasswordPolicyProblem[] = [];
  if (password.length < policy.minLength) {
    problems.push({ code: ErrorCodes.form_password_length_too_short, message: `Passwords must be at least ${policy.minLength} characters long.` });
  }
  if (password.length > policy.maxLength) {
    problems.push({ code: ErrorCodes.form_password_length_too_short, message: `Passwords must be at most ${policy.maxLength} characters long.` });
  }
  if (policy.requireLowercase && !/[a-z]/.test(password)) {
    problems.push({ code: ErrorCodes.form_password_not_strong_enough, message: "Passwords must contain a lowercase letter." });
  }
  if (policy.requireUppercase && !/[A-Z]/.test(password)) {
    problems.push({ code: ErrorCodes.form_password_not_strong_enough, message: "Passwords must contain an uppercase letter." });
  }
  if (policy.requireNumbers && !/\d/.test(password)) {
    problems.push({ code: ErrorCodes.form_password_not_strong_enough, message: "Passwords must contain a number." });
  }
  if (policy.requireSpecialCharacter && !/[^A-Za-z0-9]/.test(password)) {
    problems.push({ code: ErrorCodes.form_password_not_strong_enough, message: "Passwords must contain a special character." });
  }
  return problems;
}

/** Validates against the instance policy (and HIBP when enabled). Throws an OrbitError on the first violation. */
export async function assertPasswordValid(ctx: AppContext, password: string): Promise<void> {
  const policy = ctx.settings.get().password;
  const problems = passwordProblems(password, policy);
  if (problems.length) {
    const first = problems[0]!;
    const err = new OrbitError(422, first.code, first.message, {
      param_name: "password",
      min_length: policy.minLength,
      max_length: policy.maxLength,
      require_lowercase: policy.requireLowercase,
      require_uppercase: policy.requireUppercase,
      require_numbers: policy.requireNumbers,
      require_special_char: policy.requireSpecialCharacter,
    });
    (err as any).items = problems.map((p) => new OrbitError(422, p.code, p.message, { param_name: "password" }).toItem());
    throw err;
  }
  if (policy.rejectPwned && (await isPasswordPwned(password))) {
    throw new OrbitError(422, ErrorCodes.form_password_pwned, "This password has been found in a data breach. Please choose another one.", { param_name: "password" });
  }
}
