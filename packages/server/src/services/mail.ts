// OWNER: worker "core" (W1). nodemailer via settings.email.smtpUrl, falls back to console logging; HTML templates; SMS via settings.sms.
import type { AppContext } from "../context";

export type EmailTemplate =
  | "verification_code" | "magic_link" | "reset_password_code" | "invitation" | "organization_invitation" | "password_changed" | "new_sign_in" | "waitlist_invited" | "domain_verification_code";
export interface SendEmailInput { to: string; template: EmailTemplate; vars: Record<string, string | number | undefined> }

export async function sendEmail(_ctx: AppContext, _input: SendEmailInput): Promise<void> {
  throw new Error("not implemented: sendEmail (W1)");
}
export async function sendSms(_ctx: AppContext, _to: string, _body: string): Promise<void> {
  throw new Error("not implemented: sendSms (W1)");
}
