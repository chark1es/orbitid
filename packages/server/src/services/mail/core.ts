// Mail delivery: Resend (fetch), SMTP (nodemailer); HTML templates; SMS via settings.sms.
//
// Nothing here ever prints a message. A sign-in code, a magic link or an invitation URL on stdout ends up in
// terminal scrollback, CI logs and support pastes, and writing it to a file on the server is no better: it is a
// plaintext credential with an operator-controlled lifetime. When no provider is configured the server fails
// closed (no delivery, a generic "not configured" error), so a code can only reach the mailbox it was sent to.
// Tests capture messages in an in-memory outbox; there is no other capture path.
import nodemailer, { type Transporter } from "nodemailer";
import type { AppContext } from "../../context";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { safeFetch } from "../../lib/safe-fetch";
import { DEFAULT_FROM, headerSafe, normalizeRecipient, parseEmailFrom, parseSmtpUrl, redactSmtpUrl } from "../../lib/email-format";
import { audit } from "../audit";
import { emitEvent } from "../webhooks";

export { DEFAULT_FROM, headerSafe, normalizeRecipient, parseEmailFrom, parseSmtpUrl, redactSmtpUrl };
export type { SmtpConnection } from "../../lib/email-format";

export type EmailTemplate =
  | "verification_code" | "magic_link" | "reset_password_code" | "invitation" | "organization_invitation" | "password_changed" | "new_sign_in" | "waitlist_invited" | "domain_verification_code" | "test_email";
export interface SendEmailInput { to: string; template: EmailTemplate; vars: Record<string, string | number | undefined> }

/**
 * Outcome of a send. Delivery never breaks an auth flow and never writes to the console: a failed send is
 * reported to the caller and recorded as a non-secret audit entry (template and reason only), so an operator
 * can spot a misconfiguration without any sign-in code, link or recipient being copied into a log.
 */
export interface EmailDeliveryResult {
  delivered: boolean;
  /** Machine-readable reason when `delivered` is false; never contains a code, link, recipient or provider secret. */
  error?: { code: string; message: string };
}

export interface SentEmail { to: string; template: EmailTemplate; subject: string; text: string; html: string; vars: Record<string, string | number | undefined>; sentAt: number }

/** How mail leaves the server. `console` is the legacy "no provider configured" value: it never delivers. */
export type EmailProvider = "resend" | "smtp" | "console";

export interface ResolvedEmailTransport {
  provider: EmailProvider;
  /** Header-safe `From` value, e.g. `"Acme" <no-reply@acme.test>`. */
  from: string;
  /** Set when `provider === "resend"`. */
  resendApiKey?: string;
  /** Set when `provider === "smtp"`. */
  smtpUrl?: string;
}

// ───────────── test-only capture ─────────────
//
// The outbox and the transport overrides exist for the test suite only. They are guarded so a deployed server
// cannot be talked into capturing a code: the guard runs on every read *and* write of the seam.

export const isTestEnvironment = (): boolean => !!process.env.VITEST || process.env.NODE_ENV === "test";

function testSeam(name: string): void {
  if (!isTestEnvironment()) throw new Error(`${name} is only available in tests`);
}

/** Test seam / dev outbox: every email is recorded here regardless of transport. */
export const outbox: SentEmail[] = [];
export const smsOutbox: { to: string; body: string; sentAt: number }[] = [];
export let transportOverride: ((email: SentEmail) => Promise<void>) | null = null;
export let smsOverride: ((to: string, body: string) => Promise<void>) | null = null;
export const transporters = new Map<string, Transporter>();

export const getMailOutbox = (): readonly SentEmail[] => {
  testSeam("getMailOutbox");
  return outbox;
};
export const getSmsOutbox = (): readonly { to: string; body: string; sentAt: number }[] => {
  testSeam("getSmsOutbox");
  return smsOutbox;
};
export function clearMailOutbox() {
  testSeam("clearMailOutbox");
  outbox.length = 0;
  smsOutbox.length = 0;
}
export function setMailTransport(fn: ((email: SentEmail) => Promise<void>) | null) {
  testSeam("setMailTransport");
  transportOverride = fn;
}
export function setSmsSender(fn: ((to: string, body: string) => Promise<void>) | null) {
  testSeam("setSmsSender");
  smsOverride = fn;
}

/** Latest recorded email for an address (optionally filtered by template). Test-only. */
export function latestEmail(to: string, template?: EmailTemplate): SentEmail | undefined {
  return [...getMailOutbox()].reverse().find((m) => m.to.toLowerCase() === to.toLowerCase() && (!template || m.template === template));
}

/** Extracts the numeric code from the most recent code email sent to `to` (test helper). */
export function latestCodeFor(to: string, template: EmailTemplate = "verification_code"): string | undefined {
  const email = latestEmail(to, template);
  if (!email) return undefined;
  if (typeof email.vars.code === "string") return email.vars.code;
  const m = /\b(\d{4,8})\b/.exec(email.text);
  return m?.[1];
}

/** Extracts the magic link from the most recent link email sent to `to` (test helper). */
export function latestLinkFor(to: string): string | undefined {
  const email = latestEmail(to, "magic_link");
  return typeof email?.vars.link === "string" ? email.vars.link : undefined;
}

// ───────────── provider resolution ─────────────
// (Header/address validators live in `lib/email-format`; the settings policy imports them from there, so a
// mock of this module can never change what "a valid email configuration" means.)


/**
 * Picks the transport from settings, falling back to the environment only where the setting is empty.
 * Explicit `email.provider` wins; `auto` uses Resend when a key exists, else SMTP, else nothing
 * (`console`, which refuses delivery).
 */
export function resolveEmailTransport(ctx: AppContext): ResolvedEmailTransport {
  const email = ctx.settings.get().email;
  const resendApiKey = (email.resendApiKey || ctx.env.resendApiKey || "").trim();
  const smtpUrl = (email.smtpUrl || ctx.env.smtpUrl || "").trim();
  // The schema default is a placeholder, so ORBITID_EMAIL_FROM fills it in until the operator sets a real one.
  const settingFrom = email.from && email.from !== DEFAULT_FROM ? email.from : "";
  const from = parseEmailFrom(settingFrom || ctx.env.emailFrom || DEFAULT_FROM).value;

  let provider: EmailProvider;
  if (email.provider === "resend" || email.provider === "smtp" || email.provider === "console") provider = email.provider;
  else provider = resendApiKey ? "resend" : smtpUrl ? "smtp" : "console";

  if (provider === "resend") {
    if (!resendApiKey) {
      throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "email.provider is resend but no API key is configured. Set email.resendApiKey or ORBITID_RESEND_API_KEY.", { param_name: "email.resendApiKey" });
    }
    return { provider, from, resendApiKey };
  }
  if (provider === "smtp") {
    if (!smtpUrl) {
      throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "email.provider is smtp but no SMTP URL is configured. Set email.smtpUrl or ORBITID_SMTP_URL.", { param_name: "email.smtpUrl" });
    }
    // Validates the scheme/port so a bad URL fails before anything is sent.
    parseSmtpUrl(smtpUrl);
    return { provider, from, smtpUrl };
  }
  return { provider, from };
}

/**
 * The resolved transport is `console` when no provider is configured. That is not a delivery channel: the
 * server refuses to print codes and refuses to write them to disk, so the only honest answer is an error.
 * `emailStartupWarnings` reports the state at boot so an operator sees it before a user does.
 */
export function emailDeliveryConfigured(ctx: AppContext): boolean {
  try {
    return resolveEmailTransport(ctx).provider !== "console";
  } catch {
    return false;
  }
}

export function emailStartupWarnings(ctx: AppContext): string[] {
  let transport: ResolvedEmailTransport | undefined;
  try {
    transport = resolveEmailTransport(ctx);
  } catch (error) {
    const message = error instanceof Error ? error.message : "email settings are invalid";
    return [`  Email           : MISCONFIGURED — ${message}`];
  }
  if (transport.provider === "resend") return [`  Email           : Resend`];
  if (transport.provider === "smtp") return [`  Email           : SMTP (${redactSmtpUrl(transport.smtpUrl ?? "")})`];
  return [
    "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    "  !! EMAIL IS NOT CONFIGURED, SO NO EMAIL IS SENT.                                   !!",
    "  !! Sign-in codes, magic links and invitations cannot be delivered.                 !!",
    "  !! Set ORBITID_RESEND_API_KEY or ORBITID_SMTP_URL (or pick a provider in the       !!",
    "  !! dashboard). See docs/EMAIL.md.                                                  !!",
    "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
  ];
}
