/** Error codes returned by every OrbitID API. Mirrors Clerk's error vocabulary. */
export const ErrorCodes = {
  // generic
  resource_not_found: "resource_not_found",
  form_param_missing: "form_param_missing",
  form_param_format_invalid: "form_param_format_invalid",
  form_param_nil: "form_param_nil",
  form_param_value_invalid: "form_param_value_invalid",
  form_param_unknown: "form_param_unknown",
  request_body_invalid: "request_body_invalid",
  not_allowed_access: "not_allowed_access",
  authorization_invalid: "authorization_invalid",
  authentication_invalid: "authentication_invalid",
  secret_key_invalid: "secret_key_invalid",
  rate_limit_exceeded: "rate_limit_exceeded",
  bot_detected: "bot_detected",
  // identifiers / credentials
  form_identifier_not_found: "form_identifier_not_found",
  form_identifier_exists: "form_identifier_exists",
  form_password_incorrect: "form_password_incorrect",
  form_password_pwned: "form_password_pwned",
  form_password_length_too_short: "form_password_length_too_short",
  form_password_not_strong_enough: "form_password_not_strong_enough",
  form_username_invalid_length: "form_username_invalid_length",
  form_username_invalid_character: "form_username_invalid_character",
  form_code_incorrect: "form_code_incorrect",
  verification_expired: "verification_expired",
  verification_failed: "verification_failed",
  verification_already_verified: "verification_already_verified",
  too_many_attempts: "too_many_attempts",
  // sign in/up
  strategy_for_user_invalid: "strategy_for_user_invalid",
  identification_claimed: "identification_claimed",
  identifier_already_signed_in: "identifier_already_signed_in",
  session_exists: "session_exists",
  client_state_invalid: "client_state_invalid",
  sign_up_cannot_be_used: "sign_up_cannot_be_used",
  sign_up_restricted: "sign_up_restricted",
  sign_up_mode_restricted: "sign_up_mode_restricted",
  waitlist_mode: "sign_up_restricted_waitlist",
  not_allowed_to_sign_up: "not_allowed_to_sign_up",
  identifier_not_allowed: "identifier_not_allowed_access",
  invitation_account_not_exists: "invitation_account_not_exists",
  ticket_invalid: "ticket_invalid",
  ticket_expired: "ticket_expired",
  // account
  user_locked: "user_locked",
  user_banned: "user_banned",
  reverification_required: "session_reverification_required",
  needs_second_factor: "needs_second_factor",
  last_identification_cannot_be_removed: "last_identification_cannot_be_removed",
  // oauth
  oauth_provider_not_enabled: "oauth_provider_not_enabled",
  oauth_callback_error: "oauth_callback_error",
  external_account_exists: "external_account_exists",
  external_account_not_found: "external_account_not_found",
  // orgs
  organization_not_found: "organization_not_found",
  organization_slug_taken: "organization_slug_taken",
  organization_membership_quota_exceeded: "organization_membership_quota_exceeded",
  organizations_disabled: "organizations_disabled",
  organization_creation_not_allowed: "organization_creation_not_allowed",
  duplicate_record: "duplicate_record",
  not_a_member_in_organization: "not_a_member_in_organization",
  org_role_not_found: "org_role_not_found",
  last_admin_cannot_leave: "organization_minimum_permissions_needed",
  org_permission_required: "org_permission_required",
  // webauthn / mfa
  webauthn_not_supported: "webauthn_not_supported",
  passkey_registration_failure: "passkey_registration_failure",
  passkey_authentication_failure: "passkey_authentication_failure",
  totp_not_enabled: "totp_not_enabled",
  mfa_not_enabled: "mfa_not_enabled",
  // api keys / m2m / oauth app
  api_key_invalid: "api_key_invalid",
  invalid_grant: "invalid_grant",
  invalid_client: "invalid_client",
  invalid_scope: "invalid_scope",
} as const;
export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

export interface ApiErrorItem {
  code: string;
  message: string;
  long_message?: string;
  meta?: { param_name?: string; session_id?: string; email_addresses?: string[]; [k: string]: unknown };
}

/** Wire format of every error response: `{ errors: ApiErrorItem[], clerk_trace_id }` (we use `trace_id`). */
export interface ApiErrorBody {
  errors: ApiErrorItem[];
  trace_id?: string;
}

/** Thrown by server modules; the error middleware converts it to ApiErrorBody. */
export class OrbitError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public meta?: ApiErrorItem["meta"],
    public longMessage?: string,
  ) {
    super(message);
    this.name = "OrbitError";
  }
  toItem(): ApiErrorItem {
    return { code: this.code, message: this.message, long_message: this.longMessage ?? this.message, meta: this.meta };
  }
}
