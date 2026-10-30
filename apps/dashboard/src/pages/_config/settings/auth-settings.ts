import { type InstanceSettings } from "@orbitid/shared";
import { isMaskedSecret, secretIsConfigured } from "./patch";

export type AttributeKey = keyof InstanceSettings["attributes"];

export interface AttributeProblem {
  /** Attribute the problem belongs to, or `null` for the sign-in setup as a whole. */
  attribute: AttributeKey | null;
  message: string;
}

const ATTRIBUTE_NAMES: Record<AttributeKey, string> = {
  emailAddress: "Email address",
  phoneNumber: "Phone number",
  username: "Username",
  firstName: "First name",
  lastName: "Last name",
  password: "Password",
  passkey: "Passkeys",
  backupCode: "Backup codes",
  authenticatorApp: "Authenticator app",
};

/**
 * Combinations of identifier settings the server would accept but that cannot work: a required attribute
 * that is switched off (nobody can ever supply it), a verified-at-sign-up attribute with no way to verify it,
 * or an instance with no usable way to sign in at all. The dashboard refuses to save these.
 */
export function attributeProblems(settings: InstanceSettings): AttributeProblem[] {
  const problems: AttributeProblem[] = [];
  const { attributes } = settings;
  const name = (key: AttributeKey) => ATTRIBUTE_NAMES[key];

  for (const key of Object.keys(attributes) as AttributeKey[]) {
    const config = attributes[key];
    if (config.required && !config.enabled) {
      problems.push({
        attribute: key,
        message: `${name(key)} is required but turned off. Turn it on, or make it optional.`,
      });
    }
  }

  for (const key of ["emailAddress", "phoneNumber"] as const) {
    const config = attributes[key];
    if (!config.enabled) continue;
    if (config.verifyAtSignUp && config.verifications.length === 0) {
      problems.push({
        attribute: key,
        message: `${name(key)} is verified at sign-up but has no verification method. Pick one, or turn off verification at sign-up.`,
      });
    }
  }

  if (attributes.phoneNumber.usedForSecondFactor && !attributes.phoneNumber.enabled) {
    problems.push({ attribute: "phoneNumber", message: "SMS code is a second factor, but phone numbers are turned off." });
  }

  const password = attributes.password.enabled;
  const identifierSignIn = (["emailAddress", "phoneNumber"] as const).some((key) => {
    const config = attributes[key];
    return config.enabled && config.usedForFirstFactor && (password || config.verifications.length > 0);
  });
  const usernameSignIn = attributes.username.enabled && attributes.username.usedForFirstFactor && password;
  const passkeySignIn = attributes.passkey.enabled && attributes.passkey.usedForFirstFactor;
  const socialSignIn = Object.values(settings.social).some((provider) => provider.enabled && provider.authenticatableAtSignIn !== false);
  if (!identifierSignIn && !usernameSignIn && !passkeySignIn && !socialSignIn && !settings.anonymous.enabled) {
    problems.push({
      attribute: null,
      message:
        "Users would have no way to sign in. Accept an identifier for sign-in with a password or a verification method, or turn on passkeys or a social connection.",
    });
  }

  return problems;
}

/* ------------------------------------------------------------------------------------------------
 * Email delivery
 * ---------------------------------------------------------------------------------------------- */

export type EmailProviderSetting = InstanceSettings["email"]["provider"];
export type EffectiveEmailProvider = "resend" | "smtp" | "console";

export interface ResolvedEmailProvider {
  /** Transport that will actually be used, mirroring the server's `auto` resolution. */
  provider: EffectiveEmailProvider;
  /** The setting as stored. */
  setting: EmailProviderSetting;
  /** Set when the choice comes from `auto` rather than an explicit setting. */
  automatic: boolean;
  /**
   * Set when the provider cannot work as configured, for example `resend` without a key.
   * The server rejects such a send with a 422 instead of falling back.
   */
  missing: "resendApiKey" | "smtpUrl" | null;
}

/**
 * Which transport the server will use, from the stored settings. `auto` picks the first configured
 * transport and otherwise refuses delivery. Environment variables fill in an empty setting, so
 * a field may still be configured on the server while this reports it as missing.
 */
export function resolveEmailProvider(email: InstanceSettings["email"]): ResolvedEmailProvider {
  const hasResend = secretIsConfigured(email.resendApiKey);
  const hasSmtp = secretIsConfigured(email.smtpUrl);
  if (email.provider === "resend") return { provider: "resend", setting: "resend", automatic: false, missing: hasResend ? null : "resendApiKey" };
  if (email.provider === "smtp") return { provider: "smtp", setting: "smtp", automatic: false, missing: hasSmtp ? null : "smtpUrl" };
  if (email.provider === "console") return { provider: "console", setting: "console", automatic: false, missing: null };
  const provider: EffectiveEmailProvider = hasResend ? "resend" : hasSmtp ? "smtp" : "console";
  return { provider, setting: "auto", automatic: true, missing: null };
}

export const EMAIL_PROVIDER_LABELS: Record<EffectiveEmailProvider, string> = {
  resend: "Resend",
  smtp: "SMTP",
  console: "Not configured",
};

/** Label for a provider name reported by the server, falling back to the raw value. */
export function emailProviderLabel(provider: string | null | undefined): string {
  if (provider === "resend" || provider === "smtp" || provider === "console") return EMAIL_PROVIDER_LABELS[provider];
  return provider || "Unknown transport";
}

/** Mirrors the server's `parseEmailFrom`: an address, or `Display Name <address>`, and never a line break. */
export function emailFromError(value: string): string | null {
  const raw = value.trim();
  if (!raw) return "From address is required. Mail cannot be sent without one.";
  if (/[\r\n\u0000]/.test(raw)) return "From address must not contain line breaks.";
  if (raw.length > 320) return "From address is too long; keep it under 320 characters.";
  const match = /^(.*?)\s*<([^<>]+)>$/.exec(raw);
  const address = (match ? match[2]! : raw).trim();
  if (!/^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9.-]{0,253}[A-Za-z0-9])?$/.test(address) || address.length > 254) {
    return "From address must contain an email address, for example OrbitID <no-reply@example.com>.";
  }
  return null;
}

/** Mirrors the server's `parseSmtpUrl`: `smtp://` (STARTTLS) or `smtps://` (implicit TLS), host and port only. */
export function smtpUrlError(value: string): string | null {
  const raw = value.trim();
  // A stored URL comes back masked; there is nothing to validate until the operator types a replacement.
  if (!raw || isMaskedSecret(raw)) return null;
  if (/[\r\n]/.test(raw)) return "SMTP URL must not contain line breaks.";
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return "SMTP URL must be a smtp:// or smtps:// URL with a host and a port below 65535, for example smtp://user:pass@mail.example.com:587.";
  }
  if (url.protocol !== "smtp:" && url.protocol !== "smtps:") return "SMTP URL must start with smtp:// or smtps://.";
  if (!url.hostname) return "SMTP URL must include a host.";
  if (url.pathname && url.pathname !== "/") return "SMTP URL must not include a path.";
  if (url.search || url.hash) return "SMTP URL must not include a query or fragment.";
  const port = url.port ? Number(url.port) : url.protocol === "smtps:" ? 465 : 587;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) return "SMTP URL has an invalid port.";
  return null;
}

/** Resend keys are `re_…`; a value with a line break is refused by the server. */
export function resendApiKeyError(value: string): string | null {
  if (isMaskedSecret(value)) return null;
  if (/[\r\n]/.test(value)) return "API key must not contain line breaks.";
  return null;
}

/* ------------------------------------------------------------------------------------------------
 * Social providers
 * ---------------------------------------------------------------------------------------------- */
