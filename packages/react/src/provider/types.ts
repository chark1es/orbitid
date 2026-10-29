import type { ReactNode } from "react";
import type { ApiErrorItem, Metadata, ReverificationConfig, SessionClaims } from "@orbitid/shared";
import type { Appearance } from "../appearance/types";
import type { LocalizationResource } from "../localization/types";

export type { ApiErrorItem, Metadata, ReverificationConfig, SessionClaims };

export interface Actor {
  sub: string;
  sid?: string;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Resources: structural mirror of the camelCase resources produced by @orbitid/js
// (fields/methods verified against packages/js/src/resources/*).
// ---------------------------------------------------------------------------

export interface VerificationResource {
  status: "unverified" | "verified" | "transferable" | "failed" | "expired" | string;
  strategy: string;
  attempts?: number | null;
  expireAt?: number | null;
  externalVerificationRedirectUrl?: string | null;
  error?: { code: string; message: string } | null;
  nonce?: string | null;
  [key: string]: unknown;
}

export interface EmailAddressResource {
  id: string;
  emailAddress: string;
  verification?: VerificationResource | VerificationWire | null;
  linkedTo?: { type: string; id: string }[];
  reserved?: boolean;
  [key: string]: unknown;
}

export interface PhoneNumberResource {
  id: string;
  phoneNumber: string;
  verification?: VerificationResource | VerificationWire | null;
  reservedForSecondFactor?: boolean;
  defaultSecondFactor?: boolean;
  linkedTo?: { type: string; id: string }[];
  [key: string]: unknown;
}

export interface ExternalAccountResource {
  id: string;
  provider: string;
  providerUserId?: string;
  emailAddress?: string;
  firstName?: string;
  lastName?: string;
  username?: string | null;
  imageUrl?: string | null;
  avatarUrl?: string | null;
  approvedScopes?: string;
  publicMetadata?: Metadata;
  label?: string | null;
  verification?: VerificationWire | null;
  [key: string]: unknown;
}

export interface PasskeyResource {
  id: string;
  name: string;
  verification?: VerificationWire | null;
  lastUsedAt: number | null;
  createdAt: number;
  [key: string]: unknown;
}

export interface TOTPResource {
  id?: string;
  secret?: string;
  uri?: string;
  qrCodeUrl?: string;
  qrCode?: string;
  qr_code?: string;
  verified?: boolean;
  /** Ten single-use codes; the server returns them once, when verification completes. */
  backupCodes?: string[];
  [key: string]: unknown;
}

export interface BackupCodeResource {
  codes: string[];
  [key: string]: unknown;
}

/** A browser remembered for skipping the second factor (`GET /v1/client/me/trusted_devices`). */
export interface TrustedDeviceResource {
  id: string;
  userId?: string;
  user_id?: string;
  label?: string | null;
  userAgent?: string | null;
  user_agent?: string | null;
  ipAddress?: string | null;
  ip_address?: string | null;
  expiresAt?: number;
  expires_at?: number;
  lastUsedAt?: number | null;
  last_used_at?: number | null;
  createdAt?: number;
  created_at?: number;
  [key: string]: unknown;
}

/** Wire verification JSON (snake_case) as embedded in user identifiers. */
export interface VerificationWire {
  status: string;
  strategy: string;
  attempts?: number | null;
  expire_at?: number | null;
  external_verification_redirect_url?: string | null;
  error?: { code: string; message: string } | null;
  nonce?: string | null;
  [key: string]: unknown;
}

export interface SessionPublicUserData {
  user_id?: string;
  first_name?: string | null;
  last_name?: string | null;
  image_url?: string;
  has_image?: boolean;
  identifier?: string;
  /** camelCase aliases added by `@orbitid/react`. */
  userId?: string;
  firstName?: string | null;
  lastName?: string | null;
  imageUrl?: string;
  hasImage?: boolean;
  [key: string]: unknown;
}

export type MembershipPublicUserData = SessionPublicUserData;

export interface PaginationQuery {
  limit?: number;
  offset?: number;
  page?: number;
  orderBy?: string;
  query?: string;
  role?: string;
  status?: string;
}

export interface PaginatedResult<T> {
  data: T[];
  totalCount: number;
  count?: number;
}

export interface UpdateUserParams {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  primaryEmailAddressId?: string | null;
  primaryPhoneNumberId?: string | null;
  unsafeMetadata?: Metadata;
  [key: string]: unknown;
}

export interface ProfileImageParams {
  file: Blob;
  uploaderUserId?: string;
}

export interface UserResource {
  id: string;
  externalId?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  fullName?: string | null;
  username?: string | null;
  imageUrl?: string;
  hasImage?: boolean;
  primaryEmailAddressId?: string | null;
  primaryEmailAddress?: EmailAddressResource | null;
  primaryPhoneNumberId?: string | null;
  primaryPhoneNumber?: PhoneNumberResource | null;
  emailAddresses?: EmailAddressResource[];
  phoneNumbers?: PhoneNumberResource[];
  externalAccounts?: ExternalAccountResource[];
  passkeys?: PasskeyResource[];
  publicMetadata?: Metadata;
  unsafeMetadata?: Metadata;
  passwordEnabled?: boolean;
  totpEnabled?: boolean;
  backupCodeEnabled?: boolean;
  twoFactorEnabled?: boolean;
  hasVerifiedEmailAddress?: boolean;
  hasVerifiedPhoneNumber?: boolean;
  banned?: boolean;
  locked?: boolean;
  lastSignInAt?: number | null;
  lastActiveAt?: number | null;
  createdAt?: number;
  updatedAt?: number;
  update(params: UpdateUserParams): Promise<UserResource>;
  delete(): Promise<void>;
  setProfileImage(params: ProfileImageParams): Promise<UserResource>;
  deleteProfileImage(): Promise<UserResource>;
  updatePassword(params: {
    currentPassword?: string;
    newPassword: string;
    signOutOfOtherSessions?: boolean;
  }): Promise<UserResource>;
  removePassword(params: { currentPassword: string }): Promise<UserResource>;
  createEmailAddress(params: { email: string }): Promise<EmailAddressResource>;
  createPhoneNumber(params: { phoneNumber: string }): Promise<PhoneNumberResource>;
  createExternalAccount(params: {
    strategy: string;
    redirectUrl?: string;
    additionalScopes?: string[];
  }): Promise<ExternalAccountResource>;
  createTOTP(): Promise<TOTPResource>;
  verifyTOTP(params: { code: string }): Promise<TOTPResource>;
  disableTOTP(): Promise<void>;
  createBackupCode(): Promise<BackupCodeResource>;
  createPasskey(params?: { name?: string }): Promise<PasskeyResource>;
  getSessions(): Promise<SessionResource[]>;
  revokeSession(sessionId: string): Promise<void>;
  getTrustedDevices?(): Promise<TrustedDeviceResource[]>;
  revokeTrustedDevice?(deviceId: string): Promise<void>;
  leaveOrganization(organizationId: string): Promise<void>;
  getOrganizationMemberships(params?: PaginationQuery): Promise<PaginatedResult<OrganizationMembershipResource>>;
  getOrganizationInvitations(): Promise<UserOrganizationInvitationResource[]>;
  getOrganizationSuggestions(): Promise<OrganizationSuggestionResource[]>;
  [key: string]: unknown;
}

export interface TokenResource {
  object: "token";
  jwt: string;
  [key: string]: unknown;
}

export interface GetTokenOptions {
  template?: string;
  skipCache?: boolean;
}

export interface SessionResource {
  id: string;
  status: "active" | "pending" | "ended" | "expired" | "removed" | "abandoned" | "replaced" | "revoked" | string;
  user?: UserResource | null;
  /** Raw wire shape: `user_id`, `first_name`, … (`userId` aliases are added by the provider). */
  publicUserData?: SessionPublicUserData | null;
  actor?: Actor | null;
  lastActiveOrganizationId?: string | null;
  /** How the session was created (`password`, `email_code`, `passkey`, …), when known. */
  signInMethod?: string | null;
  /** True when a trusted device let this sign-in skip the second factor. */
  secondFactorSkippedByTrustedDevice?: boolean;
  lastActiveToken?: TokenResource | null;
  factorVerificationAge?: [number, number] | null;
  expireAt?: number;
  abandonAt?: number;
  lastActiveAt?: number;
  createdAt?: number;
  isActive?: boolean;
  getToken(options?: GetTokenOptions): Promise<string>;
  [key: string]: unknown;
}

export interface ClientResource {
  id: string;
  sessions: SessionResource[];
  signIn?: SignInResource | null;
  signUp?: SignUpResource | null;
  lastActiveSessionId?: string | null;
  cookieExpiresAt?: number | null;
  [key: string]: unknown;
}

export interface OrganizationResource {
  id: string;
  name: string;
  slug: string;
  imageUrl?: string;
  hasImage?: boolean;
  membersCount?: number;
  pendingInvitationsCount?: number;
  maxAllowedMemberships?: number;
  adminDeleteEnabled?: boolean;
  publicMetadata?: Metadata;
  createdBy?: string | null;
  createdAt?: number;
  updatedAt?: number;
  update(params: { name?: string; slug?: string; publicMetadata?: Metadata }): Promise<OrganizationResource>;
  destroy(): Promise<void>;
  setLogo(params: ProfileImageParams): Promise<OrganizationResource>;
  removeLogo(): Promise<OrganizationResource>;
  getMemberships(params?: PaginationQuery): Promise<PaginatedResult<OrganizationMembershipResource>>;
  addMember(params: { userId: string; role: string }): Promise<OrganizationMembershipResource>;
  inviteMember(params: {
    emailAddress: string;
    role: string;
    redirectUrl?: string;
  }): Promise<OrganizationInvitationResource>;
  inviteMembers(params: {
    emailAddresses: string[];
    role: string;
    redirectUrl?: string;
  }): Promise<OrganizationInvitationResource[]>;
  getInvitations(params?: PaginationQuery): Promise<OrganizationInvitationResource[]>;
  createDomain(params: { name: string; enrollmentMode?: string }): Promise<OrganizationDomainResource>;
  getDomains(): Promise<OrganizationDomainResource[]>;
  getMembershipRequests(): Promise<OrganizationMembershipRequestResource[]>;
  requestMembership(): Promise<OrganizationMembershipRequestResource>;
  getRoles(params?: PaginationQuery): Promise<RoleResource[]>;
  /** `GET|POST /v1/client/organizations/:id/api_keys` (absent in older SDK builds). */
  apiKeys?: {
    list(params?: PaginationQuery): Promise<PaginatedResult<ApiKeyResource>>;
    create(params: CreateApiKeyParams): Promise<ApiKeyResource>;
  };
  [key: string]: unknown;
}

export interface OrganizationMembershipResource {
  id: string;
  role: string;
  roleName?: string;
  permissions?: string[];
  publicMetadata?: Metadata;
  organization: OrganizationResource;
  publicUserData: MembershipPublicUserData;
  userId?: string;
  createdAt?: number;
  updatedAt?: number;
  update(params: { role: string }): Promise<OrganizationMembershipResource>;
  destroy(): Promise<void>;
  [key: string]: unknown;
}

export interface OrganizationInvitationResource {
  id: string;
  emailAddress: string;
  organizationId?: string;
  role: string;
  roleName?: string;
  status: "pending" | "accepted" | "revoked" | "expired" | string;
  publicMetadata?: Metadata;
  url?: string | null;
  createdAt?: number;
  updatedAt?: number;
  revoke(): Promise<OrganizationInvitationResource>;
  [key: string]: unknown;
}

export interface UserOrganizationInvitationResource extends OrganizationInvitationResource {
  organization?: OrganizationResource | null;
  /** Denormalized organization label on `GET /me/organization_invitations`; absent on older servers. */
  organizationName?: string | null;
  organizationImageUrl?: string | null;
  accept(): Promise<UserOrganizationInvitationResource>;
}

export interface OrganizationDomainResource {
  id: string;
  organizationId?: string;
  name: string;
  enrollmentMode: "manual_invitation" | "automatic_invitation" | "automatic_suggestion" | string;
  verification?: VerificationResource | VerificationWire | null;
  affiliationEmailAddress?: string | null;
  totalPendingInvitations?: number;
  totalPendingSuggestions?: number;
  isVerified?: boolean;
  createdAt?: number;
  updatedAt?: number;
  prepareAffiliationVerification(params: {
    affiliationEmailAddress: string;
  }): Promise<OrganizationDomainResource>;
  attemptAffiliationVerification(params: { code: string }): Promise<OrganizationDomainResource>;
  updateEnrollmentMode(params: {
    enrollmentMode: string;
    deletePending?: boolean;
  }): Promise<OrganizationDomainResource>;
  delete(): Promise<void>;
  [key: string]: unknown;
}

export interface OrganizationMembershipRequestResource {
  id: string;
  organizationId?: string;
  status: "pending" | "accepted" | "rejected" | string;
  publicUserData: MembershipPublicUserData;
  createdAt?: number;
  updatedAt?: number;
  accept(): Promise<OrganizationMembershipRequestResource>;
  reject(): Promise<OrganizationMembershipRequestResource>;
  [key: string]: unknown;
}

export interface OrganizationSuggestionResource {
  id: string;
  status: "pending" | "accepted" | string;
  publicOrganizationData: {
    id: string;
    name: string;
    slug: string;
    image_url?: string;
    imageUrl?: string;
    has_image?: boolean;
    hasImage?: boolean;
  };
  createdAt?: number;
  updatedAt?: number;
  accept(): Promise<OrganizationSuggestionResource>;
  [key: string]: unknown;
}

export interface PermissionResource {
  id?: string;
  key: string;
  name?: string;
  description?: string;
  type?: "system" | "user" | string;
  [key: string]: unknown;
}

export interface RoleResource {
  id?: string;
  key: string;
  name?: string;
  description?: string;
  permissions?: PermissionResource[];
  isCreatorEligible?: boolean;
  [key: string]: unknown;
}

export interface CreateApiKeyParams {
  name: string;
  description?: string;
  scopes?: string[];
  expiration?: number | null;
  claims?: Record<string, unknown> | null;
  organizationId?: string;
}

export interface ApiKeyResource {
  id: string;
  name: string;
  description: string | null;
  subject: string;
  prefix: string;
  /** Plaintext secret — returned only once, at creation. */
  secret?: string;
  scopes: string[];
  claims: Record<string, unknown> | null;
  revoked: boolean;
  expiration: number | null;
  lastUsedAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;
  [key: string]: unknown;
}

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

// ---------------------------------------------------------------------------
// Sign-in / sign-up
// ---------------------------------------------------------------------------

export interface SignInFactor {
  strategy: string;
  emailAddressId?: string;
  phoneNumberId?: string;
  safeIdentifier?: string;
  primary?: boolean;
  default?: boolean;
  [key: string]: unknown;
}

export interface SignInCreateParams {
  identifier?: string;
  strategy?: string;
  password?: string;
  code?: string;
  ticket?: string;
  redirectUrl?: string;
  actionCompleteRedirectUrl?: string;
  transfer?: boolean;
  [key: string]: unknown;
}

export interface PrepareFirstFactorParams {
  strategy: string;
  emailAddressId?: string;
  phoneNumberId?: string;
  redirectUrl?: string;
  actionCompleteRedirectUrl?: string;
  [key: string]: unknown;
}

export interface AttemptFirstFactorParams {
  strategy: string;
  password?: string;
  code?: string;
  signature?: string;
  ticket?: string;
  publicKeyCredential?: unknown;
  [key: string]: unknown;
}

export interface PrepareSecondFactorParams {
  strategy: string;
  phoneNumberId?: string;
  [key: string]: unknown;
}

export interface AttemptSecondFactorParams {
  strategy: string;
  code: string;
  [key: string]: unknown;
}

export interface ResetPasswordParams {
  password: string;
  signOutOfOtherSessions?: boolean;
  [key: string]: unknown;
}

export interface AuthenticateWithRedirectParams {
  strategy: string;
  redirectUrl?: string;
  redirectUrlComplete?: string;
  [key: string]: unknown;
}

export interface SignInResource {
  id?: string;
  status: "needs_identifier" | "needs_first_factor" | "needs_second_factor" | "needs_new_password" | "complete" | string;
  supportedIdentifiers?: string[];
  supportedFirstFactors?: SignInFactor[] | null;
  supportedSecondFactors?: SignInFactor[] | null;
  firstFactorVerification?: VerificationResource | null;
  secondFactorVerification?: VerificationResource | null;
  identifier?: string | null;
  userData?: { firstName?: string | null; lastName?: string | null; imageUrl?: string; hasImage?: boolean } | null;
  createdSessionId?: string | null;
  abandonAt?: number;
  create(params?: SignInCreateParams): Promise<SignInResource>;
  reload(): Promise<SignInResource>;
  prepareFirstFactor(params: PrepareFirstFactorParams): Promise<SignInResource>;
  attemptFirstFactor(params: AttemptFirstFactorParams): Promise<SignInResource>;
  prepareSecondFactor(params: PrepareSecondFactorParams): Promise<SignInResource>;
  attemptSecondFactor(params: AttemptSecondFactorParams): Promise<SignInResource>;
  resetPassword(params: ResetPasswordParams): Promise<SignInResource>;
  authenticateWithRedirect(params: AuthenticateWithRedirectParams): Promise<SignInResource>;
  authenticateWithPasskey?(options?: { autofill?: boolean }): Promise<SignInResource>;
  [key: string]: unknown;
}

export interface SignUpCreateParams {
  emailAddress?: string;
  phoneNumber?: string;
  username?: string;
  password?: string;
  firstName?: string;
  lastName?: string;
  strategy?: string;
  redirectUrl?: string;
  ticket?: string;
  unsafeMetadata?: Metadata;
  legalAccepted?: boolean;
  transfer?: boolean;
  [key: string]: unknown;
}

export interface SignUpVerifications {
  emailAddress?: VerificationResource | null;
  phoneNumber?: VerificationResource | null;
  externalAccount?: VerificationResource | null;
  web3Wallet?: VerificationResource | null;
  [key: string]: unknown;
}

export interface SignUpResource {
  id?: string;
  status: "missing_requirements" | "complete" | "abandoned" | string;
  requiredFields?: string[];
  optionalFields?: string[];
  missingFields?: string[];
  unverifiedFields?: string[];
  emailAddress?: string | null;
  phoneNumber?: string | null;
  username?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  passwordEnabled?: boolean;
  unsafeMetadata?: Metadata;
  publicMetadata?: Metadata;
  verifications?: SignUpVerifications;
  emailAddressVerification?: VerificationResource | null;
  phoneNumberVerification?: VerificationResource | null;
  externalAccountVerification?: VerificationResource | null;
  createdSessionId?: string | null;
  createdUserId?: string | null;
  abandonAt?: number;
  legalAcceptedAt?: number | null;
  create(params?: SignUpCreateParams): Promise<SignUpResource>;
  /** Creates a guest account (needs `anonymous.enabled` on the instance). */
  createAnonymous?(params?: { unsafeMetadata?: Metadata; legalAccepted?: boolean }): Promise<SignUpResource>;
  update(params: SignUpCreateParams): Promise<SignUpResource>;
  reload(): Promise<SignUpResource>;
  prepareVerification(params?: { strategy?: string }): Promise<SignUpResource>;
  attemptVerification(params: { strategy: string; code: string }): Promise<SignUpResource>;
  prepareEmailAddressVerification(params?: { strategy?: string }): Promise<SignUpResource>;
  attemptEmailAddressVerification(params: { code: string }): Promise<SignUpResource>;
  preparePhoneNumberVerification(params?: { strategy?: string }): Promise<SignUpResource>;
  attemptPhoneNumberVerification(params: { code: string }): Promise<SignUpResource>;
  authenticateWithRedirect(params: AuthenticateWithRedirectParams): Promise<SignUpResource>;
  [key: string]: unknown;
}

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

export interface OrbitIDState {
  client: ClientResource | null;
  session: SessionResource | null;
  user: UserResource | null;
  organization: OrganizationResource | null;
}

export interface SetActiveParams {
  session?: string | SessionResource | null;
  organization?: string | OrganizationResource | null;
  beforeEmit?: (state: OrbitIDState) => void | Promise<void>;
  redirectUrl?: string;
}

export interface SignOutParams {
  sessionId?: string;
  redirectUrl?: string;
}

export interface CreateOrganizationParams {
  name: string;
  slug?: string;
}

export interface BuildAuthUrlOptions {
  redirectUrl?: string;
}

export interface RedirectCallbackParams {
  signInForceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
  signInFallbackRedirectUrl?: string;
  signUpFallbackRedirectUrl?: string;
  continueSignInUrl?: string;
  continueSignUpUrl?: string;
  firstFactorUrl?: string;
  secondFactorUrl?: string;
  resetPasswordUrl?: string;
}

/**
 * What `@orbitid/react` needs from `@orbitid/js` (`OrbitID`). Structural on purpose: React
 * and the browser SDK are published together but built independently, so the provider narrows
 * the SDK instance once (see `provider/instance.ts`) and everything downstream depends on this.
 */
export interface OrbitIDInstance {
  loaded: boolean;
  publishableKey?: string;
  client: ClientResource | null;
  session: SessionResource | null;
  user: UserResource | null;
  organization: OrganizationResource | null;
  environment: EnvironmentResource | null;
  signIn: SignInResource | undefined;
  signUp: SignUpResource | undefined;
  addListener(callback: (state: OrbitIDState) => void): () => void;
  load(options?: { signInUrl?: string; signUpUrl?: string }): Promise<void>;
  setActive(params?: SetActiveParams): Promise<unknown>;
  signOut(params?: SignOutParams): Promise<unknown>;
  createOrganization(params: CreateOrganizationParams): Promise<OrganizationResource>;
  getOrganization(organizationId: string): Promise<OrganizationResource>;
  navigate?(to: string, options?: { replace?: boolean }): void;
  buildSignInUrl?(params?: BuildAuthUrlOptions): string;
  buildSignUpUrl?(params?: BuildAuthUrlOptions): string;
  buildUserProfileUrl?(params?: BuildAuthUrlOptions): string;
  buildOrganizationProfileUrl?(params?: BuildAuthUrlOptions): string;
  buildCreateOrganizationUrl?(): string;
  handleRedirectCallback?(params?: RedirectCallbackParams): Promise<unknown>;
  apiKeys?: {
    list(params?: PaginationQuery): Promise<PaginatedResult<ApiKeyResource>>;
    create(params: CreateApiKeyParams): Promise<ApiKeyResource>;
    revoke(id: string): Promise<void>;
  };
  [key: string]: unknown;
}

export interface OrbitIDOptions {
  domain?: string;
  proxyUrl?: string;
  frontendApi?: string;
  fetch?: typeof globalThis.fetch;
  signInUrl?: string;
  signUpUrl?: string;
  userProfileUrl?: string;
  organizationProfileUrl?: string;
  createOrganizationUrl?: string;
  afterSignOutUrl?: string;
  routerPush?: (to: string) => void | Promise<unknown>;
  routerReplace?: (to: string) => void | Promise<unknown>;
  [key: string]: unknown;
}

/** SSR hydration payload (Next.js `initialState`). */
export interface OrbitIDInitialState {
  sessionClaims?: SessionClaims | null;
  session?: SessionResource | null;
  user?: UserResource | null;
  organization?: OrganizationResource | null;
  client?: ClientResource | null;
  userId?: string | null;
  sessionId?: string | null;
  orgId?: string | null;
  orgRole?: string | null;
  orgSlug?: string | null;
  orgPermissions?: string[] | null;
}

export interface HasParams {
  role?: string;
  permission?: string;
  feature?: string;
  condition?: boolean;
  reverification?: ReverificationConfig;
}

export interface AuthState {
  isLoaded: boolean;
  /** `undefined` until the instance has loaded. */
  isSignedIn: boolean | undefined;
  userId: string | null;
  sessionId: string | null;
  actor: Actor | null;
  orgId: string | null;
  orgRole: string | null;
  orgSlug: string | null;
  orgPermissions: string[] | null;
  sessionClaims: SessionClaims | null;
  sessionStatus: "active" | "pending" | null;
  has(params: HasParams): boolean;
  getToken(options?: GetTokenOptions): Promise<string | null>;
  signOut(options?: SignOutParams): Promise<void>;
}

export interface OrbitIDProviderProps {
  /** Required unless a pre-built `orbit` instance is supplied. */
  publishableKey: string;
  orbit?: OrbitIDInstance;
  initialState?: OrbitIDInitialState;
  appearance?: Appearance;
  /** Dictionary override; `false` keeps `enUS`. */
  localization?: LocalizationResource | false;
  routerPush?: (to: string) => void | Promise<unknown>;
  routerReplace?: (to: string) => void | Promise<unknown>;
  signInUrl?: string;
  signUpUrl?: string;
  userProfileUrl?: string;
  organizationProfileUrl?: string;
  createOrganizationUrl?: string;
  signInFallbackRedirectUrl?: string;
  signUpFallbackRedirectUrl?: string;
  signInForceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
  afterSignOutUrl?: string;
  allowedRedirectOrigins?: Array<string | RegExp>;
  children?: ReactNode;
}

/** Provider options exposed to components through `OptionsContext`. */
export type OrbitIDOptionsContextValue = Omit<OrbitIDProviderProps, "children" | "orbit"> & {
  /** Present once the instance exists (absent during SSR without `orbit`). */
  instance: OrbitIDInstance | null;
};

export type OrbitIDStatus = "loading" | "ready" | "error";

export interface OrbitIDStatusContextValue {
  status: OrbitIDStatus;
  error: Error | null;
  /** Re-run `load()` after a failure. */
  retry(): void;
}

/** Normalized, always-loaded view of the instance (live state or `initialState`). */
export interface OrbitIDSnapshot extends OrbitIDState {
  environment: EnvironmentResource | null;
  loaded: boolean;
}
