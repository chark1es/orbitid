import { componentStrings } from "./componentStrings";
import { mergeLocalization } from "./merge";
import type { DeepMerge, DotPaths, LocalizationResource } from "./types";
import { baseAuthStrings } from "./strings/base-auth";
import { baseProfileStrings } from "./strings/base-profile";
import { baseOrganizationStrings } from "./strings/base-organization";
import { baseMiscStrings } from "./strings/base-misc";

/**
 * Default (en-US) strings for every OrbitID component. Component-specific copy lives in
 * `componentStrings.ts`; locales inherit anything they do not override.
 */
const baseStrings = {
  locale: "en-US",

  backButton: "Back",
  dividerText: "or",
  copyButton__copied: "Copied",
  copyButton__copy: "Copy",
  formButtonPrimary: "Continue",
  formButtonPrimary__save: "Save",
  formButtonPrimary__verify: "Verify",
  formButtonReset: "Cancel",

  badge__active: "Active",
  badge__current: "Current",
  badge__default: "Default",
  badge__done: "Done",
  badge__expired: "Expired",
  badge__failed: "Failed",
  badge__inactive: "Inactive",
  badge__pastDue: "Past due",
  badge__pending: "Pending",
  badge__primary: "Primary",
  badge__requiresAction: "Requires action",
  badge__unverified: "Unverified",
  badge__verified: "Verified",
  badge__you: "You",

  maintenanceMode: "We are currently performing maintenance. Please check back soon.",

  status: {
    loading: "Loading…",
    failed: "Something went wrong while loading OrbitID.",
    retry: "Retry",
  },

  footerActionText__signIn: "Already have an account?",
  footerActionLink__signIn: "Sign in",
  footerActionText__signUp: "Don't have an account?",
  footerActionLink__signUp: "Sign up",
  footerActionLink__useAnotherMethod: "Use another method",
  footerActionLink__alternativePhoneCodeProvider: "Send a code to your phone instead",
  footerActionLink__resendEmailCode: "Resend code",
  footerActionLink__useEmailCode: "Use email code instead",
  footerActionLink__usePasskey: "Use a passkey instead",
  footerPageLink__help: "Help",
  footerPageLink__privacy: "Privacy",
  footerPageLink__terms: "Terms",

  paginationButton__next: "Next",
  paginationButton__previous: "Previous",
  paginationRowText__displaying: "Displaying",
  paginationRowText__of: "of",
  paginationRowText__resultCount: "{{count}} result",
  paginationRowText__resultCount_plural: "{{count}} results",
  paginationRowText__empty: "No results",

  formFieldLabel__emailAddress: "Email address",
  formFieldLabel__emailAddresses: "Email addresses",
  formFieldLabel__phoneNumber: "Phone number",
  formFieldLabel__username: "Username",
  formFieldLabel__firstName: "First name",
  formFieldLabel__lastName: "Last name",
  formFieldLabel__password: "Password",
  formFieldLabel__currentPassword: "Current password",
  formFieldLabel__newPassword: "New password",
  formFieldLabel__confirmPassword: "Confirm password",
  formFieldLabel__confirmDeletion: "Confirmation",
  formFieldLabel__code: "Verification code",
  formFieldLabel__backupCode: "Backup code",
  formFieldLabel__role: "Role",
  formFieldLabel__organizationName: "Organization name",
  formFieldLabel__organizationSlug: "Slug",
  formFieldLabel__organizationDomain: "Domain",
  formFieldLabel__organizationDomainEmailAddress: "Verification email address",
  formFieldLabel__automaticInvitations: "Enable automatic invitations for this domain",
  formFieldLabel__signOutOfOtherSessions: "Sign out of all other devices",
  formFieldLabel__apiKeyName: "Name",
  formFieldLabel__apiKeyDescription: "Description",
  formFieldLabel__apiKeyScopes: "Scopes",
  formFieldLabel__expirationDate: "Expiration date",

  formFieldInputPlaceholder__emailAddress: "you@example.com",
  formFieldInputPlaceholder__emailAddresses: "you@example.com, you@example.org",
  formFieldInputPlaceholder__phoneNumber: "+1 (555) 000-0000",
  formFieldInputPlaceholder__username: "your-username",
  formFieldInputPlaceholder__firstName: "First name",
  formFieldInputPlaceholder__lastName: "Last name",
  formFieldInputPlaceholder__password: "Enter your password",
  formFieldInputPlaceholder__backupCode: "Enter backup code",
  formFieldInputPlaceholder__organizationName: "My organization",
  formFieldInputPlaceholder__organizationSlug: "my-organization",
  formFieldInputPlaceholder__organizationDomain: "example.com",
  formFieldInputPlaceholder__organizationDomainEmailAddress: "you@example.com",
  formFieldInputPlaceholder__confirmDeletionUserAccount: "Delete account",
  formFieldInputPlaceholder__apiKeyName: "My API key",

  formFieldLabel__organizationLogo: "Logo",
  formFieldLabel__removeEmail: "Remove {{identifier}}",
  formFieldError__invalidEmail: "Enter a valid email address.",
  formFieldError__duplicateEmail: "That email address was already added.",
  formFieldError__domainInvalid: "Enter a valid domain, e.g. example.com.",

  formFieldAction__forgotPassword: "Forgot password?",
  formFieldHintText__optional: "Optional",
  formFieldHintText__slug: "A slug is a human-readable ID that must be unique.",
  formFieldError__notMatchingPasswords: "Passwords do not match.",
  formFieldError__matchingPasswords: "Passwords match.",
  formFieldError__verificationLinkExpired: "The verification link has expired. Please request a new one.",
  formFieldError__slugInvalid: "Slug may only contain lowercase letters, numbers and hyphens.",
  formFieldError__slugTaken: "This slug is already taken.",

  membershipRole__admin: "Admin",
  membershipRole__basicMember: "Member",
  membershipRole__guestMember: "Guest",

  social: {
    continue: "Continue",
    continue_with: "Continue with {{provider}}",
    signInWith: "Sign in with {{provider}}",
    signUpWith: "Sign up with {{provider}}",
    lastUsed: "Last used",
  },
  ...baseAuthStrings,
  ...baseProfileStrings,
  ...baseOrganizationStrings,
  ...baseMiscStrings,

  unstable__errors: {
    // generic
    resource_not_found: "The requested resource was not found.",
    form_param_missing: "A required field is missing.",
    form_param_format_invalid: "This value is not in a valid format.",
    form_param_nil: "This field cannot be empty.",
    form_param_value_invalid: "Please enter a valid value.",
    form_param_unknown: "Unknown field.",
    request_body_invalid: "The request could not be processed.",
    not_allowed_access: "You do not have access to this resource.",
    authorization_invalid: "Your authorization is invalid. Please sign in again.",
    authentication_invalid: "Your session is invalid. Please sign in again.",
    secret_key_invalid: "Invalid secret key.",
    rate_limit_exceeded: "Too many requests. Please try again later.",
    bot_detected: "We could not verify you are human. Please try again.",
    network_error: "Network error. Please check your connection and try again.",
    unknown_error: "Something went wrong. Please try again.",
    // delivery
    email_delivery_failed: "We couldn't send the email. Please try again.",
    link_different_browser: "Open the link in the browser where you started signing in, or ask for an email code instead.",

    // identifiers / credentials
    form_identifier_not_found: "Couldn't find your account.",
    form_identifier_exists: "This identifier is already in use.",
    form_password_incorrect: "Password is incorrect. Try again, or use another method.",
    form_password_pwned: "This password has been found in a data breach. Choose a different password.",
    form_password_length_too_short: "Password must be at least {{min}} characters long.",
    form_password_not_strong_enough: "Your password is not strong enough.",
    form_username_invalid_length: "Username must be between {{min}} and {{max}} characters long.",
    form_username_invalid_character: "Username can only contain letters, numbers, underscores and hyphens.",
    form_code_incorrect: "Incorrect code. Please try again.",
    verification_expired: "This verification has expired. Please request a new one.",
    verification_failed: "Verification failed. Please try again.",
    verification_already_verified: "This is already verified.",
    too_many_attempts: "Too many attempts. Please try again later.",

    // sign in / sign up
    strategy_for_user_invalid: "This sign-in strategy is not supported for this account.",
    identification_claimed: "This identifier is already claimed.",
    identifier_already_signed_in: "This identifier is already signed in.",
    session_exists: "This session already exists.",
    client_state_invalid: "Invalid client state. Please reload the page.",
    sign_up_cannot_be_used: "Sign-up cannot be used right now.",
    sign_up_restricted: "Sign-up is restricted for this application.",
    sign_up_mode_restricted: "Sign-up is restricted for this application.",
    sign_up_restricted_waitlist: "This application is in waitlist mode. Join the waitlist to get access.",
    not_allowed_to_sign_up: "You are not allowed to sign up with this identifier.",
    identifier_not_allowed_access: "This identifier is not allowed to sign up.",
    invitation_account_not_exists: "You need an account before accepting this invitation.",
    ticket_invalid: "This sign-in ticket is invalid.",
    ticket_expired: "This sign-in ticket has expired.",

    // account
    user_locked: "Your account has been locked due to too many failed attempts.",
    session_pending: "Finish setting up two-factor authentication before continuing.",
    user_banned: "Your account has been banned.",
    session_reverification_required: "Please verify your identity to continue.",
    needs_second_factor: "Two-step verification is required for this account.",
    last_identification_cannot_be_removed: "You cannot remove your last identification.",

    // oauth
    oauth_provider_not_enabled: "This provider is not enabled.",
    oauth_callback_error: "Could not complete the OAuth flow. Please try again.",
    external_account_exists: "This external account is already connected.",
    external_account_not_found: "External account not found.",

    // organizations
    organization_not_found: "Organization not found.",
    organization_slug_taken: "This slug is already taken.",
    organization_membership_quota_exceeded: "You have reached the maximum number of organizations.",
    organizations_disabled: "Organizations are disabled for this application.",
    organization_creation_not_allowed: "You are not allowed to create organizations.",
    duplicate_record: "This record already exists.",
    not_a_member_in_organization: "You are not a member of this organization.",
    org_role_not_found: "Role not found.",
    organization_minimum_permissions_needed: "You must be an admin to perform this action.",
    org_permission_required: "You do not have permission to perform this action.",

    // webauthn / mfa
    webauthn_not_supported: "Passkeys are not supported on this device.",
    passkey_registration_failure: "Could not create a passkey. Please try again.",
    passkey_authentication_failure: "Could not verify the passkey. Please try again.",
    totp_not_enabled: "Authenticator application is not enabled.",
    mfa_not_enabled: "Two-step verification is not enabled.",

    // api keys / m2m / oauth app
    api_key_invalid: "This API key is invalid.",
    invalid_grant: "The provided grant is invalid.",
    invalid_client: "Invalid client.",
    invalid_scope: "Invalid scope.",
  },
} satisfies LocalizationResource;

type Dictionary = DeepMerge<typeof componentStrings, typeof baseStrings>;

/** Dot path of every key in the dictionary, e.g. `signIn.start.title`. */
export type TranslationKey = DotPaths<Dictionary>;

/** The single English source: component strings with the base strings merged over them. */
export const enUS: LocalizationResource = mergeLocalization(componentStrings, baseStrings);
