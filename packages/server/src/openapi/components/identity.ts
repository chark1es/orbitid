/**
 * User, session, sign-in, verification, and factor schemas.
 */
import { timestamps } from "./shared";
import { arr, bool, enm, freeObject, int, lit, nullable, obj, opt, ref, str, type Schema } from "../schema";

export const verification: Schema = obj({
  status: enm(["unverified", "verified", "transferable", "failed", "expired"]),
  strategy: str({ description: "How the factor is proven: `email_code`, `email_link`, `phone_code`, `totp`, `backup_code`, `passkey`, `from_oauth_<provider>`, …" }),
  attempts: nullable(int()),
  expire_at: nullable(int()),
  external_verification_redirect_url: opt(nullable(str({ format: "uri" }))),
  error: opt(nullable(obj({ code: str(), message: str() }))),
  nonce: opt(nullable(str())),
});

export const emailAddress: Schema = obj({
  object: lit("email_address"),
  id: str(),
  email_address: str({ format: "email" }),
  verification: nullable(ref("Verification")),
  linked_to: arr(obj({ type: str(), id: str() })),
  reserved: bool(),
  ...timestamps,
});

export const phoneNumber: Schema = obj({
  object: lit("phone_number"),
  id: str(),
  phone_number: str({ description: "E.164 number, for example `+15551234567`." }),
  reserved_for_second_factor: bool(),
  default_second_factor: bool(),
  verification: nullable(ref("Verification")),
  linked_to: arr(obj({ type: str(), id: str() })),
  ...timestamps,
});

export const externalAccount: Schema = obj({
  object: lit("external_account"),
  id: str(),
  provider: str({ description: "Provider key, for example `google`, `github` or `oauth_custom_work`.", example: "google" }),
  provider_user_id: str(),
  identification_id: str(),
  email_address: str(),
  first_name: str(),
  last_name: str(),
  username: nullable(str()),
  image_url: nullable(str()),
  avatar_url: nullable(str()),
  approved_scopes: str(),
  public_metadata: freeObject(),
  label: nullable(str()),
  verification: nullable(ref("Verification")),
  ...timestamps,
});

export const passkey: Schema = obj({
  object: lit("passkey"),
  id: str(),
  name: str(),
  verification: nullable(ref("Verification")),
  last_used_at: nullable(int()),
  ...timestamps,
});

export const trustedDevice: Schema = obj({
  object: lit("trusted_device"),
  id: str(),
  user_id: str(),
  label: nullable(str({ description: "Browser and system taken from the user agent." })),
  user_agent: nullable(str()),
  ip_address: nullable(str()),
  expires_at: int({ description: "Fixed at creation; using the device does not extend it." }),
  last_used_at: nullable(int()),
  revoked_at: nullable(int()),
  ...timestamps,
});

export const operatorSession: Schema = obj({
  object: lit("operator_session"),
  id: str({ description: "Session id (`osess_…`). The session token itself is only ever in the httpOnly cookie." }),
  expires_at: int({ description: "Epoch milliseconds. After this the cookie is refused and must be exchanged again." }),
}, { description: "A dashboard operator session. The secret key is never part of this object or any response." });

export const user: Schema = obj({
  object: lit("user"),
  id: str(),
  external_id: nullable(str()),
  username: nullable(str()),
  first_name: nullable(str()),
  last_name: nullable(str()),
  image_url: str({ description: "Profile image URL, or a generated initials image." }),
  has_image: bool(),
  primary_email_address_id: nullable(str()),
  primary_phone_number_id: nullable(str()),
  password_enabled: bool(),
  totp_enabled: bool(),
  backup_code_enabled: bool(),
  two_factor_enabled: bool(),
  passkeys: arr(ref("Passkey")),
  email_addresses: arr(ref("EmailAddress")),
  phone_numbers: arr(ref("PhoneNumber")),
  external_accounts: arr(ref("ExternalAccount")),
  public_metadata: freeObject(),
  unsafe_metadata: freeObject(),
  private_metadata: opt(freeObject({ description: "Backend API only. Never returned by the Frontend API." })),
  banned: bool(),
  locked: bool(),
  lockout_expires_in_seconds: nullable(int()),
  verification_attempts_remaining: nullable(int()),
  delete_self_enabled: bool(),
  create_organization_enabled: bool(),
  create_organizations_limit: nullable(int()),
  roles: arr(str({ description: "Instance-wide role keys assigned by an operator (`app:...`). Never editable by the user." })),
  role_permissions: arr(str({ description: "Union of the permissions granted by `roles`." })),
  last_sign_in_at: nullable(int()),
  last_active_at: nullable(int()),
  legal_accepted_at: nullable(int()),
  ...timestamps,
});

export const session: Schema = obj({
  object: lit("session"),
  id: str(),
  status: enm(["active", "ended", "expired", "removed", "abandoned", "replaced", "revoked", "pending"]),
  expire_at: int(),
  abandon_at: int(),
  last_active_at: int(),
  last_active_organization_id: nullable(str()),
  actor: opt(nullable(freeObject({ description: "Historical impersonation context; impersonation was removed and no new session carries it." }))),
  user: opt(nullable(ref("User"))),
  public_user_data: nullable(obj({ user_id: str(), first_name: nullable(str()), last_name: nullable(str()), image_url: str(), has_image: bool(), identifier: str() })),
  factor_verification_age: nullable(arr(int(), { description: "Minutes since the first and the second factor were verified; `-1` when never." })),
  sign_in_method: nullable(enm(["password", "email_code", "email_link", "sms", "passkey", "oauth", "sso", "ticket"])),
  last_active_token: nullable(obj({ object: lit("token"), jwt: str() })),
  latest_activity: opt(nullable(obj({
    id: str(), is_mobile: bool(), ip_address: str(), city: nullable(str()), country: nullable(str()),
    browser_name: str(), browser_version: str(), device_type: str(),
  }))),
  ...timestamps,
});

export const signIn: Schema = obj({
  object: lit("sign_in"),
  id: str(),
  status: enm(["needs_identifier", "needs_first_factor", "needs_second_factor", "needs_new_password", "complete"]),
  supported_identifiers: arr(enm(["email_address", "phone_number", "username", "web3_wallet", "passkey"])),
  supported_first_factors: nullable(arr(ref("SignInFactor"))),
  supported_second_factors: nullable(arr(ref("SignInFactor"))),
  first_factor_verification: nullable(ref("Verification")),
  second_factor_verification: nullable(ref("Verification")),
  identifier: nullable(str()),
  user_data: opt(nullable(obj({ first_name: nullable(str()), last_name: nullable(str()), image_url: str(), has_image: bool() }))),
  created_session_id: nullable(str()),
  abandon_at: int(),
});

export const signInFactor: Schema = obj(
  {
    strategy: str(),
    email_address_id: opt(str()),
    safe_identifier: opt(str()),
    phone_number_id: opt(str()),
    primary: opt(bool()),
    default: opt(bool()),
  },
  { description: "One way the user can satisfy a sign-in step." },
);

export const signUp: Schema = obj({
  object: lit("sign_up"),
  id: str(),
  status: enm(["missing_requirements", "complete", "abandoned"]),
  required_fields: arr(str()),
  optional_fields: arr(str()),
  missing_fields: arr(str()),
  unverified_fields: arr(str()),
  verifications: obj({
    email_address: nullable(ref("Verification")),
    phone_number: nullable(ref("Verification")),
    external_account: nullable(ref("Verification")),
    web3_wallet: nullable(ref("Verification")),
  }),
  username: nullable(str()),
  email_address: nullable(str()),
  phone_number: nullable(str()),
  first_name: nullable(str()),
  last_name: nullable(str()),
  password_enabled: bool(),
  unsafe_metadata: freeObject(),
  public_metadata: freeObject(),
  custom_action: bool(),
  external_id: nullable(str()),
  created_session_id: nullable(str()),
  created_user_id: nullable(str()),
  abandon_at: int(),
  legal_accepted_at: nullable(int()),
});

export const client: Schema = obj({
  object: lit("client"),
  id: str(),
  sessions: arr(ref("Session")),
  sign_in: nullable(ref("SignIn")),
  sign_up: nullable(ref("SignUp")),
  last_active_session_id: nullable(str()),
  cookie_expires_at: nullable(int()),
  ...timestamps,
});

export const userRoles: Schema = obj({
  object: lit("user_roles"),
  user_id: str(),
  roles: arr(str({ description: "Instance role keys, sorted." })),
  role_permissions: arr(str({ description: "Union of the permissions those roles grant, sorted." })),
}, { description: "The instance-wide roles of a user. Written only by the operator's Backend API call." });

export const signInToken: Schema = obj({
  object: lit("sign_in_token"),
  id: str(),
  user_id: str(),
  status: enm(["pending", "accepted", "revoked"]),
  token: opt(str({ description: "One-time token, returned only from the creating request." })),
  url: opt(str()),
  ...timestamps,
});

export const totp: Schema = obj({
  object: lit("totp"),
  id: str({ description: "The user id." }),
  verified: bool(),
  secret: nullable(str({ description: "Base32 secret, returned once during setup." })),
  uri: nullable(str({ description: "`otpauth://` URI for authenticator apps." })),
  qr_code: nullable(str({ description: "`data:` URL of a QR code for the URI." })),
  backup_code_enabled: bool(),
  backup_codes: opt(arr(ref("BackupCode"))),
});

export const backupCode: Schema = obj({ object: lit("backup_code"), code: str(), used: bool() });

export const externalAccountAccessToken: Schema = obj({
  object: lit("external_account_access_token"),
  token: nullable(str()),
  expires_at: nullable(int()),
  scopes: str(),
});

export const sessionToken: Schema = obj({ object: opt(lit("token")), jwt: str({ description: "Signed session JWT." }) });
