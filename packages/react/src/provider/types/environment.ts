// ---------------------------------------------------------------------------
// Environment (GET /v1/client/environment, camelCase projection)
// ---------------------------------------------------------------------------

export interface AttributeSettingsResource {
  enabled: boolean;
  required: boolean;
  usedForFirstFactor: boolean;
  usedForSecondFactor: boolean;
  verifications: string[];
  verifyAtSignUp: boolean;
  [key: string]: unknown;
}

export interface SocialProviderSettingsResource {
  enabled: boolean;
  name: string;
  strategy: string;
  authenticatable: boolean;
  logoUrl: string;
  [key: string]: unknown;
}

export interface EnvironmentResource {
  authConfig: {
    identificationRequirements: string[][];
    firstFactors: string[];
    secondFactors: string[];
    singleSessionMode: boolean;
    signUpMode: string;
    legalConsentRequired: boolean;
    [key: string]: unknown;
  };
  userSettings: {
    attributes: Record<string, AttributeSettingsResource>;
    social: Record<string, SocialProviderSettingsResource>;
    passwordSettings: {
      minLength: number;
      maxLength: number;
      requireLowercase: boolean;
      requireUppercase: boolean;
      requireNumbers: boolean;
      requireSpecialChar: boolean;
      [key: string]: unknown;
    };
    usernameSettings: { minLength: number; maxLength: number; [key: string]: unknown };
    signUp: { mode: string; progressive: boolean; [key: string]: unknown };
    actions: { deleteSelf: boolean; createOrganization: boolean; [key: string]: unknown };
    passkeySettings: { allowAutofill: boolean; showSignInButton: boolean; [key: string]: unknown };
    [key: string]: unknown;
  };
  organizationSettings: {
    enabled: boolean;
    maxAllowedMemberships: number;
    /** Organizations one user may create, or `null`/absent for no limit. */
    maxCreatedOrganizationsPerUser?: number | null;
    creationEnabled: boolean;
    domainsEnabled: boolean;
    membershipRequestsEnabled: boolean;
    slugEnabled: boolean;
    forceOrganizationSelection: boolean;
    creatorRole: string;
    defaultRole: string;
    [key: string]: unknown;
  };
  displayConfig: {
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
    [key: string]: unknown;
  };
  [key: string]: unknown;
}
