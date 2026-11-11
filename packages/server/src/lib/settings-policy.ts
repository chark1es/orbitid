// Server-side policy for instance settings.
//
// The dashboard round-trips a whole settings object, so without this a save could enable a sign-in method
// whose provider is not configured: sign-up and sign-in would then fail silently (or a production instance
// would try to mail codes through a transport that cannot deliver them). Every write goes through
// `normalizeSettings` + `assertSettingsUsable`, so the stored tree is always one the server can act on.
import { ErrorCodes, OrbitError, type InstanceSettings } from "@orbitid/shared";
import { DEFAULT_FROM, parseEmailFrom, parseSmtpUrl } from "./email-format";

/** Environment fallbacks the mail resolver honours when the matching setting is empty. */
export interface DeliveryEnvironment {
  resendApiKey?: string;
  smtpUrl?: string;
  emailFrom?: string;
}

const isTestEnvironment = () => !!process.env.VITEST || process.env.NODE_ENV === "test";

const invalid = (param: string, message: string) =>
  new OrbitError(422, ErrorCodes.form_param_format_invalid, message, { param_name: param });

/** Attributes that, when required or used as a factor, must also be enabled. */
function assertAttributeConsistency(settings: InstanceSettings): void {
  const attributes = settings.attributes as Record<string, { enabled: boolean; required: boolean; usedForFirstFactor: boolean; usedForSecondFactor: boolean }>;
  for (const [name, attr] of Object.entries(attributes)) {
    const param = `attributes.${name}`;
    if (attr.required && !attr.enabled) throw invalid(param, `${param}.required needs ${param}.enabled: a required field that is disabled can never be satisfied`);
    if (attr.usedForFirstFactor && !attr.enabled) throw invalid(param, `${param}.usedForFirstFactor needs ${param}.enabled`);
    if (attr.usedForSecondFactor && !attr.enabled) throw invalid(param, `${param}.usedForSecondFactor needs ${param}.enabled`);
  }
}

/** `provider: "smtp"` must name a usable SMTP URL; `resend` must have a key. A value may come from the
 * environment, exactly as the mail resolver falls back to it at delivery time. */
function assertEmailTransportShape(settings: InstanceSettings, env: DeliveryEnvironment): void {
  const email = settings.email;
  // Empty means "use ORBITID_EMAIL_FROM, then the default" — only a non-empty override has to parse.
  const settingFrom = email.from.trim() && email.from !== DEFAULT_FROM ? email.from : "";
  const from = settingFrom || env.emailFrom?.trim() || DEFAULT_FROM;
  parseEmailFrom(from);
  const smtpUrl = email.smtpUrl.trim() || env.smtpUrl?.trim() || "";
  if (smtpUrl) parseSmtpUrl(smtpUrl);
  if (email.provider === "smtp" && !smtpUrl) {
    throw invalid("email.provider", "email.provider is smtp but no SMTP URL is configured. Set email.smtpUrl or ORBITID_SMTP_URL.");
  }
  if (email.provider === "resend" && !(email.resendApiKey.trim() || env.resendApiKey?.trim())) {
    throw invalid("email.provider", "email.provider is resend but no API key is configured. Set email.resendApiKey or ORBITID_RESEND_API_KEY.");
  }
}

function assertSmsTransportShape(settings: InstanceSettings): void {
  const sms = settings.sms;
  if (sms.provider === "twilio") {
    const missing = [
      !sms.twilioAccountSid.trim() ? "twilioAccountSid" : null,
      !sms.twilioAuthToken.trim() ? "twilioAuthToken" : null,
      !sms.twilioFrom.trim() ? "twilioFrom" : null,
    ].filter((field): field is string => !!field);
    if (missing.length) {
      throw invalid("sms.provider", `sms.provider is twilio but ${missing.map((field) => `sms.${field}`).join(", ")} ${missing.length === 1 ? "is" : "are"} empty.`);
    }
  }
  if (sms.provider === "webhook" && !sms.webhookUrl.trim()) {
    throw invalid("sms.provider", "sms.provider is webhook but sms.webhookUrl is empty.");
  }
  if (sms.webhookUrl.trim() && !/^https:\/\/[^\s]+$/i.test(sms.webhookUrl.trim())) {
    throw invalid("sms.webhookUrl", "sms.webhookUrl must be an absolute https URL that receives the code.");
  }
}

/**
 * A social provider that is on must be usable: id + secret (Apple may use a .p8 key), a custom provider a
 * discovery URL or manual endpoints. URLs must be absolute https, except in development mode where a plain-http
 * loopback provider (a local test IdP) is explicitly allowed — the same rule the fetcher applies before it connects.
 */
function assertSocialProviders(settings: InstanceSettings): void {
  const loopbackHosts = ["localhost", "127.0.0.1", "[::1]", "::1"];
  const urlShape = (raw: string, param: string) => {
    let url: URL;
    try {
      url = new URL(raw);
    } catch {
      throw invalid(param, `${param} must be an absolute URL.`);
    }
    const loopback = loopbackHosts.includes(url.hostname);
    // Shape only: plain http is accepted for a loopback host (a local test IdP) and must be https otherwise.
    // Whether that host is reachable is an SSRF decision made at request time, where DNS is actually resolved.
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
      throw invalid(param, `${param} must be an absolute https URL (plain http is only accepted for a loopback host).`);
    }
  };
  for (const [key, provider] of Object.entries(settings.social)) {
    if (!provider.enabled) continue;
    const param = `social.${key}`;
    const custom = key.startsWith("custom_");
    if (!provider.clientId.trim()) throw invalid(param, `${param} is enabled but has no clientId. Add the provider's client id or turn the provider off.`);
    const appleWithKey = key === "apple"
      && !!provider.appleTeamId?.trim() && !!provider.appleKeyId?.trim() && !!provider.applePrivateKey?.trim();
    // A custom provider may be a public client: PKCE, no secret. Every built-in provider needs a secret.
    const publicClient = custom && provider.pkce !== false && !provider.clientSecret.trim();
    if (!provider.clientSecret.trim() && !appleWithKey && !publicClient) {
      throw invalid(param, `${param} is enabled but has no clientSecret (or, for Apple, a team id, key id and private key).`);
    }
    if (custom) {
      const discovery = provider.discoveryUrl?.trim();
      if (!discovery && !(provider.authorizationUrl?.trim() && provider.tokenUrl?.trim())) {
        throw invalid(param, `${param} needs a discoveryUrl, or manual authorizationUrl and tokenUrl endpoints.`);
      }
      if (!discovery && provider.protocol === "oauth2" && !provider.userinfoUrl?.trim()) {
        throw invalid(param, `${param} is an OAuth 2.0 provider and needs a userinfoUrl to read the profile.`);
      }
      if (!discovery && provider.protocol !== "oauth2" && !provider.userinfoUrl?.trim() && !provider.jwksUrl?.trim()) {
        throw invalid(param, `${param} needs a userinfoUrl or a jwksUrl to identify the user.`);
      }
    }
    for (const field of ["discoveryUrl", "authorizationUrl", "tokenUrl", "userinfoUrl", "jwksUrl", "issuer", "logoUrl"] as const) {
      const raw = provider[field]?.trim();
      if (!raw) continue;
      const paramName = `${param}.${field}`;
      // `issuer` is an identifier, not necessarily a URL, but when it looks like one its scheme must be sane.
      if (field === "issuer" && !/^https?:\/\//i.test(raw)) {
        throw invalid(paramName, `${paramName} must be an absolute http(s) URL when set.`);
      }
      urlShape(raw, paramName);
    }
  }
}

function assertCaptcha(settings: InstanceSettings): void {
  const sec = settings.security;
  if (sec.captchaProvider === "none") return;
  if (!sec.captchaSecret.trim()) {
    throw invalid("security.captchaSecret", "security.captchaProvider is set but security.captchaSecret is empty; the server would reject every sign-in.");
  }
}

/** True when an enabled flow needs to send e-mail (codes, links, or verification at sign-up). */
export function emailDeliveryRequired(settings: InstanceSettings): boolean {
  const a = settings.attributes;
  return a.emailAddress.enabled
    && (a.emailAddress.usedForFirstFactor || a.emailAddress.usedForSecondFactor || a.emailAddress.verifyAtSignUp);
}

/** True when an enabled flow needs to send an SMS (a phone code as a first or second factor, or at sign-up). */
export function smsDeliveryRequired(settings: InstanceSettings): boolean {
  const a = settings.attributes;
  return a.phoneNumber.enabled && (a.phoneNumber.usedForFirstFactor || a.phoneNumber.usedForSecondFactor || a.phoneNumber.verifyAtSignUp);
}

/** The provider the mail resolver would pick: an explicit setting wins, otherwise Resend, then SMTP, then console. */
export function effectiveEmailProvider(settings: InstanceSettings, env: DeliveryEnvironment = {}): "resend" | "smtp" | "console" {
  const email = settings.email;
  if (email.provider === "resend" || email.provider === "smtp" || email.provider === "console") return email.provider;
  const resendApiKey = (email.resendApiKey || env.resendApiKey || "").trim();
  const smtpUrl = (email.smtpUrl || env.smtpUrl || "").trim();
  return resendApiKey ? "resend" : smtpUrl ? "smtp" : "console";
}

/**
 * Production cannot fall back to anything: the server never prints sign-in codes and never writes them to
 * disk, so a `console` transport means no code is delivered at all. Enabling an e-mail flow without a provider
 * in production would produce an instance that silently cannot sign anyone in, so the save is refused. The
 * check is skipped under test, where the in-memory outbox replaces delivery.
 */
function assertProductionDelivery(settings: InstanceSettings, nodeEnv: string, env: DeliveryEnvironment): void {
  if (nodeEnv !== "production" || isTestEnvironment()) return;
  if (emailDeliveryRequired(settings) && effectiveEmailProvider(settings, env) === "console") {
    throw invalid("email.provider", "E-mail sign-in is enabled but no e-mail provider is configured. Set email.resendApiKey or email.smtpUrl (or ORBITID_RESEND_API_KEY / ORBITID_SMTP_URL) before saving.");
  }
  if (smsDeliveryRequired(settings) && settings.sms.provider === "console") {
    throw invalid("sms.provider", "Phone sign-in is enabled but sms.provider is console. Configure Twilio or the SMS webhook before saving.");
  }
}

/**
 * Disabled features are locked: their sub-switches are forced off, so a stored settings tree can never claim
 * a capability the feature gate refuses at request time.
 */
export function normalizeSettings(settings: InstanceSettings): InstanceSettings {
  const next = settings;
  const attrs = next.attributes;
  if (!next.organizations.enabled) {
    next.organizations.creationEnabled = false;
    next.organizations.domainsEnabled = false;
    next.organizations.membershipRequestsEnabled = false;
    next.organizations.forceOrganizationSelection = false;
    next.userSettings.createOrganizationEnabled = false;
  } else if (!next.organizations.creationEnabled) {
    next.userSettings.createOrganizationEnabled = false;
  }
  // A disabled attribute cannot be required or used as a factor: the request path refuses it, so a stored
  // "required" flag would only produce impossible sign-ups.
  for (const attr of Object.values(attrs) as { enabled: boolean; required: boolean; usedForFirstFactor: boolean; usedForSecondFactor: boolean; verifyAtSignUp: boolean }[]) {
    if (attr.enabled) continue;
    attr.required = false;
    attr.usedForFirstFactor = false;
    attr.usedForSecondFactor = false;
    attr.verifyAtSignUp = false;
  }
  if (next.security.captchaProvider === "none") next.security.captchaSiteKey = "";
  return next;
}

/** Verification strategies an attribute may use; anything else would send codes the server cannot check. */
const EMAIL_STRATEGIES = new Set(["email_code", "email_link"]);
const PHONE_STRATEGIES = new Set(["phone_code"]);

/**
 * Required-field and provider prerequisites. A settings tree that asks the Frontend API for a factor it cannot
 * serve is rejected at save time: otherwise sign-in fails for every user with a generic error.
 */
function assertAttributesUsable(settings: InstanceSettings): void {
  const attrs = settings.attributes;
  const email = attrs.emailAddress;
  for (const strategy of email.verifications) {
    if (!EMAIL_STRATEGIES.has(strategy)) {
      throw invalid("attributes.emailAddress.verifications", `attributes.emailAddress.verifications contains "${strategy}"; only email_code and email_link are valid for an email address.`);
    }
  }
  for (const strategy of attrs.phoneNumber.verifications) {
    if (!PHONE_STRATEGIES.has(strategy)) {
      throw invalid("attributes.phoneNumber.verifications", `attributes.phoneNumber.verifications contains "${strategy}"; only phone_code is valid for a phone number.`);
    }
  }
  // A first/sign-up factor with no way to prove the identifier is an unserviceable configuration.
  if (email.enabled && (email.verifyAtSignUp || email.usedForFirstFactor || email.usedForSecondFactor) && email.verifications.length === 0) {
    throw invalid("attributes.emailAddress.verifications", "attributes.emailAddress needs at least one verification strategy (email_code or email_link) when it is verified, a first factor or a second factor.");
  }
  if (attrs.phoneNumber.enabled && (attrs.phoneNumber.usedForFirstFactor || attrs.phoneNumber.usedForSecondFactor) && attrs.phoneNumber.verifications.length === 0) {
    // Phone codes are the only phone strategy, so an empty list falls back to phone_code rather than failing.
    attrs.phoneNumber.verifications = ["phone_code"];
  }
  // Something has to be able to identify or authenticate a user for sign-in to work at all.
  const canSignIn = email.enabled
    || attrs.phoneNumber.enabled
    || attrs.username.enabled
    || attrs.password.enabled
    || attrs.passkey.enabled;
  if (!canSignIn) {
    throw invalid("attributes", "Every attribute is disabled, so nobody could sign up or sign in. Enable at least one of email address, phone number, username, password or passkey.");
  }
  // A required field that cannot be supplied by any request path is a locked door.
  if (attrs.password.enabled && attrs.password.required && !attrs.password.usedForFirstFactor && !email.enabled && !attrs.phoneNumber.enabled && !attrs.username.enabled && !attrs.passkey.enabled) {
    throw invalid("attributes.password", "A required password with no identifier cannot be created through sign-up.");
  }
}

/** Passwords must be longer than 1 and shorter than the bcrypt-safe maximum. */function assertPasswordPolicy(settings: InstanceSettings): void {
  const policy = settings.password;
  if (policy.minLength < 1 || policy.maxLength < policy.minLength || policy.maxLength > 72) {
    throw invalid("password", "password.maxLength must be between password.minLength and 72 (bcrypt's limit), and minLength at least 1.");
  }
}

/**
 * Session and JWT lifetimes. `session.lifetimeSeconds: 0` means "no maximum lifetime" and is the default;
 * a positive value is an absolute cap. The inactivity timeout is opt-in (`0` = disabled) and may exceed a
 * finite lifetime (it is then simply the weaker of the two). A token lifetime must be positive: a zero-lifetime
 * token could never be verified.
 */
function assertSessionPolicy(settings: InstanceSettings): void {
  const session = settings.session;
  if (session.lifetimeSeconds < 0) throw invalid("session.lifetimeSeconds", "session.lifetimeSeconds must be 0 (no maximum lifetime) or greater.");
  if (session.tokenLifetimeSeconds <= 0) throw invalid("session.tokenLifetimeSeconds", "session.tokenLifetimeSeconds must be greater than 0.");
  if (session.lifetimeSeconds > 0 && session.tokenLifetimeSeconds > session.lifetimeSeconds) {
    throw invalid("session.tokenLifetimeSeconds", "session.tokenLifetimeSeconds cannot exceed session.lifetimeSeconds.");
  }
  if (session.inactivityTimeoutSeconds < 0) throw invalid("session.inactivityTimeoutSeconds", "session.inactivityTimeoutSeconds must be 0 (disabled) or greater.");
}

/**
 * The two organization role settings are keys, not free text. An instance role or a missing key would make
 * every new membership fall back silently, so the save is refused instead.
 */
function assertOrganizationRoleSettings(settings: InstanceSettings): void {
  const orgs = settings.organizations;
  for (const [field, key] of [["creatorRole", orgs.creatorRole], ["defaultRole", orgs.defaultRole]] as const) {
    if (!key.startsWith("org:")) {
      throw invalid(`organizations.${field}`, `organizations.${field} must be an organization role key ("org:..."), not "${key}".`);
    }
  }
  if (orgs.maxAllowedMemberships < 0) throw invalid("organizations.maxAllowedMemberships", "organizations.maxAllowedMemberships must be 0 (no limit) or greater.");
  if (orgs.maxCreatedOrganizationsPerUser !== null && orgs.maxCreatedOrganizationsPerUser < 0) {
    throw invalid("organizations.maxCreatedOrganizationsPerUser", "organizations.maxCreatedOrganizationsPerUser must be null (no limit) or at least 0.");
  }
}

/** Throws a 422 naming the offending field when the settings cannot be served. */
export function assertSettingsUsable(
  settings: InstanceSettings,
  opts: { nodeEnv?: string; env?: DeliveryEnvironment } = {},
): void {
  const env = opts.env ?? {};
  assertAttributeConsistency(settings);
  assertAttributesUsable(settings);
  assertEmailTransportShape(settings, env);
  assertSmsTransportShape(settings);
  assertSocialProviders(settings);
  assertCaptcha(settings);
  assertPasswordPolicy(settings);
  assertSessionPolicy(settings);
  assertOrganizationRoleSettings(settings);
  assertProductionDelivery(settings, opts.nodeEnv ?? process.env.NODE_ENV ?? "development", env);
}
