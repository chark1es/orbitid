export { OrbitID, type OrbitIDOptions, type OrbitIDState, type OrbitIDListener, type SetActiveParams, type SetActiveResult, type HandleRedirectCallbackParams, type HandleRedirectCallbackResult } from "./orbit";
export { FapiClient, CLIENT_HEADER, SDK_VERSION, type FapiClientOptions, type FetchLike, type HttpMethod, type RequestOptions } from "./fapi";
export { OrbitAPIResponseError, isOrbitAPIResponseError, parseError, type ParsedError } from "./util/errors";
export { TokenCache, type CachedToken, type TokenCacheOptions } from "./token-cache";
export { CrossTabSync, type SyncMessage } from "./cross-tab-sync";

export { Client } from "./resources/client";
export { Session, SessionVerification, type GetTokenOptions, type SessionPublicUserData, type SessionActivity } from "./resources/session";
export {
  SignIn,
  type SignInCreateParams,
  type PrepareFirstFactorParams,
  type AttemptFirstFactorParams,
  type PrepareSecondFactorParams,
  type AttemptSecondFactorParams,
  type ResetPasswordParams,
  type AuthenticateWithRedirectParams,
  type EmailLinkFlow,
  type EmailLinkFlowOptions,
  type StartEmailLinkFlowParams,
  type SignInFactor,
  type SignInUserData,
} from "./resources/sign-in";
export {
  SignUp,
  type SignUpCreateParams,
  type SignUpVerificationParams,
  type AttemptVerificationParams,
  type AuthenticateWithRedirectParams as SignUpAuthenticateWithRedirectParams,
} from "./resources/sign-up";
export { User, type UpdateUserParams } from "./resources/user";
export { EmailAddress, PhoneNumber, type PhoneNumberParams } from "./resources/contact";
export {
  ExternalAccount,
  Passkey,
  TOTP,
  BackupCodeResource,
  TrustedDevice,
  type ReauthorizeParams,
  type TOTPJSON,
  type TrustedDeviceJSON,
} from "./resources/identity";
export {
  Organization,
  OrganizationMembership,
  type UpdateOrganizationParams,
} from "./resources/organization";
export { OrganizationInvitation } from "./resources/organization-invitation";
export { OrganizationDomain } from "./resources/organization-domain";
export { OrganizationMembershipRequest } from "./resources/organization-membership-request";
export { OrganizationSuggestion } from "./resources/organization-suggestion";
export {
  UserOrganizationInvitation,
  type UserOrganizationInvitationWireJSON,
} from "./resources/organization-user-invitation";
export {
  type OrganizationPublicUserData,
  type PublicOrganizationData,
} from "./resources/organization-shared";
export { Role, Permission } from "./resources/permission";
export { ApiKey, type CreateApiKeyParams, type ListApiKeysParams } from "./resources/api-key";
export {
  Environment,
  AuthConfig,
  UserSettings,
  OrganizationSettings,
  DisplayConfig,
  type AttributeSettings,
  type SocialProviderSettings,
  type SocialProviderStrategy,
  type PasswordSettings,
  type UsernameSettings,
  type SignUpSettings,
  type UserSettingsActions,
  type PasskeySettings,
  type TrustedDevicesSettings,
  type AnonymousSettings,
} from "./resources/environment";
export { Verification } from "./resources/verification";

export { inBrowser, isValidBrowserOnline, isWebAuthnSupported, isWebAuthnAutofillSupported, isWebAuthnPlatformAuthenticatorSupported } from "./util/browser";
export {
  clearLastUsedStrategy,
  isSignInStrategy,
  readLastUsedStrategy,
  recordLastUsedStrategy,
} from "./util/last-used-strategy";
export {
  appendQuery,
  buildRedirectUrl,
  getSafeRedirectUrl,
  isAbsoluteUrl,
  isSafeRedirectUrl,
  toAbsoluteUrl,
  validateRedirectUrl,
  type RedirectValidationOptions,
} from "./util/url";
export { checkReverification, createHasCheck, type HasCheckContext, type HasCheckParams, type ReverificationAges } from "./util/reverification";
export {
  paginationQuery,
  toList,
  toPaginatedResponse,
  toQueryString,
  type PaginatedResponse,
  type PaginationParams,
  type QueryParams,
  type QueryValue,
} from "./util/pagination";
export { decodeJwtPayload, isTokenExpired, tokenExpiresAt, type DecodedJwtPayload } from "./util/jwt";
export type { ReverificationConfig, ReverificationLevel } from "@orbitid/shared";
