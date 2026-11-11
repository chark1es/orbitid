import type { EnvironmentJSON } from "@orbitid/shared";
import {
  describeEmailTransport,
  emailFromEnvironment,
  EMAIL_TRANSPORT_LABELS,
  resolveEmailTransport,
} from "../email";
import { formatDuration } from "../format";
import { type FeatureRow, type InstanceSnapshot } from "./types";

export function organizationRows(env: EnvironmentJSON): FeatureRow[] {
  const org = env.organization_settings;
  const organizationsOn = Boolean(org?.enabled);
  const rows: FeatureRow[] = [
    {
      id: "organizations.enabled",
      label: "Organizations",
      status: organizationsOn ? "enabled" : "off",
      value: organizationsOn ? "On" : "Off",
      detail: organizationsOn ? `${org.max_allowed_memberships} memberships per user.` : undefined,
      tryHref: "/organizations",
    },
  ];
  if (!organizationsOn) return rows;
  rows.push(
    {
      id: "organizations.creation",
      label: "Organization creation",
      status: org.creation_enabled ? "enabled" : "off",
      value: org.creation_enabled ? "Users can create organizations" : "Creation disabled",
      tryHref: "/organizations",
    },
    {
      id: "organizations.domains",
      label: "Domain enrollment",
      status: org.domains_enabled ? "enabled" : "off",
      value: org.domains_enabled ? "Email domain join allowed" : "Not enabled",
      detail: org.domains_enabled ? "A verified domain lets matching email addresses join." : undefined,
      tryHref: "/organizations",
    },
    {
      id: "organizations.requests",
      label: "Membership requests",
      status: org.membership_requests_enabled ? "enabled" : "off",
      value: org.membership_requests_enabled ? "Users can request to join" : "Not enabled",
      tryHref: "/organizations",
    },
    {
      id: "organizations.roles",
      label: "Roles",
      status: "enabled",
      value: `Creator ${org.creator_role}, new members ${org.default_role}`,
      detail: `${org.slug_enabled ? "Slugs are used" : "Slugs are off"} for organization URLs.`,
      tryHref: "/organizations",
    },
  );
  return rows;
}

export function sessionRows(env: EnvironmentJSON, instance?: InstanceSnapshot): FeatureRow[] {
  const lifetime = instance?.session?.lifetimeSeconds;
  const tokenLifetime = instance?.session?.tokenLifetimeSeconds;
  const rows: FeatureRow[] = [
    {
      id: "session.lifetime",
      label: "Session lifetime",
      status: typeof lifetime === "number" ? "enabled" : "needs-config",
      value:
        typeof lifetime !== "number"
          ? "Not exposed by the public environment"
          : lifetime > 0
            ? formatDuration(lifetime)
            : "No maximum (until sign-out or revocation)",
      detail:
        typeof lifetime !== "number"
          ? "Set ORBITID_SECRET_KEY so the setup page can read session settings from the Backend API."
          : lifetime > 0
            ? `${tokenLifetime ? `Session tokens last ${formatDuration(tokenLifetime)} and refresh automatically.` : "Sessions end after this period."}`
            : `${tokenLifetime ? `Session tokens last ${formatDuration(tokenLifetime)} and refresh automatically.` : ""} The session itself does not expire unless the operator sets a limit.`,
      tryHref: "/inspector",
    },
    {
      id: "session.mode",
      label: "Session mode",
      status: "enabled",
      value: env.auth_config?.single_session_mode ? "One session at a time" : "Multiple sessions allowed",
      detail: env.auth_config?.single_session_mode
        ? "Signing in ends the previous session."
        : "Each browser keeps its own session.",
      tryHref: "/inspector",
    },
  ];
  if (instance?.mfa?.required !== undefined) {
    rows.push({
      id: "session.mfaRequired",
      label: "MFA requirement",
      status: instance.mfa.required ? "enabled" : "off",
      value: instance.mfa.required ? "Required for every user" : "Optional",
      tryHref: "/account",
    });
  }
  return rows;
}

export function brandingRows(env: EnvironmentJSON): FeatureRow[] {
  const display = env.display_config;
  return [
    {
      id: "branding.application",
      label: "Application",
      status: "enabled",
      value: display?.application_name ?? "Unnamed application",
      detail: `Theme ${display?.theme ?? "system"}, primary color ${display?.primary_color ?? "unset"}.`,
      tryHref: "/",
    },
  ];
}

export function captchaRows(env: EnvironmentJSON): FeatureRow[] {
  const display = env.display_config;
  const provider = display?.captcha_provider ?? "none";
  const label = provider === "turnstile" ? "Cloudflare Turnstile" : provider === "hcaptcha" ? "hCaptcha" : "None";
  return [
    {
      id: "captcha.enabled",
      label: "Captcha",
      status: display?.captcha_enabled ? "enabled" : "off",
      value: label,
      detail: display?.captcha_enabled
        ? display.captcha_site_key
          ? "A site key is configured and the widget renders on auth forms."
          : "Enabled, but no site key is set. Add one in the dashboard."
        : "Auth forms submit without a captcha challenge.",
      tryHref: "/sign-up",
    },
  ];
}

/** Mail delivery: prefer a public environment field when one exists, else the secret-key settings snapshot. */
export function emailRows(env: EnvironmentJSON, instance?: InstanceSnapshot): FeatureRow[] {
  const emailCodeSecondFactor = (env.auth_config?.second_factors ?? []).includes("email_code");
  const rows: FeatureRow[] = [];
  const fromEnvironment = emailFromEnvironment(env);
  const email = fromEnvironment ?? instance?.email;
  if (!email) {
    rows.push({
      id: "email.transport",
      label: "Email delivery",
      status: "needs-config",
      value: "Not exposed by the public environment",
      detail: "Set ORBITID_SECRET_KEY so the setup page can read the mail transport from the Backend API.",
      tryHref: "/api-lab",
    });
  } else {
    const resolved = resolveEmailTransport(email);
    rows.push({
      id: "email.transport",
      label: "Email delivery",
      status: resolved.missing ? "needs-config" : resolved.provider === "console" ? "off" : "enabled",
      value: EMAIL_TRANSPORT_LABELS[resolved.provider],
      detail: describeEmailTransport(resolved),
      tryHref: "/api-lab",
    });
  }
  rows.push({
    id: "email.secondFactor",
    label: "Email code second factor",
    status: emailCodeSecondFactor ? "enabled" : "off",
    value: emailCodeSecondFactor ? "Offered after the first factor" : "Not offered",
    detail: emailCodeSecondFactor
      ? "The code goes to a verified email address, with the same lifetime as every other email code."
      : "Turn it on under User and authentication in the dashboard.",
    tryHref: "/account",
  });
  return rows;
}

/** Trusted browsers skip the second factor; the public environment carries both switch and duration. */
export function trustedDeviceRows(env: EnvironmentJSON): FeatureRow[] {
  const trusted = env.auth_config?.trusted_devices;
  return [
    {
      id: "trustedDevices.enabled",
      label: "Trusted devices",
      status: trusted?.enabled ? "enabled" : "off",
      value: trusted?.enabled
        ? `Remembered for ${trusted.days} ${trusted.days === 1 ? "day" : "days"}`
        : "Remembered browsers are not offered",
      detail: trusted?.enabled
        ? "A second factor can tick “Trust this browser”. Each use rotates the token and the lifetime never extends."
        : "Turn it on under Sessions in the dashboard to offer the checkbox in the second-factor step.",
      tryHref: "/account",
    },
  ];
}

/** Guest accounts: public switch, plus the retention period when the secret key can read it. */
export function anonymousRows(env: EnvironmentJSON, instance?: InstanceSnapshot): FeatureRow[] {
  const enabled = env.auth_config?.anonymous?.enabled === true;
  const retention = instance?.anonymous?.retentionSeconds;
  const detail = !enabled
    ? "Turn it on under User and authentication in the dashboard to accept strategy anonymous."
    : typeof retention === "number"
      ? retention > 0
        ? `Guests with no activity for ${formatDuration(retention)} are deleted.`
        : "Guest accounts are kept indefinitely; cleanup is off."
      : "Set ORBITID_SECRET_KEY to read how long inactive guests are kept.";
  return [
    {
      id: "anonymous.enabled",
      label: "Guest accounts",
      status: enabled ? "enabled" : "off",
      value: enabled ? "Anonymous sign-up accepted" : "Not offered",
      detail,
      tryHref: "/guest",
    },
  ];
}

/** OIDC provider options live only in the settings tree, so every row needs the secret key. */
export function oidcRows(instance?: InstanceSnapshot): FeatureRow[] {
  const oidc = instance?.oidcProvider;
  const deviceEnabled = oidc?.deviceAuthorizationEnabled === true;
  const jwtTokens = oidc?.accessTokenFormat === "jwt";
  const lifetime = oidc?.deviceCodeLifetimeSeconds;
  const interval = oidc?.deviceCodeIntervalSeconds;
  return [
    {
      id: "oidc.deviceFlow",
      label: "Device authorization grant",
      status: oidc ? (deviceEnabled ? "enabled" : "off") : "needs-config",
      value: oidc ? (deviceEnabled ? "CLIs and TVs can request a code" : "Endpoints answer 404") : "Not exposed by the public environment",
      detail: oidc
        ? deviceEnabled
          ? `Codes last ${typeof lifetime === "number" ? formatDuration(lifetime) : "ten minutes"} and the token endpoint accepts one poll every ${interval ?? 5} seconds.`
          : "Turn it on under OAuth applications in the dashboard."
        : "Set ORBITID_SECRET_KEY so the setup page can read the provider settings from the Backend API.",
      tryHref: "/device",
    },
    {
      id: "oidc.accessTokens",
      label: "JWT access tokens",
      status: oidc ? (jwtTokens ? "enabled" : "off") : "needs-config",
      value: oidc ? (jwtTokens ? "RS256 JWTs, verified with the JWKS" : "Opaque tokens, checked at userinfo") : "Not exposed by the public environment",
      detail: oidc
        ? jwtTokens
          ? "Resource servers verify offline. Revocation still wins because grants are recorded."
          : "Set oidcProvider.accessTokenFormat to jwt to hand out signed access tokens."
        : "Set ORBITID_SECRET_KEY so the setup page can read the provider settings from the Backend API.",
      tryHref: "/device",
    },
  ];
}

/** The handshake route is public: the flow is always available, only the redirect rules depend on settings. */
export function handshakeRows(env: EnvironmentJSON): FeatureRow[] {
  const homeUrl = env.display_config?.home_url;
  return [
    {
      id: "handshake.enabled",
      label: "Server-side handshake",
      status: "enabled",
      value: "GET /v1/client/handshake",
      detail: homeUrl
        ? `Mints a fresh session token for a live client cookie and redirects to ${homeUrl}. Other origins answer 400.`
        : "Mints a fresh session token for a live client cookie and redirects to an allowed origin.",
      tryHref: "/api-lab",
    },
  ];
}
