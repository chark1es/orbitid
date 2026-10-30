import type { EnvironmentJSON } from "@orbitid/shared";
import { isRecord } from "../guards";
import { socialProviderLabel } from "./labels";
import { createDefaultEnvironment } from "./defaults";

export function pick(record: Record<string, unknown>, snake: string, camel?: string): unknown {
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
