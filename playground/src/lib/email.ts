/**
 * Which mail transport an instance actually uses. Mirrors `resolveEmailTransport` in the server:
 * an explicit `email.provider` wins, and `auto` picks Resend, then SMTP, then the console.
 *
 * The Backend API masks secret values and adds a `<field>Set` marker next to them, so this module
 * only ever reads those booleans — it never sees or shows a key.
 */
export type EmailTransport = "resend" | "smtp" | "console";

export interface EmailSettingsSnapshot {
  provider?: string;
  /** `email.resendApiKeySet` from `GET /v1/instance`. */
  resendApiKeySet?: boolean;
  /** `email.smtpUrlSet` from `GET /v1/instance`. */
  smtpUrlSet?: boolean;
}

export interface ResolvedEmailTransport {
  provider: EmailTransport;
  /** True when `email.provider` is `auto` and the transport was inferred from the credentials. */
  automatic: boolean;
  /** Credential the explicit provider needs but does not have. */
  missing: "resendApiKey" | "smtpUrl" | null;
}

export const EMAIL_TRANSPORT_LABELS: Record<EmailTransport, string> = {
  resend: "Resend",
  smtp: "SMTP",
  console: "Print to server log",
};

export function resolveEmailTransport(email: EmailSettingsSnapshot): ResolvedEmailTransport {
  const hasResend = email.resendApiKeySet === true;
  const hasSmtp = email.smtpUrlSet === true;
  if (email.provider === "resend") {
    return { provider: "resend", automatic: false, missing: hasResend ? null : "resendApiKey" };
  }
  if (email.provider === "smtp") {
    return { provider: "smtp", automatic: false, missing: hasSmtp ? null : "smtpUrl" };
  }
  if (email.provider === "console") return { provider: "console", automatic: false, missing: null };
  const provider: EmailTransport = hasResend ? "resend" : hasSmtp ? "smtp" : "console";
  return { provider, automatic: true, missing: null };
}

/** One sentence naming what delivers mail and where the choice came from. */
export function describeEmailTransport(resolved: ResolvedEmailTransport): string {
  const source = resolved.automatic ? "Inferred from the stored credentials." : "Set explicitly in the email settings.";
  if (resolved.missing) {
    const field = resolved.missing === "resendApiKey" ? "an API key" : "an SMTP URL";
    return `${source} Sending fails until ${field} is saved in the dashboard.`;
  }
  if (resolved.provider === "console") {
    return `${source} Codes and links are printed to the server log, which is for local development only.`;
  }
  return source;
}

const TRANSPORTS: EmailTransport[] = ["resend", "smtp", "console"];

function isTransport(value: unknown): value is EmailTransport {
  return typeof value === "string" && (TRANSPORTS as string[]).includes(value);
}

/**
 * The public environment does not document a mail field today; this reads one if a future version adds it,
 * so the matrix prefers `GET /v1/client/environment` over the secret-key call as soon as that is possible.
 * Only a transport name is read — never a credential.
 */
export function emailFromEnvironment(environment: unknown): EmailSettingsSnapshot | null {
  if (!environment || typeof environment !== "object") return null;
  const env = environment as Record<string, unknown>;
  const email = env.email;
  const record = email && typeof email === "object" && !Array.isArray(email) ? (email as Record<string, unknown>) : null;
  const provider = record?.provider ?? env.email_provider ?? env.emailProvider;
  if (isTransport(provider)) return { provider };
  // A resolved provider with no setting behind it: report it as explicit so the row does not claim "inferred".
  return null;
}
