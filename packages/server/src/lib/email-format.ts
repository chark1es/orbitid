// Pure e-mail address and SMTP URL validation.
//
// These live outside `services/mail` so the settings policy can reject an unusable configuration without
// importing the delivery module (which owns transports, credentials and the test capture seam).
import { ErrorCodes, OrbitError } from "@orbitid/shared";

/** Default `From` used when neither the stored settings nor the environment name one. */
export const DEFAULT_FROM = "OrbitID <no-reply@localhost>";

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
