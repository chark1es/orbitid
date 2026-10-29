import type { EnvironmentJSON } from "@orbitid/shared";
import { isRecord } from "./guards";

export type AttributeName =
  | "email_address"
  | "phone_number"
  | "username"
  | "first_name"
  | "last_name"
  | "password"
  | "passkey"
  | "authenticator_app"
  | "backup_code";

export interface AttributeView {
  enabled: boolean;
  required: boolean;
  usedForFirstFactor: boolean;
  usedForSecondFactor: boolean;
  verifications: string[];
  verifyAtSignUp: boolean;
}

export interface SocialProviderView {
  id: string;
  strategy: string;
  name: string;
  enabled: boolean;
  authenticatable: boolean;
  logoUrl: string | null;
}

export interface PasswordSettingsView {
  minLength: number;
  maxLength: number;
  requireLowercase: boolean;
  requireUppercase: boolean;
  requireNumbers: boolean;
  requireSpecialChar: boolean;
}

export interface CaptchaSettingsView {
  enabled: boolean;
  provider: "turnstile" | "hcaptcha" | "none";
  siteKey: string;
}

export interface EnvironmentView {
  raw: EnvironmentJSON;
  app: {
    name: string;
    logoUrl: string | null;
    homeUrl: string;
    supportEmail: string | null;
    termsUrl: string | null;
    privacyUrl: string | null;
    primaryColor: string;
    theme: string;
    branded: boolean;
    developmentMode: boolean;
  };
  attributes: Record<AttributeName, AttributeView>;
  social: SocialProviderView[];
  identifiers: AttributeName[];
  password: PasswordSettingsView;
  username: { minLength: number; maxLength: number };
  signUp: { mode: "public" | "restricted" | "waitlist"; legalConsentRequired: boolean; progressive: boolean };
  passkey: { allowAutofill: boolean; showSignInButton: boolean };
  singleSessionMode: boolean;
  secondFactors: string[];
  /** Trusted browsers may skip the second factor (from `auth_config.trusted_devices`). */
  trustedDevices: { enabled: boolean; days: number };
  /** Guest sign-up is available (from `auth_config.anonymous`). */
  anonymous: { enabled: boolean };
  actions: { deleteSelf: boolean; createOrganization: boolean };
  captcha: CaptchaSettingsView;
}

const DEFAULT_ATTRIBUTE: AttributeView = {
  enabled: false,
  required: false,
  usedForFirstFactor: false,
  usedForSecondFactor: false,
  verifications: [],
  verifyAtSignUp: false,
};

function attrFrom(
  raw: Record<string, EnvironmentJSON["user_settings"]["attributes"][string]> | undefined,
  name: AttributeName,
  fallback: Partial<AttributeView> = {},
): AttributeView {
  const camel = name.replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
  const entry = raw?.[name] ?? raw?.[camel];
  if (!entry) return { ...DEFAULT_ATTRIBUTE, ...fallback };
  return {
    enabled: entry.enabled ?? false,
    required: entry.required ?? false,
    usedForFirstFactor: entry.used_for_first_factor ?? false,
    usedForSecondFactor: entry.used_for_second_factor ?? false,
    verifications: Array.isArray(entry.verifications) ? entry.verifications : [],
    verifyAtSignUp: entry.verify_at_sign_up ?? false,
  };
}

const SOCIAL_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  discord: "Discord",
  microsoft: "Microsoft",
  apple: "Apple",
  facebook: "Facebook",
  twitter: "X",
  x: "X",
  linkedin_oidc: "LinkedIn",
  linkedin: "LinkedIn",
  slack: "Slack",
  twitch: "Twitch",
  spotify: "Spotify",
  bitbucket: "Bitbucket",
  dropbox: "Dropbox",
  notion: "Notion",
  hubspot: "HubSpot",
  tiktok: "TikTok",
  coinbase: "Coinbase",
  line: "LINE",
  linear: "Linear",
  huggingface: "Hugging Face",
  box: "Box",
  atlassian: "Atlassian",
  xero: "Xero",
};

export function socialProviderLabel(id: string): string {
  const clean = id.replace(/^oauth_/, "").replace(/^custom_/, "");
  return SOCIAL_LABELS[clean] ?? clean.replace(/[_-]/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}

/** A complete fallback environment matching `defaultInstanceSettings()`; used only if the SDK has none. */
export function createDefaultEnvironment(): EnvironmentJSON {
  return {
    object: "environment",
    auth_config: {
      identification_requirements: [["email_address"], ["password"]],
      first_factors: ["password", "email_code", "email_link"],
      second_factors: [],
      single_session_mode: false,
      sign_up_mode: "public",
      legal_consent_required: false,
      trusted_devices: { enabled: false, days: 30 },
      anonymous: { enabled: false },
    },
    user_settings: {
      attributes: {
        email_address: {
          enabled: true,
          required: true,
          used_for_first_factor: true,
          used_for_second_factor: false,
          verifications: ["email_code"],
          verify_at_sign_up: true,
        },
        phone_number: {
          enabled: false,
          required: false,
          used_for_first_factor: false,
          used_for_second_factor: false,
          verifications: ["phone_code"],
          verify_at_sign_up: false,
        },
        username: {
          enabled: false,
          required: false,
          used_for_first_factor: true,
          used_for_second_factor: false,
          verifications: [],
          verify_at_sign_up: false,
        },
        first_name: {
          enabled: true,
          required: false,
          used_for_first_factor: false,
          used_for_second_factor: false,
          verifications: [],
          verify_at_sign_up: false,
        },
        last_name: {
          enabled: true,
          required: false,
          used_for_first_factor: false,
          used_for_second_factor: false,
          verifications: [],
          verify_at_sign_up: false,
        },
        password: {
          enabled: true,
          required: true,
          used_for_first_factor: true,
          used_for_second_factor: false,
          verifications: [],
          verify_at_sign_up: false,
        },
        passkey: {
          enabled: false,
          required: false,
          used_for_first_factor: true,
          used_for_second_factor: false,
          verifications: [],
          verify_at_sign_up: false,
        },
        authenticator_app: {
          enabled: false,
          required: false,
          used_for_first_factor: false,
          used_for_second_factor: true,
          verifications: [],
          verify_at_sign_up: false,
        },
        backup_code: {
          enabled: false,
          required: false,
          used_for_first_factor: false,
          used_for_second_factor: true,
          verifications: [],
          verify_at_sign_up: false,
        },
      },
      social: {},
      password_settings: {
        min_length: 8,
        max_length: 72,
        require_lowercase: false,
        require_uppercase: false,
        require_numbers: false,
        require_special_char: false,
      },
      username_settings: { min_length: 4, max_length: 64 },
      sign_up: { mode: "public", progressive: true },
      actions: { delete_self: true, create_organization: true },
      passkey_settings: { allow_autofill: false, show_sign_in_button: false },
    },
    organization_settings: {
      enabled: false,
      max_allowed_memberships: 5,
      max_created_organizations_per_user: null,
      creation_enabled: true,
      domains_enabled: false,
      membership_requests_enabled: false,
      slug_enabled: true,
      force_organization_selection: false,
      creator_role: "org:admin",
      default_role: "org:member",
    },
    display_config: {
      application_name: "OrbitID App",
      logo_image_url: null,
      home_url: "/",
      support_email: null,
      terms_url: null,
      privacy_url: null,
      primary_color: "#2b2522",
      theme: "system",
      branded: true,
      captcha_enabled: false,
      captcha_provider: "none",
      captcha_site_key: "",
    },
  };
}


function pick(record: Record<string, unknown>, snake: string, camel?: string): unknown {
  const value = record[snake];
  if (value !== undefined) return value;
  return camel ? record[camel] : undefined;
}

function stringValue(record: Record<string, unknown>, snake: string, camel?: string, fallback = ""): string {
  const value = pick(record, snake, camel);
  return typeof value === "string" ? value : fallback;
}

function booleanValue(record: Record<string, unknown>, snake: string, camel?: string, fallback = false): boolean {
  const value = pick(record, snake, camel);
  return typeof value === "boolean" ? value : fallback;
}

function numberValue(record: Record<string, unknown>, snake: string, camel: string | undefined, fallback: number): number {
  const value = pick(record, snake, camel);
  return typeof value === "number" ? value : fallback;
}

function nullableNumberValue(record: Record<string, unknown>, snake: string, camel: string): number | null {
  const value = pick(record, snake, camel);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Converts the camelCase `EnvironmentResource` produced by `@orbitid/js` (or the raw snake_case
 * wire JSON) into the public `EnvironmentJSON` shape the UI reads.
 */
export function environmentFromResource(raw: unknown): EnvironmentJSON | null {
  if (!isRecord(raw)) return null;
  const defaults = createDefaultEnvironment();
  const auth = isRecord(pick(raw, "auth_config", "authConfig")) ? (pick(raw, "auth_config", "authConfig") as Record<string, unknown>) : {};
  const userSettingsRaw = isRecord(pick(raw, "user_settings", "userSettings"))
    ? (pick(raw, "user_settings", "userSettings") as Record<string, unknown>)
    : {};
  const displayRaw = isRecord(pick(raw, "display_config", "displayConfig"))
    ? (pick(raw, "display_config", "displayConfig") as Record<string, unknown>)
    : {};
  const organizationRaw = isRecord(pick(raw, "organization_settings", "organizationSettings"))
    ? (pick(raw, "organization_settings", "organizationSettings") as Record<string, unknown>)
    : {};

  const attributesRaw = isRecord(userSettingsRaw.attributes) ? userSettingsRaw.attributes : {};
  const attributes: EnvironmentJSON["user_settings"]["attributes"] = {};
  for (const [key, value] of Object.entries(attributesRaw)) {
    if (!isRecord(value)) continue;
    attributes[key] = {
      enabled: booleanValue(value, "enabled"),
      required: booleanValue(value, "required"),
      used_for_first_factor: booleanValue(value, "used_for_first_factor", "usedForFirstFactor"),
      used_for_second_factor: booleanValue(value, "used_for_second_factor", "usedForSecondFactor"),
      verifications: Array.isArray(value.verifications) ? value.verifications.filter((entry): entry is string => typeof entry === "string") : [],
      verify_at_sign_up: booleanValue(value, "verify_at_sign_up", "verifyAtSignUp"),
    };
  }

  const socialRaw = isRecord(userSettingsRaw.social) ? userSettingsRaw.social : {};
  const social: EnvironmentJSON["user_settings"]["social"] = {};
  for (const [key, value] of Object.entries(socialRaw)) {
    if (!isRecord(value)) continue;
    social[key] = {
      enabled: booleanValue(value, "enabled"),
      name: stringValue(value, "name", undefined, socialProviderLabel(key)),
      strategy: stringValue(value, "strategy", undefined, `oauth_${key}`),
      authenticatable: booleanValue(value, "authenticatable", undefined, true),
      logo_url: stringValue(value, "logo_url", "logoUrl"),
    };
  }

  const passwordRaw = isRecord(pick(userSettingsRaw, "password_settings", "passwordSettings"))
    ? (pick(userSettingsRaw, "password_settings", "passwordSettings") as Record<string, unknown>)
    : {};
  const usernameRaw = isRecord(pick(userSettingsRaw, "username_settings", "usernameSettings"))
    ? (pick(userSettingsRaw, "username_settings", "usernameSettings") as Record<string, unknown>)
    : {};
  const signUpRaw = isRecord(userSettingsRaw.signUp) ? userSettingsRaw.signUp : {};
  const actionsRaw = isRecord(userSettingsRaw.actions) ? userSettingsRaw.actions : {};
  const passkeyRaw = isRecord(pick(userSettingsRaw, "passkey_settings", "passkeySettings"))
    ? (pick(userSettingsRaw, "passkey_settings", "passkeySettings") as Record<string, unknown>)
    : {};

  const displayDefaults = defaults.display_config;
  return {
    object: "environment",
    auth_config: {
      identification_requirements: Array.isArray(auth.identification_requirements)
        ? (auth.identification_requirements as string[][])
        : Array.isArray(auth.identificationRequirements)
          ? (auth.identificationRequirements as string[][])
          : defaults.auth_config.identification_requirements,
      first_factors: Array.isArray(pick(auth, "first_factors", "firstFactors"))
        ? (pick(auth, "first_factors", "firstFactors") as string[])
        : defaults.auth_config.first_factors,
      second_factors: Array.isArray(pick(auth, "second_factors", "secondFactors"))
        ? (pick(auth, "second_factors", "secondFactors") as string[])
        : defaults.auth_config.second_factors,
      single_session_mode: booleanValue(auth, "single_session_mode", "singleSessionMode"),
      sign_up_mode: stringValue(auth, "sign_up_mode", "signUpMode", defaults.auth_config.sign_up_mode) as EnvironmentJSON["auth_config"]["sign_up_mode"],
      legal_consent_required: booleanValue(auth, "legal_consent_required", "legalConsentRequired"),
      trusted_devices: (() => {
        const rawTrusted = pick(auth, "trusted_devices", "trustedDevices");
        const record = isRecord(rawTrusted) ? rawTrusted : {};
        return {
          enabled: booleanValue(record, "enabled", undefined, defaults.auth_config.trusted_devices.enabled),
          days: numberValue(record, "days", undefined, defaults.auth_config.trusted_devices.days),
        };
      })(),
      anonymous: (() => {
        const rawAnonymous = auth.anonymous;
        const record = isRecord(rawAnonymous) ? rawAnonymous : {};
        return { enabled: booleanValue(record, "enabled", undefined, defaults.auth_config.anonymous.enabled) };
      })(),
    },
    user_settings: {
      attributes,
      social,
      password_settings: {
        min_length: numberValue(passwordRaw, "min_length", "minLength", 8),
        max_length: numberValue(passwordRaw, "max_length", "maxLength", 72),
        require_lowercase: booleanValue(passwordRaw, "require_lowercase", "requireLowercase"),
        require_uppercase: booleanValue(passwordRaw, "require_uppercase", "requireUppercase"),
        require_numbers: booleanValue(passwordRaw, "require_numbers", "requireNumbers"),
        require_special_char: booleanValue(passwordRaw, "require_special_char", "requireSpecialChar"),
      },
      username_settings: {
        min_length: numberValue(usernameRaw, "min_length", "minLength", 4),
        max_length: numberValue(usernameRaw, "max_length", "maxLength", 64),
      },
      sign_up: {
        mode: stringValue(signUpRaw, "mode", undefined, "public"),
        progressive: booleanValue(signUpRaw, "progressive", undefined, true),
      },
      actions: {
        delete_self: booleanValue(actionsRaw, "delete_self", "deleteSelf", true),
        create_organization: booleanValue(actionsRaw, "create_organization", "createOrganization", true),
      },
      passkey_settings: {
        allow_autofill: booleanValue(passkeyRaw, "allow_autofill", "allowAutofill"),
        show_sign_in_button: booleanValue(passkeyRaw, "show_sign_in_button", "showSignInButton", true),
      },
    },
    organization_settings: {
      enabled: booleanValue(organizationRaw, "enabled"),
      max_allowed_memberships: numberValue(organizationRaw, "max_allowed_memberships", "maxAllowedMemberships", 5),
      max_created_organizations_per_user: nullableNumberValue(
        organizationRaw,
        "max_created_organizations_per_user",
        "maxCreatedOrganizationsPerUser",
      ),
      creation_enabled: booleanValue(organizationRaw, "creation_enabled", "creationEnabled", true),
      domains_enabled: booleanValue(organizationRaw, "domains_enabled", "domainsEnabled"),
      membership_requests_enabled: booleanValue(organizationRaw, "membership_requests_enabled", "membershipRequestsEnabled"),
      slug_enabled: booleanValue(organizationRaw, "slug_enabled", "slugEnabled", true),
      force_organization_selection: booleanValue(organizationRaw, "force_organization_selection", "forceOrganizationSelection"),
      creator_role: stringValue(organizationRaw, "creator_role", "creatorRole", "org:admin"),
      default_role: stringValue(organizationRaw, "default_role", "defaultRole", "org:member"),
    },
    display_config: {
      application_name: stringValue(displayRaw, "application_name", "applicationName", displayDefaults.application_name),
      logo_image_url: stringValue(displayRaw, "logo_image_url", "logoImageUrl") || null,
      home_url: stringValue(displayRaw, "home_url", "homeUrl", displayDefaults.home_url),
      support_email: stringValue(displayRaw, "support_email", "supportEmail") || null,
      terms_url: stringValue(displayRaw, "terms_url", "termsUrl") || null,
      privacy_url: stringValue(displayRaw, "privacy_url", "privacyUrl") || null,
      primary_color: stringValue(displayRaw, "primary_color", "primaryColor", displayDefaults.primary_color),
      theme: stringValue(displayRaw, "theme", undefined, displayDefaults.theme),
      branded: booleanValue(displayRaw, "branded", undefined, true),
      captcha_enabled: booleanValue(displayRaw, "captcha_enabled", "captchaEnabled"),
      captcha_provider: stringValue(displayRaw, "captcha_provider", "captchaProvider", "none"),
      captcha_site_key: stringValue(displayRaw, "captcha_site_key", "captchaSiteKey"),
    },
  };
}

export function normalizeEnvironment(
  input: EnvironmentJSON | Record<string, unknown> | null | undefined,
  options: { developmentMode?: boolean } = {},
): EnvironmentView {
  const env = environmentFromResource(input) ?? createDefaultEnvironment();
  const display = env.display_config ?? createDefaultEnvironment().display_config;
  const userSettings = env.user_settings;
  const attributesRaw = userSettings?.attributes;

  const attributes: Record<AttributeName, AttributeView> = {
    email_address: attrFrom(attributesRaw, "email_address", {
      enabled: true,
      required: true,
      usedForFirstFactor: true,
      verifications: ["email_code"],
      verifyAtSignUp: true,
    }),
    phone_number: attrFrom(attributesRaw, "phone_number", { verifications: ["phone_code"] }),
    username: attrFrom(attributesRaw, "username", { usedForFirstFactor: true }),
    first_name: attrFrom(attributesRaw, "first_name", { enabled: true }),
    last_name: attrFrom(attributesRaw, "last_name", { enabled: true }),
    password: attrFrom(attributesRaw, "password", { enabled: true, required: true, usedForFirstFactor: true }),
    passkey: attrFrom(attributesRaw, "passkey", { usedForFirstFactor: true }),
    authenticator_app: attrFrom(attributesRaw, "authenticator_app", { enabled: true, usedForSecondFactor: true }),
    backup_code: attrFrom(attributesRaw, "backup_code", { enabled: true, usedForSecondFactor: true }),
  };

  const socialRaw = userSettings?.social ?? {};
  const social: SocialProviderView[] = Object.entries(socialRaw)
    .map(([id, value]) => ({
      id,
      strategy: value.strategy || `oauth_${id}`,
      name: value.name || socialProviderLabel(id),
      enabled: Boolean(value.enabled),
      authenticatable: value.authenticatable !== false,
      logoUrl: value.logo_url || null,
    }))
    .filter((provider) => provider.enabled && provider.authenticatable);

  const identifiers = (["email_address", "phone_number", "username"] as const).filter(
    (name) => attributes[name].enabled && attributes[name].usedForFirstFactor,
  );

  const passwordSettings = userSettings?.password_settings ?? createDefaultEnvironment().user_settings.password_settings;
  const usernameSettings = userSettings?.username_settings ?? { min_length: 4, max_length: 64 };
  const signUpMode = (env.auth_config?.sign_up_mode ?? userSettings?.sign_up?.mode ?? "public") as
    | "public"
    | "restricted"
    | "waitlist";

  const captchaProvider = (display.captcha_provider || "none") as CaptchaSettingsView["provider"];

  // Optional server extension: `display_config.development_mode` (raw input, before normalization).
  const rawDisplay = isRecord(input) ? pick(input, "display_config", "displayConfig") : undefined;
  const developmentModeFlag = isRecord(rawDisplay)
    ? (rawDisplay["development_mode"] ?? rawDisplay["developmentMode"])
    : undefined;

  return {
    raw: env,
    app: {
      name: display.application_name || "OrbitID",
      logoUrl: display.logo_image_url ?? null,
      homeUrl: display.home_url || "/",
      supportEmail: display.support_email ?? null,
      termsUrl: display.terms_url ?? null,
      privacyUrl: display.privacy_url ?? null,
      primaryColor: display.primary_color || "#2b2522",
      theme: display.theme || "system",
      branded: display.branded !== false,
      developmentMode: Boolean(
        options.developmentMode ?? (typeof developmentModeFlag === "boolean" ? developmentModeFlag : false),
      ),
    },
    attributes,
    social,
    identifiers,
    password: {
      minLength: passwordSettings.min_length ?? 8,
      maxLength: passwordSettings.max_length ?? 72,
      requireLowercase: Boolean(passwordSettings.require_lowercase),
      requireUppercase: Boolean(passwordSettings.require_uppercase),
      requireNumbers: Boolean(passwordSettings.require_numbers),
      requireSpecialChar: Boolean(passwordSettings.require_special_char),
    },
    username: {
      minLength: usernameSettings.min_length ?? 4,
      maxLength: usernameSettings.max_length ?? 64,
    },
    signUp: {
      mode: signUpMode,
      legalConsentRequired: Boolean(env.auth_config?.legal_consent_required),
      progressive: userSettings?.sign_up?.progressive !== false,
    },
    passkey: {
      allowAutofill: Boolean(userSettings?.passkey_settings?.allow_autofill),
      showSignInButton: userSettings?.passkey_settings?.show_sign_in_button !== false,
    },
    singleSessionMode: Boolean(env.auth_config?.single_session_mode),
    secondFactors: env.auth_config?.second_factors ?? [],
    trustedDevices: {
      enabled: Boolean(env.auth_config?.trusted_devices?.enabled),
      days: Number(env.auth_config?.trusted_devices?.days ?? 30),
    },
    anonymous: { enabled: Boolean(env.auth_config?.anonymous?.enabled) },
    actions: {
      deleteSelf: userSettings?.actions?.delete_self !== false,
      createOrganization: userSettings?.actions?.create_organization !== false,
    },
    captcha: {
      enabled: Boolean(display.captcha_enabled) && captchaProvider !== "none" && Boolean(display.captcha_site_key),
      provider: captchaProvider,
      siteKey: display.captcha_site_key || "",
    },
  };
}

/** True when the environment permits password sign-in. */
export function passwordEnabled(env: EnvironmentView): boolean {
  return env.attributes.password.enabled;
}

export function emailEnabled(env: EnvironmentView): boolean {
  return env.attributes.email_address.enabled;
}

export function phoneEnabled(env: EnvironmentView): boolean {
  return env.attributes.phone_number.enabled;
}

export type { EnvironmentJSON };
