// nodemailer via settings.email.smtpUrl, falls back to console logging; HTML templates; SMS via settings.sms.
import nodemailer, { type Transporter } from "nodemailer";
import type { AppContext } from "../context";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { safeFetch } from "../lib/safe-fetch";
import { logSafe } from "../lib/security";
import { emitEvent } from "./webhooks";

export type EmailTemplate =
  | "verification_code" | "magic_link" | "reset_password_code" | "invitation" | "organization_invitation" | "password_changed" | "new_sign_in" | "waitlist_invited" | "domain_verification_code";
export interface SendEmailInput { to: string; template: EmailTemplate; vars: Record<string, string | number | undefined> }

export interface SentEmail { to: string; template: EmailTemplate; subject: string; text: string; html: string; vars: Record<string, string | number | undefined>; sentAt: number }

/** Test seam / dev outbox: every email is recorded here regardless of transport. */
const outbox: SentEmail[] = [];
const smsOutbox: { to: string; body: string; sentAt: number }[] = [];
let transportOverride: ((email: SentEmail) => Promise<void>) | null = null;
let smsOverride: ((to: string, body: string) => Promise<void>) | null = null;
const transporters = new Map<string, Transporter>();

export const getMailOutbox = (): readonly SentEmail[] => outbox;
export const getSmsOutbox = (): readonly { to: string; body: string; sentAt: number }[] => smsOutbox;
export function clearMailOutbox() { outbox.length = 0; smsOutbox.length = 0; }
export function setMailTransport(fn: ((email: SentEmail) => Promise<void>) | null) { transportOverride = fn; }
export function setSmsSender(fn: ((to: string, body: string) => Promise<void>) | null) { smsOverride = fn; }

/** Latest recorded email for an address (optionally filtered by template). */
export function latestEmail(to: string, template?: EmailTemplate): SentEmail | undefined {
  return [...outbox].reverse().find((m) => m.to.toLowerCase() === to.toLowerCase() && (!template || m.template === template));
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

const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const display = (v: string | number | undefined, fallback = "") => (v === undefined || v === null || v === "" ? fallback : String(v));

/**
 * A value safe to put in an email header. CR/LF (and other control characters) would let a crafted name or
 * organisation title inject extra headers, so they are collapsed to a single space.
 */
const headerValue = (v: string): string => v.replace(/[\r\n\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim();

interface RenderedEmail { subject: string; text: string; html: string }

function renderEmail(template: EmailTemplate, vars: SendEmailInput["vars"], appName: string, primaryColor: string): RenderedEmail {
  const code = display(vars.code);
  const link = display(vars.link ?? vars.invitation_url ?? vars.url);
  const minutes = display(vars.expires_in_minutes, "10");
  const greeting = vars.user_name ? `Hi ${display(vars.user_name)},` : "Hello,";
  const brand = appName;

  let subject: string;
  let intro: string;
  let body: string;
  let action = "";

  switch (template) {
    case "verification_code":
      subject = `${code} is your ${brand} verification code`;
      intro = `${greeting} use this code to verify your email address.`;
      body = `The code expires in ${minutes} minutes. If you did not request it, you can ignore this email.`;
      break;
    case "magic_link":
      subject = `Sign in to ${brand}`;
      intro = `${greeting} use the button below to sign in to ${brand}.`;
      body = `This link expires in ${minutes} minutes and can only be used once. If you did not request it, you can ignore this email.`;
      action = "Sign in";
      break;
    case "reset_password_code":
      subject = `${code} is your ${brand} password reset code`;
      intro = `${greeting} use this code to reset your password.`;
      body = `The code expires in ${minutes} minutes. If you did not request a reset, you can ignore this email.`;
      break;
    case "invitation":
      subject = `You have been invited to ${brand}`;
      intro = `${greeting} you have been invited to join ${brand}.`;
      body = "Accept the invitation to create your account.";
      action = "Accept invitation";
      break;
    case "organization_invitation":
      subject = `Join ${display(vars.organization_name, brand)} on ${brand}`;
      intro = `${greeting} ${display(vars.inviter_name, "An administrator")} invited you to join ${display(vars.organization_name, "an organization")}.`;
      body = "Accept the invitation to join the organization.";
      action = "Accept invitation";
      break;
    case "password_changed":
      subject = `Your ${brand} password was changed`;
      intro = `${greeting} the password for your ${brand} account was changed.`;
      body = "If you did not make this change, reset your password immediately and contact support.";
      break;
    case "new_sign_in":
      subject = `New sign-in to your ${brand} account`;
      intro = `${greeting} a new sign-in to your ${brand} account was detected.`;
      body = `When: ${display(vars.date, "just now")}\nIP address: ${display(vars.ip_address, "unknown")}\nDevice: ${display(vars.user_agent, "unknown")}\n\nIf this was not you, change your password immediately.`;
      break;
    case "waitlist_invited":
      subject = `You are off the waitlist for ${brand}`;
      intro = `${greeting} you have been invited to join ${brand}.`;
      body = "Use the button below to create your account.";
      action = "Create account";
      break;
    case "domain_verification_code":
      subject = `${code} is your ${brand} domain verification code`;
      intro = `${greeting} use this code to verify ownership of ${display(vars.domain, "your domain")}.`;
      body = `The code expires in ${minutes} minutes.`;
      break;
    default:
      subject = brand;
      intro = greeting;
      body = "";
  }

  const actionBlock = action && link
    ? `<p style="margin:24px 0"><a href="${escapeHtml(link)}" style="background:${escapeHtml(primaryColor)};color:#fff;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:600">${escapeHtml(action)}</a></p>`
    : "";
  const codeBlock = code
    ? `<p style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:32px;letter-spacing:8px;font-weight:700;margin:24px 0">${escapeHtml(code)}</p>`
    : "";
  const html = `<!doctype html><html><body style="margin:0;background:#f6f7f9;padding:32px 16px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#111827">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="100%" style="max-width:520px;background:#fff;border-radius:12px;padding:32px">
<tr><td style="font-size:18px;font-weight:700;color:${escapeHtml(primaryColor)}">${escapeHtml(brand)}</td></tr>
<tr><td style="padding-top:16px;font-size:15px;line-height:1.6"><p>${escapeHtml(intro)}</p>${codeBlock}${actionBlock}<p style="color:#4b5563;white-space:pre-line">${escapeHtml(body)}</p></td></tr>
<tr><td style="padding-top:24px;font-size:12px;color:#9ca3af">Sent by ${escapeHtml(brand)}</td></tr>
</table></td></tr></table></body></html>`;
  const textParts = [intro, code ? `Code: ${code}` : "", action && link ? `${action}: ${link}` : "", body, "", `— ${brand}`].filter(Boolean);
  // Header fields (subject and recipient address) are single-line: strip CR/LF so no extra header can be injected.
  return { subject: headerValue(subject), text: textParts.join("\n"), html };
}

function transporterFor(smtpUrl: string): Transporter {
  let t = transporters.get(smtpUrl);
  if (!t) {
    t = nodemailer.createTransport(smtpUrl);
    transporters.set(smtpUrl, t);
  }
  return t;
}

export async function sendEmail(ctx: AppContext, input: SendEmailInput): Promise<void> {
  const settings = ctx.settings.get();
  const rendered = renderEmail(input.template, input.vars, settings.application.name, settings.branding.primaryColor);
  const email: SentEmail = { to: input.to, template: input.template, ...rendered, vars: input.vars, sentAt: Date.now() };
  if (ctx.env.nodeEnv !== "production") {
    outbox.push(email);
    if (outbox.length > 500) outbox.splice(0, outbox.length - 500);
  }

  try {
    if (transportOverride) {
      await transportOverride(email);
    } else if (settings.email.smtpUrl) {
      await transporterFor(settings.email.smtpUrl).sendMail({
        from: settings.email.from,
        to: headerValue(input.to),
        subject: rendered.subject,
        text: rendered.text,
        html: rendered.html,
      });
    } else if (ctx.env.nodeEnv !== "test" && !process.env.VITEST) {
      if (ctx.env.nodeEnv === "production") {
        console.warn(`[orbitid:mail] SMTP is not configured; dropped "${input.template}" email to ${logSafe(input.to)}`);
      } else {
        const code = typeof input.vars.code === "string" ? ` code=${input.vars.code}` : "";
        const linkValue = input.vars.link ?? input.vars.invitation_url ?? input.vars.url;
        const link = typeof linkValue === "string" ? ` link=${linkValue}` : "";
        console.log(`\n[orbitid:mail] to=${logSafe(input.to)} template=${input.template}${code}${link}\n${rendered.subject}\n${rendered.text}\n`);
      }
    }
  } catch {
    // Delivery failures must not break the auth flow; the email stays in the outbox/log for debugging.
    if (ctx.env.nodeEnv !== "test") console.error(`[orbitid:mail] failed to deliver ${input.template} to ${logSafe(input.to)}`);
  }
  await emitEvent(ctx, "email.created", {
    object: "email", to: input.to, template: input.template, subject: rendered.subject, created_at: email.sentAt,
  });
}

/** Twilio REST API (no SDK needed). */
async function sendViaTwilio(ctx: AppContext, to: string, body: string) {
  const sms = ctx.settings.get().sms;
  if (!sms.twilioAccountSid || !sms.twilioAuthToken || !sms.twilioFrom) {
    throw new OrbitError(500, ErrorCodes.request_body_invalid, "Twilio SMS is not configured");
  }
  const url = `https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sms.twilioAccountSid)}/Messages.json`;
  const res = await safeFetch(ctx, url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${sms.twilioAccountSid}:${sms.twilioAuthToken}`).toString("base64")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ To: to, From: sms.twilioFrom, Body: body }),
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
  });
  if (!res.ok) throw new Error(`Twilio responded ${res.status}`);
}

async function sendViaWebhook(ctx: AppContext, to: string, body: string) {
  const url = ctx.settings.get().sms.webhookUrl;
  if (!url) throw new OrbitError(500, ErrorCodes.request_body_invalid, "SMS webhook is not configured");
  const res = await safeFetch(ctx, url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to, body, from: ctx.settings.get().application.name }),
    timeoutMs: 10_000,
    maxBytes: 64 * 1024,
  });
  if (!res.ok) throw new Error(`SMS webhook responded ${res.status}`);
}

export async function sendSms(ctx: AppContext, to: string, body: string): Promise<void> {
  if (ctx.env.nodeEnv !== "production") {
    smsOutbox.push({ to, body, sentAt: Date.now() });
    if (smsOutbox.length > 500) smsOutbox.splice(0, smsOutbox.length - 500);
  }
  const settings = ctx.settings.get();
  try {
    if (smsOverride) await smsOverride(to, body);
    else if (settings.sms.provider === "twilio") await sendViaTwilio(ctx, to, body);
    else if (settings.sms.provider === "webhook") await sendViaWebhook(ctx, to, body);
    else if (ctx.env.nodeEnv !== "test" && !process.env.VITEST) {
      if (ctx.env.nodeEnv === "production") console.warn(`[orbitid:sms] no SMS provider configured; dropped message to ${logSafe(to)}`);
      else console.log(`\n[orbitid:sms] to=${logSafe(to)}\n${body}\n`);
    }
  } catch {
    if (ctx.env.nodeEnv !== "test") console.error(`[orbitid:sms] failed to deliver to ${logSafe(to)}`);
  }
  await emitEvent(ctx, "sms.created", { object: "sms", to, body, created_at: Date.now() });
}
