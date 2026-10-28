// Mail delivery: Resend (fetch), SMTP (nodemailer) or the console; HTML templates; SMS via settings.sms.
import nodemailer, { type Transporter } from "nodemailer";
import type { AppContext } from "../context";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { safeFetch } from "../lib/safe-fetch";
import { logSafe } from "../lib/security";
import { emitEvent } from "./webhooks";

export type EmailTemplate =
  | "verification_code" | "magic_link" | "reset_password_code" | "invitation" | "organization_invitation" | "password_changed" | "new_sign_in" | "waitlist_invited" | "domain_verification_code" | "test_email";
export interface SendEmailInput { to: string; template: EmailTemplate; vars: Record<string, string | number | undefined> }

export interface SentEmail { to: string; template: EmailTemplate; subject: string; text: string; html: string; vars: Record<string, string | number | undefined>; sentAt: number }

/** How mail leaves the server. `console` prints it to the server log. */
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

// ───────────── header + address safety ─────────────

/** Removes CR/LF (and other control characters) so a value can never split a header. */
export const headerSafe = (value: string): string => value.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();

/** Address without a display name; the domain must look like a real, dotted domain. */
const STRICT_ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
/** `From` may use a bare host such as `no-reply@localhost` (the schema default). */
const FROM_ADDRESS_RE = /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/;

const hasLineBreak = (value: string) => /[\r\n\u0000]/.test(value);

/** Validates a recipient and returns the trimmed address. Throws a 422 for anything suspicious. */
export function normalizeRecipient(value: string): string {
  const address = value.trim();
  if (!address || address.length > 254 || hasLineBreak(value) || !STRICT_ADDRESS_RE.test(address)) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "to must be a valid email address", { param_name: "to" });
  }
  return address;
}

function formatAddress(name: string | undefined, address: string): string {
  if (!name) return address;
  return `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}" <${address}>`;
}

/**
 * Accepts `address` or `Display Name <address>`. Display names are stripped of control characters and re-quoted,
 * so `email.from` can never inject an extra header.
 */
export function parseEmailFrom(value: string, paramName = "email.from"): { address: string; value: string } {
  const invalid = (why: string) =>
    new OrbitError(422, ErrorCodes.form_param_format_invalid, `${paramName} ${why}`, { param_name: paramName });
  const raw = value.trim();
  if (!raw) throw invalid("is empty");
  if (hasLineBreak(raw) || raw.length > 320) throw invalid("must not contain line breaks");
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(raw);
  let address: string;
  let name: string | undefined;
  if (match) {
    name = headerSafe(match[1]!.replace(/^"|"$/g, ""));
    address = match[2]!.trim();
  } else address = raw;
  if (!FROM_ADDRESS_RE.test(address) || address.length > 254) throw invalid("must contain an email address");
  return { address, value: formatAddress(name || undefined, address) };
}

// ───────────── SMTP URL validation ─────────────

export interface SmtpConnection { smtpUrl: string; host: string; port: number; secure: boolean; user?: string; pass?: string }

/** Parses and validates an SMTP URL (`smtp://` or `smtps://` only). Never returns TLS-disabling options. */
export function parseSmtpUrl(value: string, paramName = "email.smtpUrl"): SmtpConnection {
  const raw = value.trim();
  const invalid = (why: string) => new OrbitError(422, ErrorCodes.form_param_format_invalid, `${paramName} ${why}`, { param_name: paramName });
  if (!raw) throw invalid("is empty");
  if (hasLineBreak(raw)) throw invalid("must not contain line breaks");
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw invalid("must be a smtp:// or smtps:// URL");
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") throw invalid("must be a smtp:// or smtps:// URL");
  if (!url.hostname) throw invalid("must include a host");
  if (url.pathname && url.pathname !== "/") throw invalid("must not include a path");
  if (url.search || url.hash) throw invalid("must not include a query or fragment");
  const secure = url.protocol === "smtps:";
  const port = url.port ? Number(url.port) : secure ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw invalid("has an invalid port");
  let user: string | undefined;
  let pass: string | undefined;
  try {
    user = url.username ? decodeURIComponent(url.username) : undefined;
    pass = url.password ? decodeURIComponent(url.password) : undefined;
  } catch {
    throw invalid("has an invalid username or password encoding");
  }
  return { smtpUrl: raw, host: url.hostname, port, secure, user, pass };
}

/** Splits `user:pass@host:port` into a URL safe to log or show: credentials removed. */
export function redactSmtpUrl(value: string): string {
  try {
    const url = new URL(value.trim());
    url.username = "";
    url.password = "";
    return url.toString().replace(/\/$/, "");
  } catch {
    return "";
  }
}

// ───────────── provider resolution ─────────────

const DEFAULT_FROM = "OrbitID <no-reply@localhost>";

/**
 * Picks the transport from settings, falling back to the environment only where the setting is empty.
 * Explicit `email.provider` wins; `auto` uses Resend when a key exists, else SMTP, else the console.
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

/** Startup banner lines describing how email leaves this instance, warnings included. */
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
  if (transport.provider === "console" && ctx.env.nodeEnv === "production") {
    return [
      "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
      "  !! EMAIL IS PRINTED TO THIS LOG, NOT DELIVERED.                                   !!",
      "  !! Sign-in codes and magic links appear in plain text, so anyone who can read      !!",
      "  !! this log can sign in as your users.                                             !!",
      "  !! Fix it: set email.provider=resend with an API key (ORBITID_RESEND_API_KEY)      !!",
      "  !! or email.smtpUrl (ORBITID_SMTP_URL). See docs/EMAIL.md.                         !!",
      "  !!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!",
    ];
  }
  return [`  Email           : console (printed to the server log)`];
}

// ───────────── rendering ─────────────

const escapeHtml = (v: string) =>
  v.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const display = (v: string | number | undefined, fallback = "") => (v === undefined || v === null || v === "" ? fallback : String(v));

/** Only absolute http(s) URLs may become clickable in an email; anything else (javascript:, data:, …) is dropped. */
function safeHttpUrl(value: string): string | undefined {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : undefined;
  } catch {
    return undefined;
  }
}

interface RenderedEmail { subject: string; text: string; html: string }

function renderEmail(template: EmailTemplate, rawVars: SendEmailInput["vars"], appName: string, primaryColor: string): RenderedEmail {
  // Variables are untrusted (names, organization names, user agents). They never carry line breaks and the templates
  // only ever place them through escapeHtml, so neither the subject nor the body can be injected into.
  const vars: SendEmailInput["vars"] = {};
  for (const [key, value] of Object.entries(rawVars)) {
    vars[key] = typeof value === "string" ? value.replace(/[\r\n]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "") : value;
  }
  const code = display(vars.code);
  const link = safeHttpUrl(display(vars.link ?? vars.invitation_url ?? vars.url)) ?? "";
  const minutes = display(vars.expires_in_minutes, "10");
  const greeting = vars.user_name ? `Hi ${display(vars.user_name)},` : "Hello,";
  const brand = headerSafe(appName) || "OrbitID";

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
    case "test_email":
      subject = `${brand} test email`;
      intro = `This is a test email from ${brand}.`;
      body = "If you received it, email delivery from this instance works.";
      break;
    default:
      subject = brand;
      intro = greeting;
      body = "";
  }

  const safeSubject = headerSafe(subject);
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
  return { subject: safeSubject, text: textParts.join("\n"), html };
}

// ───────────── transports ─────────────

const RESEND_ENDPOINT = "https://api.resend.com/emails";
let resendEndpoint = RESEND_ENDPOINT;

/**
 * Internal test seam: points Resend calls at a local server. There is deliberately no setting or environment
 * variable for this, so a deployed instance always talks to the real API over HTTPS.
 */
export function setResendEndpointForTests(url: string | null): void {
  if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
    throw new Error("setResendEndpointForTests is only available in tests");
  }
  resendEndpoint = url ?? RESEND_ENDPOINT;
}

/** Provider response bodies are echoed back to the operator: redact the key, flatten and cap the text. */
function safeProviderDetail(body: string, apiKey: string): string {
  let detail = body.replace(/[\r\n\t]+/g, " ").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (apiKey) detail = detail.split(apiKey).join("[redacted]");
  return detail.slice(0, 300);
}

async function sendViaResend(transport: ResolvedEmailTransport, message: { to: string; subject: string; text: string; html: string }): Promise<void> {
  let response: Response;
  try {
    response = await fetch(resendEndpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${transport.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: transport.from,
        to: message.to,
        subject: message.subject,
        html: message.html,
        text: message.text,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    const name = (error as { name?: string } | undefined)?.name;
    const timedOut = name === "TimeoutError" || name === "AbortError";
    throw new OrbitError(502, "email_delivery_failed", timedOut ? "Resend did not respond within 10 seconds" : "Could not reach Resend");
  }
  if (response.ok) return;
  const detail = safeProviderDetail(await response.text().catch(() => ""), transport.resendApiKey ?? "");
  throw new OrbitError(502, "email_delivery_failed", `Resend rejected the email (HTTP ${response.status})${detail ? `: ${detail}` : ""}`);
}

function transporterFor(smtpUrl: string): Transporter {
  let t = transporters.get(smtpUrl);
  if (!t) {
    const conn = parseSmtpUrl(smtpUrl);
    t = nodemailer.createTransport({
      host: conn.host,
      port: conn.port,
      secure: conn.secure,
      // TLS is always verified and STARTTLS is always used when the server offers it; nothing here can turn that off.
      // With credentials we also require STARTTLS, so a password is never sent over a stripped connection.
      ignoreTLS: false,
      requireTLS: Boolean(conn.user),
      tls: { rejectUnauthorized: true, minVersion: "TLSv1.2" },
      auth: conn.user ? { user: conn.user, pass: conn.pass ?? "" } : undefined,
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      disableFileAccess: true,
      disableUrlAccess: true,
    });
    transporters.set(smtpUrl, t);
  }
  return t;
}

/** Hands a rendered message to the configured transport. Throws a secret-free OrbitError on failure. */
async function deliver(ctx: AppContext, transport: ResolvedEmailTransport, message: { to: string; subject: string; text: string; html: string }): Promise<void> {
  if (transport.provider === "resend") return sendViaResend(transport, message);
  if (transport.provider === "smtp") {
    try {
      await transporterFor(transport.smtpUrl!).sendMail({ from: transport.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
    } catch (error) {
      // nodemailer errors name the host and the server's reply; make sure a stray password never rides along.
      const password = parseSmtpUrl(transport.smtpUrl!).pass ?? "";
      const detail = safeProviderDetail((error as Error)?.message ?? "", password);
      throw new OrbitError(502, "email_delivery_failed", `SMTP delivery failed${detail ? `: ${detail}` : ""}`);
    }
    return;
  }
  if (ctx.env.nodeEnv !== "test" && !process.env.VITEST) {
    console.log(`\n[orbitid:mail] console transport to=${message.to}\n${message.subject}\n${message.text}\n`);
  }
}

// ───────────── public send API ─────────────

function record(email: SentEmail, ctx: AppContext): void {
  if (ctx.env.nodeEnv === "production") return;
  outbox.push(email);
  if (outbox.length > 500) outbox.splice(0, outbox.length - 500);
}

export async function sendEmail(ctx: AppContext, input: SendEmailInput): Promise<void> {
  const settings = ctx.settings.get();
  let email: SentEmail | undefined;
  try {
    const to = normalizeRecipient(input.to);
    const rendered = renderEmail(input.template, input.vars, settings.application.name, settings.branding.primaryColor);
    email = { to, template: input.template, ...rendered, vars: input.vars, sentAt: Date.now() };
    record(email, ctx);
    if (transportOverride) await transportOverride(email);
    else await deliver(ctx, resolveEmailTransport(ctx), { to, ...rendered });
  } catch (error) {
    // Delivery failures must not break the auth flow; the email stays in the outbox for debugging. The message is
    // ours (or already redacted by the transport), so it is safe to log and helps operators spot a misconfiguration.
    if (ctx.env.nodeEnv !== "test" && !process.env.VITEST) {
      const reason = error instanceof OrbitError ? `: ${error.message}` : "";
      console.error(`[orbitid:mail] failed to deliver "${input.template}" email${reason}`);
    }
  }
  await emitEvent(ctx, "email.created", {
    object: "email",
    to: email?.to ?? headerSafe(input.to),
    template: input.template,
    subject: email?.subject ?? "",
    created_at: email?.sentAt ?? Date.now(),
  });
}

/**
 * Sends a test message and reports the provider. Unlike `sendEmail` this throws (with a safe message) so the
 * admin endpoint can return a 502 when the operator's configuration does not work.
 */
export async function sendTestEmail(ctx: AppContext, to: string): Promise<{ provider: EmailProvider }> {
  const recipient = normalizeRecipient(to);
  const transport = resolveEmailTransport(ctx);
  const settings = ctx.settings.get();
  const rendered = renderEmail("test_email", {}, settings.application.name, settings.branding.primaryColor);
  record({ to: recipient, template: "test_email", ...rendered, vars: {}, sentAt: Date.now() }, ctx);
  await deliver(ctx, transport, { to: recipient, ...rendered });
  await emitEvent(ctx, "email.created", { object: "email", to: recipient, template: "test_email", subject: rendered.subject, created_at: Date.now() });
  return { provider: transport.provider };
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
