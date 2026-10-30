import type { EnvironmentJSON } from "@orbitid/shared";

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


export type { EnvironmentJSON };
