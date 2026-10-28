import type { EnvironmentJSON } from "@orbitid/shared";
import { formatDuration } from "./format";

export type FeatureStatus = "enabled" | "off" | "needs-config";

export interface FeatureRow {
  id: string;
  label: string;
  status: FeatureStatus;
  value: string;
  detail?: string;
  tryHref: string;
  /** OAuth strategy, present on social provider rows so the row can start a real sign-in. */
  strategy?: string;
}

export interface FeatureSection {
  id: string;
  title: string;
  hint?: string;
  rows: FeatureRow[];
}

/** The parts of `PATCH /v1/instance` settings that the public environment does not expose. */
export interface InstanceSnapshot {
  session?: {
    lifetimeSeconds?: number;
    tokenLifetimeSeconds?: number;
    multiSession?: boolean;
  };
  mfa?: { required?: boolean };
}

export const STATUS_LABEL: Record<FeatureStatus, string> = {
  enabled: "Enabled",
  off: "Off",
  "needs-config": "Needs config",
};

const IDENTIFIERS: Array<{ key: string; label: string }> = [
  { key: "email_address", label: "Email address" },
  { key: "phone_number", label: "Phone number" },
  { key: "username", label: "Username" },
];

const VERIFICATION_LABELS: Record<string, string> = {
  email_code: "email code",
  email_link: "email link",
  phone_code: "SMS code",
};

const FIRST_FACTORS: Array<{ factor: string; label: string; value: string; detail: string }> = [
  { factor: "password", label: "Password", value: "Password accepted at sign-in", detail: "Checked against the instance password policy." },
  { factor: "email_code", label: "Email code", value: "Code sent to the email address", detail: "The code is delivered by the instance mail settings." },
  { factor: "email_link", label: "Email link", value: "Link sent to the email address", detail: "The link returns to the app with a verification token." },
  { factor: "phone_code", label: "SMS code", value: "Code sent to the phone number", detail: "The instance SMS provider delivers the code." },
  { factor: "passkey", label: "Passkey", value: "WebAuthn passkey accepted", detail: "The browser holds the credential for this site's origin." },
  { factor: "enterprise_sso", label: "Enterprise SSO", value: "No connection", detail: "Create an enterprise connection and verify its domains in the dashboard." },
];

const SECOND_FACTORS: Array<{ factor: string; label: string; value: string; detail: string }> = [
  { factor: "totp", label: "Authenticator app", value: "TOTP codes accepted", detail: "Users enroll from the account page security tab." },
  { factor: "phone_code", label: "SMS code", value: "Codes sent to the phone number", detail: "Requires the phone number attribute and an SMS provider." },
  { factor: "backup_code", label: "Backup codes", value: "Single-use recovery codes accepted", detail: "Ten codes are issued when a user enables them." },
];

type AttributeJSON = EnvironmentJSON["user_settings"]["attributes"][string];

function attribute(env: EnvironmentJSON, key: string): AttributeJSON | undefined {
  return env.user_settings?.attributes?.[key];
}

function enabledWords(attr: AttributeJSON | undefined): string {
  if (!attr) return "Not collected";
  const requirement = attr.required ? "Required" : "Optional";
  const verification = attr.verify_at_sign_up ? "verified at sign-up" : "no verification at sign-up";
  return `${requirement}, ${verification}`;
}

function verificationDetail(attr: AttributeJSON | undefined): string | undefined {
  const list = attr?.verifications ?? [];
  if (!list.length) return undefined;
  const words = list.map((item) => VERIFICATION_LABELS[item] ?? item);
  return `Verification: ${words.join(", ")}.`;
}

function socialRows(env: EnvironmentJSON): FeatureRow[] {
  const social = env.user_settings?.social ?? {};
  const rows = Object.entries(social)
    .filter(([, config]) => config.enabled)
    .map(([key, config]) => {
      const strategy = config.strategy || `oauth_${key}`;
      return {
        id: `social.${key}`,
        label: config.name || key,
        status: "enabled" as const,
        value: config.authenticatable ? "Offered at sign-in and sign-up" : "Offered at sign-up only",
        detail: `Strategy ${strategy}. Client credentials are set on the instance.`,
        tryHref: "/sign-in",
        strategy,
      };
    });
  if (rows.length) return rows;
  return [
    {
      id: "social.none",
      label: "Social providers",
      status: "off",
      value: "None configured",
      detail: "Add a provider's client ID and secret in the dashboard to enable a Continue with button.",
      tryHref: "/sign-in",
    },
  ];
}

function signUpRows(env: EnvironmentJSON): FeatureRow[] {
  const mode = env.auth_config?.sign_up_mode ?? "public";
  const detail =
    mode === "public"
      ? "Anyone with a valid identifier can create an account."
      : mode === "restricted"
        ? "Only allowlisted identifiers can sign up. Add them in the dashboard."
        : "New users join the waitlist and wait for an invitation.";
  const rows: FeatureRow[] = [
    {
      id: "signUp.mode",
      label: "Sign-up mode",
      status: mode === "restricted" ? "needs-config" : "enabled",
      value: mode.charAt(0).toUpperCase() + mode.slice(1),
      detail,
      tryHref: mode === "waitlist" ? "/waitlist" : "/sign-up",
    },
    {
      id: "signUp.legalConsent",
      label: "Legal consent",
      status: env.auth_config?.legal_consent_required ? "enabled" : "off",
      value: env.auth_config?.legal_consent_required ? "Required at sign-up" : "Not required",
      tryHref: "/sign-up",
    },
  ];
  if (env.user_settings?.sign_up?.progressive) {
    rows.push({
      id: "signUp.progressive",
      label: "Progressive sign-up",
      status: "enabled",
      value: "Users can add missing fields later",
      tryHref: "/sign-up",
    });
  }
  return rows;
}

function passwordRows(env: EnvironmentJSON): FeatureRow[] {
  const attr = attribute(env, "password");
  const policy = env.user_settings?.password_settings;
  const enabled = Boolean(attr?.enabled);
  const requirements = policy
    ? [
        policy.require_lowercase ? "lowercase" : null,
        policy.require_uppercase ? "uppercase" : null,
        policy.require_numbers ? "number" : null,
        policy.require_special_char ? "symbol" : null,
      ].filter(Boolean)
    : [];
  return [
    {
      id: "password.policy",
      label: "Password",
      status: enabled ? "enabled" : "off",
      value: enabled && policy ? `${policy.min_length} to ${policy.max_length} characters` : "Not offered",
      detail: policy
        ? requirements.length
          ? `Requires ${requirements.join(", ")}.`
          : "No character requirements beyond the length."
        : undefined,
      tryHref: "/sign-up",
    },
  ];
}

function passkeyRows(env: EnvironmentJSON): FeatureRow[] {
  const attr = attribute(env, "passkey");
  const settings = env.user_settings?.passkey_settings;
  return [
    {
      id: "passkey.enabled",
      label: "Passkeys",
      status: attr?.enabled ? "enabled" : "off",
      value: attr?.enabled ? "Registration and sign-in available" : "Not offered",
      detail:
        attr?.enabled && settings
          ? `${settings.show_sign_in_button ? "Shown" : "Hidden"} on the sign-in form, ${settings.allow_autofill ? "autofill allowed" : "autofill off"}.`
          : "Turn on passkeys in the dashboard to offer WebAuthn.",
      tryHref: "/account",
    },
  ];
}

function organizationRows(env: EnvironmentJSON): FeatureRow[] {
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

function sessionRows(env: EnvironmentJSON, instance?: InstanceSnapshot): FeatureRow[] {
  const lifetime = instance?.session?.lifetimeSeconds;
  const tokenLifetime = instance?.session?.tokenLifetimeSeconds;
  const rows: FeatureRow[] = [
    {
      id: "session.lifetime",
      label: "Session lifetime",
      status: typeof lifetime === "number" ? "enabled" : "needs-config",
      value: typeof lifetime === "number" ? formatDuration(lifetime) : "Not exposed by the public environment",
      detail:
        typeof lifetime === "number"
          ? `${tokenLifetime ? `Session tokens last ${formatDuration(tokenLifetime)} and refresh automatically.` : "Sessions end after this period."}`
          : "Set ORBITID_SECRET_KEY so the setup page can read session settings from the Backend API.",
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

function brandingRows(env: EnvironmentJSON): FeatureRow[] {
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

function captchaRows(env: EnvironmentJSON): FeatureRow[] {
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

/** Builds every row the setup page shows from the instance's public environment plus optional settings. */
export function buildFeatureMatrix(env: EnvironmentJSON, instance?: InstanceSnapshot): FeatureSection[] {
  const identifiers: FeatureRow[] = IDENTIFIERS.map(({ key, label }) => {
    const attr = attribute(env, key);
    return {
      id: `identifier.${key}`,
      label,
      status: attr?.enabled ? "enabled" : "off",
      value: attr?.enabled ? enabledWords(attr) : "Not collected",
      detail: attr?.enabled ? verificationDetail(attr) : undefined,
      tryHref: "/sign-up",
    };
  });

  const firstFactors: FeatureRow[] = FIRST_FACTORS.map(({ factor, label, value, detail }) => {
    const on = (env.auth_config?.first_factors ?? []).includes(factor);
    return {
      id: `firstFactor.${factor}`,
      label,
      status: on ? "enabled" : factor === "enterprise_sso" ? "needs-config" : "off",
      value: on ? value : factor === "enterprise_sso" ? "No connection" : "Not offered",
      detail: on ? detail : factor === "enterprise_sso" ? detail : "Turn it on in the dashboard under User and authentication.",
      tryHref: "/sign-in",
    };
  });

  const secondFactors: FeatureRow[] = SECOND_FACTORS.map(({ factor, label, value, detail }) => {
    const on = (env.auth_config?.second_factors ?? []).includes(factor);
    return {
      id: `secondFactor.${factor}`,
      label,
      status: on ? "enabled" : "off",
      value: on ? value : "Not offered",
      detail: on ? detail : "Turn it on in the dashboard under User and authentication.",
      tryHref: "/account",
    };
  });

  return [
    {
      id: "identifiers",
      title: "Identifiers",
      hint: "What the instance collects at sign-up.",
      rows: identifiers,
    },
    {
      id: "first-factors",
      title: "First factors",
      hint: "Ways a user can prove who they are.",
      rows: firstFactors,
    },
    {
      id: "second-factors",
      title: "Second factors",
      hint: "Additional checks after the first factor.",
      rows: secondFactors,
    },
    {
      id: "social",
      title: "Social providers",
      hint: "Providers with client credentials on the instance.",
      rows: socialRows(env),
    },
    {
      id: "sign-up",
      title: "Sign-up",
      rows: signUpRows(env),
    },
    {
      id: "password",
      title: "Password policy",
      rows: passwordRows(env),
    },
    {
      id: "passkeys",
      title: "Passkeys",
      rows: passkeyRows(env),
    },
    {
      id: "organizations",
      title: "Organizations",
      rows: organizationRows(env),
    },
    {
      id: "session",
      title: "Sessions",
      rows: sessionRows(env, instance),
    },
    {
      id: "branding",
      title: "Branding",
      rows: brandingRows(env),
    },
    {
      id: "captcha",
      title: "Captcha",
      rows: captchaRows(env),
    },
  ];
}

export function findFeatureRow(sections: FeatureSection[], id: string): FeatureRow | undefined {
  for (const section of sections) {
    const row = section.rows.find((item) => item.id === id);
    if (row) return row;
  }
  return undefined;
}

export function countFeatureStatuses(sections: FeatureSection[]): Record<FeatureStatus, number> {
  const counts: Record<FeatureStatus, number> = { enabled: 0, off: 0, "needs-config": 0 };
  for (const section of sections) {
    for (const row of section.rows) counts[row.status] += 1;
  }
  return counts;
}
