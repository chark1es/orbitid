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
import { headerSafe, normalizeRecipient, parseEmailFrom, parseSmtpUrl, redactSmtpUrl } from "../../lib/email-format";
import { audit } from "../audit";
import { emitEvent } from "../webhooks";
import type { EmailTemplate, SendEmailInput } from "./core";

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

export function renderEmail(template: EmailTemplate, rawVars: SendEmailInput["vars"], appName: string, primaryColor: string): RenderedEmail {
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
