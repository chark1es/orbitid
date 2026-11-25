import type { Metadata } from "@orbitid/shared";
import type { Actor } from "./common";
import type {
  OrganizationMembershipResource,
  UserOrganizationInvitationResource,
  OrganizationSuggestionResource,
} from "./organization";
import type { SignInResource, SignUpResource } from "./auth-flow";

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
/** An OAuth application the signed-in user may use (`user.getOAuthApplications()`). */
export interface UserOAuthApplicationResource {
  id: string;
  name: string;
  clientId?: string;
  client_id?: string;
  organizationId?: string | null;
  organization_id?: string | null;
  organization?: { id: string; name: string; slug?: string | null } | null;
  /** `instance` (instance-wide), `membership` (member of the owning organization) or `grant` (operator grant). */
  access: "instance" | "membership" | "grant";
  billingPortalUrl?: string | null;
  billing_portal_url?: string | null;
}

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
  /** `GET /v1/client/me/oauth_applications` (absent in older SDK builds). */
  getOAuthApplications?(): Promise<UserOAuthApplicationResource[]>;
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
