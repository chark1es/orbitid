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
import {
  isTestEnvironment, outbox, resolveEmailTransport, transportOverride, transporters,
  type EmailDeliveryResult, type EmailProvider, type ResolvedEmailTransport, type SendEmailInput, type SentEmail,
} from "./core";
import { renderEmail } from "./render";

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

/**
 * Hands a rendered message to the configured transport. Throws a secret-free OrbitError on failure.
 *
 * `console` means "no provider configured": outside tests there is no delivery and no fallback that would
 * print or persist the message, so it throws. The test suite captures through the in-memory outbox.
 */
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
  // No provider, no delivery — not even under test. Tests read the recorded message from the outbox and the
  // auth flow carries on (see `sendEmail`), so the failure path itself is exercised in every test.
  throw new OrbitError(
    503,
    "email_not_configured",
    "Email is not configured, so nothing was sent. Set email.resendApiKey or email.smtpUrl (or ORBITID_RESEND_API_KEY / ORBITID_SMTP_URL).",
  );
}

// ───────────── public send API ─────────────

/** Records into the test outbox only: a deployed server keeps no copy of a message. */
function record(email: SentEmail): void {
  if (!isTestEnvironment()) return;
  outbox.push(email);
  if (outbox.length > 500) outbox.splice(0, outbox.length - 500);
}

export async function sendEmail(ctx: AppContext, input: SendEmailInput): Promise<EmailDeliveryResult> {
  const settings = ctx.settings.get();
  let email: SentEmail | undefined;
  let result: EmailDeliveryResult = { delivered: true };
  try {
    const to = normalizeRecipient(input.to);
    const rendered = renderEmail(input.template, input.vars, settings.application.name, settings.branding.primaryColor);
    email = { to, template: input.template, ...rendered, vars: input.vars, sentAt: Date.now() };
    record(email);
    if (transportOverride) await transportOverride(email);
    else await deliver(ctx, resolveEmailTransport(ctx), { to, ...rendered });
  } catch (error) {
    // Delivery failures must not break the auth flow, and they must not be narrated to the console: the log is
    // shared and long-lived, and a delivery error is the one place a code or link could still surface. The typed
    // reason goes back to the caller and into the audit log (template + code only, never the recipient or body).
    const code = error instanceof OrbitError ? String(error.code) : "email_delivery_failed";
    result = { delivered: false, error: { code, message: error instanceof OrbitError ? error.message : "Email delivery failed." } };
    await audit(ctx, {
      actor: "system",
      action: "email.delivery_failed",
      targetType: "email",
      targetId: null,
      metadata: { template: input.template, code },
    });
  }
  // The event says a message was created, for whom and from which template. It never repeats the subject: for a
  // code template the subject *is* the code ("123456 is your OrbitID verification code"), so echoing it would
  // hand the credential to every webhook endpoint the operator has configured.
  await emitEvent(ctx, "email.created", {
    object: "email",
    to: email?.to ?? headerSafe(input.to),
    template: input.template,
    created_at: email?.sentAt ?? Date.now(),
  });
  return result;
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
  record({ to: recipient, template: "test_email", ...rendered, vars: {}, sentAt: Date.now() });
  await deliver(ctx, transport, { to: recipient, ...rendered });
  await emitEvent(ctx, "email.created", { object: "email", to: recipient, template: "test_email", subject: rendered.subject, created_at: Date.now() });
  return { provider: transport.provider };
}
