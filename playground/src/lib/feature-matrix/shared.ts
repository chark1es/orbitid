import type { EnvironmentJSON } from "@orbitid/shared";

export const IDENTIFIERS: Array<{ key: string; label: string }> = [
  { key: "email_address", label: "Email address" },
  { key: "phone_number", label: "Phone number" },
  { key: "username", label: "Username" },
];

const VERIFICATION_LABELS: Record<string, string> = {
  email_code: "email code",
  email_link: "email link",
  phone_code: "SMS code",
};

export const FIRST_FACTORS: Array<{ factor: string; label: string; value: string; detail: string }> = [
  { factor: "password", label: "Password", value: "Password accepted at sign-in", detail: "Checked against the instance password policy." },
  { factor: "email_code", label: "Email code", value: "Code sent to the email address", detail: "The code is delivered by the instance mail settings." },
  { factor: "email_link", label: "Email link", value: "Link sent to the email address", detail: "The link returns to the app with a verification token." },
  { factor: "phone_code", label: "SMS code", value: "Code sent to the phone number", detail: "The instance SMS provider delivers the code." },
  { factor: "passkey", label: "Passkey", value: "WebAuthn passkey accepted", detail: "The browser holds the credential for this site's origin." },
  { factor: "enterprise_sso", label: "Enterprise SSO", value: "No connection", detail: "Create an enterprise connection and verify its domains in the dashboard." },
];

export const SECOND_FACTORS: Array<{ factor: string; label: string; value: string; detail: string }> = [
  { factor: "totp", label: "Authenticator app", value: "TOTP codes accepted", detail: "Users enroll from the account page security tab." },
  { factor: "phone_code", label: "SMS code", value: "Codes sent to the phone number", detail: "Requires the phone number attribute and an SMS provider." },
  { factor: "email_code", label: "Email code", value: "Codes sent to the email address", detail: "Never offered when the first factor was an email code or link, so one mailbox cannot satisfy both steps." },
  { factor: "backup_code", label: "Backup codes", value: "Single-use recovery codes accepted", detail: "Ten codes are issued when a user enables them." },
];

type AttributeJSON = EnvironmentJSON["user_settings"]["attributes"][string];

export function attribute(env: EnvironmentJSON, key: string): AttributeJSON | undefined {
  return env.user_settings?.attributes?.[key];
}

export function enabledWords(attr: AttributeJSON | undefined): string {
  if (!attr) return "Not collected";
  const requirement = attr.required ? "Required" : "Optional";
  const verification = attr.verify_at_sign_up ? "verified at sign-up" : "no verification at sign-up";
  return `${requirement}, ${verification}`;
}

export function verificationDetail(attr: AttributeJSON | undefined): string | undefined {
  const list = attr?.verifications ?? [];
  if (!list.length) return undefined;
  const words = list.map((item) => VERIFICATION_LABELS[item] ?? item);
  return `Verification: ${words.join(", ")}.`;
}
