import type { EnvironmentJSON } from "@orbitid/shared";

export interface AttributeSettings {
  enabled: boolean;
  required: boolean;
  usedForFirstFactor: boolean;
  usedForSecondFactor: boolean;
  verifications: string[];
  verifyAtSignUp: boolean;
}

export interface SocialProviderSettings {
  enabled: boolean;
  name: string;
  strategy: string;
  authenticatable: boolean;
  logoUrl: string;
}

export interface SocialProviderStrategy {
  strategy: string;
  name: string;
  logoUrl: string;
  authenticatable: boolean;
}

export interface PasswordSettings {
  minLength: number;
  maxLength: number;
  requireLowercase: boolean;
  requireUppercase: boolean;
  requireNumbers: boolean;
  requireSpecialChar: boolean;
}

export interface UsernameSettings {
  minLength: number;
  maxLength: number;
}

export interface SignUpSettings {
  mode: string;
  progressive: boolean;
}

export interface UserSettingsActions {
  deleteSelf: boolean;
  createOrganization: boolean;
}

export interface PasskeySettings {
  allowAutofill: boolean;
  showSignInButton: boolean;
}

export class AuthConfig {
  identificationRequirements: string[][];
  firstFactors: string[];
  secondFactors: string[];
  singleSessionMode: boolean;
  signUpMode: "public" | "restricted" | "waitlist";
  legalConsentRequired: boolean;

  constructor(json: EnvironmentJSON["auth_config"]) {
    this.identificationRequirements = json.identification_requirements ?? [];
    this.firstFactors = json.first_factors ?? [];
    this.secondFactors = json.second_factors ?? [];
    this.singleSessionMode = json.single_session_mode ?? false;
    this.signUpMode = json.sign_up_mode ?? "public";
    this.legalConsentRequired = json.legal_consent_required ?? false;
  }
}

export class UserSettings {
  attributes: Record<string, AttributeSettings>;
  social: Record<string, SocialProviderSettings>;
  passwordSettings: PasswordSettings;
  usernameSettings: UsernameSettings;
  signUp: SignUpSettings;
  actions: UserSettingsActions;
  passkeySettings: PasskeySettings;

  constructor(json: EnvironmentJSON["user_settings"]) {
    this.attributes = Object.fromEntries(
      Object.entries(json.attributes ?? {}).map(([key, value]) => [
        key,
        {
          enabled: value.enabled ?? false,
          required: value.required ?? false,
          usedForFirstFactor: value.used_for_first_factor ?? false,
          usedForSecondFactor: value.used_for_second_factor ?? false,
          verifications: value.verifications ?? [],
          verifyAtSignUp: value.verify_at_sign_up ?? false,
        },
      ]),
    );
    this.social = Object.fromEntries(
      Object.entries(json.social ?? {}).map(([key, value]) => [
        key,
        {
          enabled: value.enabled ?? false,
          name: value.name ?? key,
          strategy: value.strategy ?? `oauth_${key}`,
          authenticatable: value.authenticatable ?? true,
          logoUrl: value.logo_url ?? "",
        },
      ]),
    );
    const password = json.password_settings;
    this.passwordSettings = {
      minLength: password?.min_length ?? 8,
      maxLength: password?.max_length ?? 72,
      requireLowercase: password?.require_lowercase ?? false,
      requireUppercase: password?.require_uppercase ?? false,
      requireNumbers: password?.require_numbers ?? false,
      requireSpecialChar: password?.require_special_char ?? false,
    };
    this.usernameSettings = {
      minLength: json.username_settings?.min_length ?? 4,
      maxLength: json.username_settings?.max_length ?? 64,
    };
    this.signUp = { mode: json.sign_up?.mode ?? "public", progressive: json.sign_up?.progressive ?? true };
    this.actions = { deleteSelf: json.actions?.delete_self ?? false, createOrganization: json.actions?.create_organization ?? false };
    this.passkeySettings = {
      allowAutofill: json.passkey_settings?.allow_autofill ?? false,
      showSignInButton: json.passkey_settings?.show_sign_in_button ?? false,
    };
  }

  /** Enabled social providers in `SignIn` button order. */
  get socialProviderStrategies(): SocialProviderStrategy[] {
    return Object.values(this.social)
      .filter((provider) => provider.enabled)
      .map((provider) => ({ strategy: provider.strategy, name: provider.name, logoUrl: provider.logoUrl, authenticatable: provider.authenticatable }));
  }

  /** Attribute keys enabled as first-factor identifiers (`emailAddress`, `username`, …). */
  get enabledFirstFactorIdentifierAttributes(): string[] {
    return Object.entries(this.attributes)
      .filter(([, attribute]) => attribute.enabled && attribute.usedForFirstFactor)
      .map(([key]) => key);
  }

  get enabledSecondFactorAttributes(): string[] {
    return Object.entries(this.attributes)
      .filter(([, attribute]) => attribute.enabled && attribute.usedForSecondFactor)
      .map(([key]) => key);
  }
}

export class OrganizationSettings {
  enabled: boolean;
  maxAllowedMemberships: number;
  /** Organizations one user may create, or `null` for no limit. */
  maxCreatedOrganizationsPerUser: number | null;
  creationEnabled: boolean;
  domainsEnabled: boolean;
  membershipRequestsEnabled: boolean;
  slugEnabled: boolean;
  forceOrganizationSelection: boolean;
  creatorRole: string;
  defaultRole: string;

  constructor(json: EnvironmentJSON["organization_settings"]) {
    this.enabled = json.enabled ?? false;
    this.maxAllowedMemberships = json.max_allowed_memberships ?? 5;
    this.maxCreatedOrganizationsPerUser = json.max_created_organizations_per_user ?? null;
    this.creationEnabled = json.creation_enabled ?? true;
    this.domainsEnabled = json.domains_enabled ?? false;
    this.membershipRequestsEnabled = json.membership_requests_enabled ?? false;
    this.slugEnabled = json.slug_enabled ?? true;
    this.forceOrganizationSelection = json.force_organization_selection ?? false;
    this.creatorRole = json.creator_role ?? "org:admin";
    this.defaultRole = json.default_role ?? "org:member";
  }
}

export class DisplayConfig {
  applicationName: string;
  logoImageUrl: string | null;
  homeUrl: string;
  supportEmail: string | null;
  termsUrl: string | null;
  privacyUrl: string | null;
  primaryColor: string;
  theme: string;
  branded: boolean;
  captchaEnabled: boolean;
  captchaProvider: string;
  captchaSiteKey: string;

  constructor(json: EnvironmentJSON["display_config"]) {
    this.applicationName = json.application_name ?? "OrbitID App";
    this.logoImageUrl = json.logo_image_url ?? null;
    this.homeUrl = json.home_url ?? "/";
    this.supportEmail = json.support_email ?? null;
    this.termsUrl = json.terms_url ?? null;
    this.privacyUrl = json.privacy_url ?? null;
    this.primaryColor = json.primary_color ?? "#6366f1";
    this.theme = json.theme ?? "system";
    this.branded = json.branded ?? false;
    this.captchaEnabled = json.captcha_enabled ?? false;
    this.captchaProvider = json.captcha_provider ?? "none";
    this.captchaSiteKey = json.captcha_site_key ?? "";
  }
}

export class Environment {
  readonly object = "environment" as const;
  authConfig: AuthConfig;
  userSettings: UserSettings;
  organizationSettings: OrganizationSettings;
  displayConfig: DisplayConfig;

  constructor(json: EnvironmentJSON) {
    this.authConfig = new AuthConfig(json.auth_config ?? {});
    this.userSettings = new UserSettings(json.user_settings ?? {});
    this.organizationSettings = new OrganizationSettings(json.organization_settings ?? {});
    this.displayConfig = new DisplayConfig(json.display_config ?? {});
  }

  static fromJSON(json: EnvironmentJSON): Environment {
    return new Environment(json);
  }
}
