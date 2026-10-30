import type { Metadata } from "@orbitid/shared";
import type { VerificationResource } from "./user";

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
