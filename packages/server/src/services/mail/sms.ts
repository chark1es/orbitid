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
  isTestEnvironment, smsOutbox, smsOverride, type EmailDeliveryResult,
} from "./core";

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

/**
 * SMS delivery (Twilio REST or an operator webhook). Like email, there is no console or file fallback: without a
 * provider the message is not delivered, and the code never appears in the log or on disk.
 */
export async function sendSms(ctx: AppContext, to: string, body: string): Promise<EmailDeliveryResult> {
  if (isTestEnvironment()) {
    smsOutbox.push({ to, body, sentAt: Date.now() });
    if (smsOutbox.length > 500) smsOutbox.splice(0, smsOutbox.length - 500);
  }
  const settings = ctx.settings.get();
  let result: EmailDeliveryResult = { delivered: true };
  try {
    if (smsOverride) await smsOverride(to, body);
    else if (settings.sms.provider === "twilio") await sendViaTwilio(ctx, to, body);
    else if (settings.sms.provider === "webhook") await sendViaWebhook(ctx, to, body);
    else if (!isTestEnvironment()) {
      throw new OrbitError(503, "sms_not_configured", "SMS is not configured, so nothing was sent. Choose Twilio or a webhook in the dashboard.");
    }
  } catch (error) {
    // As with email: the caller gets a typed outcome and the audit log gets a recipient-free reason. Nothing about
    // a sign-in message (code, number, provider response) is written to the console.
    const code = error instanceof OrbitError ? String(error.code) : "sms_delivery_failed";
    result = { delivered: false, error: { code, message: error instanceof OrbitError ? error.message : "SMS delivery failed." } };
    await audit(ctx, { actor: "system", action: "sms.delivery_failed", targetType: "sms", targetId: null, metadata: { code } });
  }
  // The event names who was messaged, never the code inside the message.
  await emitEvent(ctx, "sms.created", { object: "sms", to, created_at: Date.now() });
  return result;
}
