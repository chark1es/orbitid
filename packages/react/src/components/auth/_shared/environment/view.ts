import type { EnvironmentJSON } from "@orbitid/shared";
import { isRecord } from "../guards";
import {
  type AttributeName,
  type AttributeView,
  type SocialProviderView,
  type CaptchaSettingsView,
  type EnvironmentView,
} from "./types";
import { createDefaultEnvironment } from "./defaults";
import { pick, environmentFromResource } from "./from-resource";
import { socialProviderLabel } from "./labels";

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
