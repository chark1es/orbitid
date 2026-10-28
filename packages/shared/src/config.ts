import { z } from "zod";

/** Per-attribute sign-up/sign-in configuration (the "User & Authentication" settings). */
export const attributeSchema = z.object({
  enabled: z.boolean(),
  required: z.boolean().default(false),
  /** Used as identifier on the sign-in form. */
  usedForFirstFactor: z.boolean().default(false),
  usedForSecondFactor: z.boolean().default(false),
  /** Verification strategies allowed for this attribute. */
  verifications: z.array(z.string()).default([]),
  verifyAtSignUp: z.boolean().default(true),
});
export type AttributeConfig = z.infer<typeof attributeSchema>;

export const socialProviderSchema = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string().default(""),
  clientSecret: z.string().default(""),
  scopes: z.array(z.string()).default([]),
  /** For custom OIDC providers (`custom_<key>`). */
  discoveryUrl: z.string().optional(),
  name: z.string().optional(),
  /** Use shared dev credentials is not possible in OSS; user must supply their own. */
  authenticatableAtSignIn: z.boolean().default(true),
});
export type SocialProviderConfig = z.infer<typeof socialProviderSchema>;

export const SOCIAL_PROVIDERS = [
  "google", "github", "gitlab", "discord", "microsoft", "apple", "facebook", "twitter", "linkedin_oidc",
  "slack", "twitch", "spotify", "bitbucket", "dropbox", "notion", "hubspot", "tiktok", "coinbase", "line", "linear", "huggingface", "box", "atlassian", "xero", "x"
] as const;

export const instanceSettingsSchema = z.object({
  application: z.object({
    name: z.string().default("OrbitID App"),
    logoUrl: z.string().nullable().default(null),
    homeUrl: z.string().default("http://localhost:3000"),
    supportEmail: z.string().nullable().default(null),
    termsUrl: z.string().nullable().default(null),
    privacyUrl: z.string().nullable().default(null),
    /** Allowed origins for CORS + redirect_url validation. */
    allowedOrigins: z.array(z.string()).default(["http://localhost:3000", "http://localhost:5173"]),
    allowedRedirectOrigins: z.array(z.string()).default([]),
    developmentMode: z.boolean().default(true),
  }).default({}),
  attributes: z.object({
    emailAddress: attributeSchema.default({ enabled: true, required: true, usedForFirstFactor: true, verifications: ["email_code"], verifyAtSignUp: true }),
    phoneNumber: attributeSchema.default({ enabled: false, required: false, usedForFirstFactor: false, verifications: ["phone_code"] }),
    username: attributeSchema.default({ enabled: false, required: false, usedForFirstFactor: true, verifyAtSignUp: false }),
    firstName: attributeSchema.default({ enabled: true, required: false, verifyAtSignUp: false }),
    lastName: attributeSchema.default({ enabled: true, required: false, verifyAtSignUp: false }),
    password: attributeSchema.default({ enabled: true, required: true, usedForFirstFactor: true, verifyAtSignUp: false }),
    passkey: attributeSchema.default({ enabled: false, required: false, usedForFirstFactor: true, verifyAtSignUp: false }),
    backupCode: attributeSchema.default({ enabled: false, usedForSecondFactor: true }),
    authenticatorApp: attributeSchema.default({ enabled: false, usedForSecondFactor: true }),
  }).default({}),
  password: z.object({
    minLength: z.number().int().min(1).default(8),
    maxLength: z.number().int().default(72),
    requireLowercase: z.boolean().default(false),
    requireUppercase: z.boolean().default(false),
    requireNumbers: z.boolean().default(false),
    requireSpecialCharacter: z.boolean().default(false),
    /** Reject passwords found in HaveIBeenPwned (k-anonymity range API). */
    rejectPwned: z.boolean().default(false),
    signOutOfOtherSessionsOnChange: z.boolean().default(true),
  }).default({}),
  username: z.object({ minLength: z.number().default(4), maxLength: z.number().default(64) }).default({}),
  /** Sign-up mode. */
  signUp: z.object({
    mode: z.enum(["public", "restricted", "waitlist"]).default("public"),
    legalConsentRequired: z.boolean().default(false),
    /** Allow users to sign up with a different account than the one authenticated (progressive sign-up). */
    progressive: z.boolean().default(true),
  }).default({}),
  restrictions: z.object({
    allowlistEnabled: z.boolean().default(false),
    blocklistEnabled: z.boolean().default(false),
    blockEmailSubaddresses: z.boolean().default(false),
    blockDisposableEmailDomains: z.boolean().default(false),
  }).default({}),
  social: z.record(z.string(), socialProviderSchema).default({}),
  mfa: z.object({
    required: z.boolean().default(false),
    /** Max verification attempts before lock */
    maxAttempts: z.number().default(100),
    lockoutDurationSeconds: z.number().default(3600),
  }).default({}),
  session: z.object({
    /** Max lifetime of a session in seconds (default 7 days) */
    lifetimeSeconds: z.number().default(60 * 60 * 24 * 7),
    inactivityTimeoutSeconds: z.number().default(0),
    /** Session JWT lifetime (default 60s; refreshed by the SDK) */
    tokenLifetimeSeconds: z.number().default(60),
    multiSession: z.boolean().default(false),
    customClaims: z.record(z.string(), z.unknown()).default({}),
  }).default({}),
  organizations: z.object({
    enabled: z.boolean().default(false),
    /** Let users create orgs. */
    creationEnabled: z.boolean().default(true),
    maxAllowedMemberships: z.number().default(5),
    slugEnabled: z.boolean().default(true),
    domainsEnabled: z.boolean().default(false),
    membershipRequestsEnabled: z.boolean().default(false),
    /** Force every user to belong to an org ("personal accounts disabled"). */
    forceOrganizationSelection: z.boolean().default(false),
    creatorRole: z.string().default("org:admin"),
    defaultRole: z.string().default("org:member"),
    adminDeleteEnabled: z.boolean().default(true),
    maxCreatedOrganizationsPerUser: z.number().nullable().default(null),
  }).default({}),
  userSettings: z.object({
    deleteSelfEnabled: z.boolean().default(true),
    createOrganizationEnabled: z.boolean().default(true),
    allowProfileImageUpload: z.boolean().default(true),
  }).default({}),
  email: z.object({
    from: z.string().default("OrbitID <no-reply@localhost>"),
    /** smtp://user:pass@host:587 ; empty => log emails to console (dev) */
    smtpUrl: z.string().default(""),
    codeLength: z.number().default(6),
    codeLifetimeSeconds: z.number().default(600),
    linkLifetimeSeconds: z.number().default(3600),
  }).default({}),
  sms: z.object({
    /** "console" | "twilio" | "webhook" */
    provider: z.enum(["console", "twilio", "webhook"]).default("console"),
    twilioAccountSid: z.string().default(""),
    twilioAuthToken: z.string().default(""),
    twilioFrom: z.string().default(""),
    webhookUrl: z.string().default(""),
  }).default({}),
  security: z.object({
    botProtection: z.boolean().default(false),
    /** hCaptcha / Cloudflare Turnstile secret; empty disables */
    captchaProvider: z.enum(["none", "turnstile", "hcaptcha"]).default("none"),
    captchaSecret: z.string().default(""),
    captchaSiteKey: z.string().default(""),
    rateLimitEnabled: z.boolean().default(true),
    enumerationProtection: z.boolean().default(false),
    testingTokensEnabled: z.boolean().default(true),
  }).default({}),
  branding: z.object({
    primaryColor: z.string().default("#2b2522"),
    showPoweredBy: z.boolean().default(true),
    theme: z.enum(["light", "dark", "system"]).default("system"),
  }).default({}),
});
export type InstanceSettings = z.infer<typeof instanceSettingsSchema>;
export const defaultInstanceSettings = (): InstanceSettings => instanceSettingsSchema.parse({});

/**
 * Public, secret-free projection of settings returned by `GET /v1/client/environment`.
 * UI components render entirely from this object.
 */
export interface EnvironmentJSON {
  object: "environment";
  auth_config: {
    identification_requirements: string[][]; // e.g. [["email_address"],["oauth_google"]]
    first_factors: string[];
    second_factors: string[];
    single_session_mode: boolean;
    sign_up_mode: "public" | "restricted" | "waitlist";
    legal_consent_required: boolean;
  };
  user_settings: {
    attributes: Record<string, { enabled: boolean; required: boolean; used_for_first_factor: boolean; used_for_second_factor: boolean; verifications: string[]; verify_at_sign_up: boolean }>;
    social: Record<string, { enabled: boolean; name: string; strategy: string; authenticatable: boolean; logo_url: string }>;
    password_settings: { min_length: number; max_length: number; require_lowercase: boolean; require_uppercase: boolean; require_numbers: boolean; require_special_char: boolean };
    username_settings: { min_length: number; max_length: number };
    sign_up: { mode: string; progressive: boolean };
    actions: { delete_self: boolean; create_organization: boolean };
    passkey_settings: { allow_autofill: boolean; show_sign_in_button: boolean };
  };
  organization_settings: {
    enabled: boolean; max_allowed_memberships: number; creation_enabled: boolean; domains_enabled: boolean; membership_requests_enabled: boolean;
    slug_enabled: boolean; force_organization_selection: boolean; creator_role: string; default_role: string;
    /** Organizations one user may create, or null for no limit. */
    max_created_organizations_per_user: number | null;
  };
  display_config: { application_name: string; logo_image_url: string | null; home_url: string; support_email: string | null; terms_url: string | null; privacy_url: string | null; primary_color: string; theme: string; branded: boolean; captcha_enabled: boolean; captcha_provider: string; captcha_site_key: string };
}
