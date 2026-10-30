/** Request schemas, identifier helpers, and the constant-time password check for the sign-in routes. */
import { type Context } from "hono";
import * as s from "../../db/schema";
import { z } from "zod";
import { randomToken } from "../../lib/crypto";
import { hashPassword, verifyPassword } from "../../services/passwords";

export const shortText = (max: number) => z.string().max(max);
export const createSchema = z.object({
  identifier: shortText(320).optional(),
  strategy: shortText(64).optional(),
  password: shortText(256).optional(),
  ticket: shortText(512).optional(),
  redirect_url: shortText(2048).optional(),
  action_complete_redirect_url: shortText(2048).optional(),
  captcha_token: shortText(4096).optional(),
  transfer: z.boolean().optional(),
});
export const prepareFirstSchema = z.object({
  strategy: shortText(64).optional(),
  email_address_id: shortText(64).optional(),
  phone_number_id: shortText(64).optional(),
  redirect_url: shortText(2048).optional(),
  captcha_token: shortText(4096).optional(),
});
export const attemptFirstSchema = z.object({
  strategy: shortText(64).optional(),
  code: shortText(64).optional(),
  password: shortText(256).optional(),
  signature: shortText(8192).optional(),
  public_key_credential: z.unknown().optional(),
});
export const prepareSecondSchema = z.object({ strategy: shortText(64).optional(), phone_number_id: shortText(64).optional(), email_address_id: shortText(64).optional() });
export const attemptSecondSchema = z.object({
  strategy: shortText(64).optional(),
  code: shortText(64).optional(),
  /** Remember this browser so it skips the second factor until the trusted device expires. */
  trust_device: z.boolean().optional(),
});
export const resetPasswordSchema = z.object({
  password: shortText(256),
  sign_out_of_other_sessions: z.boolean().optional(),
  redirect_url: shortText(2048).optional(),
});

export type SignInRow = typeof s.signIns.$inferSelect;

export const captchaToken = (c: Context, body: { captcha_token?: string }) => body.captcha_token ?? c.req.header("x-captcha-token") ?? undefined;

/**
 * A hash that no password matches, produced with this server's own argon2id parameters (so the dummy
 * check costs exactly what a real one does). Verifying against it when the account does not exist, or
 * has no password, keeps both response paths equally slow: timing cannot be used to enumerate accounts.
 */
let dummyPasswordHash: Promise<string> | null = null;
export const dummyHash = () => (dummyPasswordHash ??= hashPassword(randomToken(24)));

/** Performs the same work as a real password check without revealing whether the account exists. */
export async function spendPasswordCheck(hash: string | null | undefined, password: string | undefined): Promise<boolean> {
  if (!hash) {
    await verifyPassword(await dummyHash(), password ?? "not-the-password");
    return false;
  }
  return verifyPassword(hash, password ?? "");
}
