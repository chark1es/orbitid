/**
 * Reusable schemas for the OpenAPI document, mirroring `packages/shared/src/resources.ts`.
 *
 * Every object keeps its `object` discriminator as a `const`, every timestamp is epoch **milliseconds**, and
 * Backend-API-only fields (`private_metadata`, one-time secrets) are marked optional because the Frontend API omits
 * them.
 */
import { WEBHOOK_EVENT_TYPES, instanceSettingsSchema } from "@orbitid/shared";
import { fromZod } from "./from-zod";
import { arr, anyJson, bool, deletedObject, enm, freeObject, int, lit, nullable, obj, opt, ref, str, type Schema } from "./schema";

const timestamps = { created_at: int({ description: "Epoch milliseconds." }), updated_at: int({ description: "Epoch milliseconds." }) };

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
  actor: opt(nullable(freeObject({ description: "Set when a Backend API actor token created the session during impersonation." }))),
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

export const organization: Schema = obj({
  object: lit("organization"),
  id: str(),
  name: str(),
  slug: str(),
  image_url: str(),
  has_image: bool(),
  members_count: opt(int()),
  pending_invitations_count: opt(int()),
  max_allowed_memberships: int(),
  admin_delete_enabled: bool(),
  public_metadata: freeObject(),
  private_metadata: opt(freeObject({ description: "Backend API only." })),
  created_by: nullable(str()),
  ...timestamps,
});

export const organizationMembership: Schema = obj({
  object: lit("organization_membership"),
  id: str(),
  role: str({ description: "Role key, for example `org:admin` or a custom `org:billing`." }),
  role_name: str(),
  permissions: arr(str()),
  public_metadata: freeObject(),
  private_metadata: opt(freeObject({ description: "Backend API only." })),
  organization: ref("Organization"),
  public_user_data: obj({ user_id: str(), first_name: nullable(str()), last_name: nullable(str()), image_url: str(), has_image: bool(), identifier: str() }),
  ...timestamps,
});

export const organizationInvitation: Schema = obj({
  object: lit("organization_invitation"),
  id: str(),
  email_address: str({ format: "email" }),
  organization_id: str(),
  organization_name: opt(str()),
  organization_image_url: opt(str()),
  role: str(),
  role_name: str(),
  status: enm(["pending", "accepted", "revoked", "expired"]),
  public_metadata: freeObject(),
  private_metadata: opt(freeObject({ description: "Backend API only." })),
  url: opt(nullable(str({ description: "Invitation link. Backend API only, and only when no email was sent." }))),
  ...timestamps,
});

export const organizationDomain: Schema = obj({
  object: lit("organization_domain"),
  id: str(),
  organization_id: str(),
  name: str(),
  enrollment_mode: enm(["manual_invitation", "automatic_invitation", "automatic_suggestion"]),
  verification: nullable(ref("Verification")),
  affiliation_email_address: nullable(str()),
  total_pending_invitations: int(),
  total_pending_suggestions: int(),
  ...timestamps,
});

export const organizationMembershipRequest: Schema = obj({
  object: lit("organization_membership_request"),
  id: str(),
  organization_id: str(),
  status: enm(["pending", "accepted", "rejected"]),
  public_user_data: obj({ user_id: str(), first_name: nullable(str()), last_name: nullable(str()), image_url: str(), has_image: bool(), identifier: str() }),
  ...timestamps,
});

export const organizationSuggestion: Schema = obj({
  object: lit("organization_suggestion"),
  id: str(),
  public_organization_data: obj({ id: str(), name: str(), slug: str(), image_url: str(), has_image: bool() }),
  status: enm(["pending", "accepted"]),
  ...timestamps,
});

export const role: Schema = obj({
  object: lit("role"),
  id: str(),
  key: str({ example: "org:billing" }),
  name: str(),
  description: str(),
  is_creator_eligible: bool(),
  permissions: arr(ref("Permission")),
  ...timestamps,
});

export const permission: Schema = obj({
  object: lit("permission"),
  id: str(),
  key: str({ example: "org:billing:manage" }),
  name: str(),
  description: str(),
  type: enm(["system", "user"]),
  ...timestamps,
});

export const invitation: Schema = obj({
  object: lit("invitation"),
  id: str(),
  email_address: str({ format: "email" }),
  status: enm(["pending", "accepted", "revoked", "expired"]),
  url: opt(str({ description: "Invitation link, returned when the email was not sent." })),
  public_metadata: freeObject(),
  created_at: int(),
  updated_at: int(),
  expires_at: nullable(int()),
});

export const waitlistEntry: Schema = obj({
  object: lit("waitlist_entry"),
  id: str(),
  email_address: str({ format: "email" }),
  status: enm(["pending", "invited", "completed", "rejected"]),
  invitation: nullable(ref("Invitation")),
  ...timestamps,
});

export const allowlistIdentifier: Schema = obj({
  object: lit("allowlist_identifier"),
  id: str(),
  identifier: str(),
  identifier_type: enm(["email_address", "phone_number", "web3_wallet"]),
  invitation_id: nullable(str()),
  ...timestamps,
});

export const blocklistIdentifier: Schema = obj({
  object: lit("blocklist_identifier"),
  id: str(),
  identifier: str(),
  identifier_type: enm(["email_address", "phone_number", "web3_wallet"]),
  ...timestamps,
});

export const jwtTemplate: Schema = obj({
  object: lit("jwt_template"),
  id: str(),
  name: str(),
  claims: freeObject(),
  lifetime: int({ description: "Token lifetime in seconds." }),
  allowed_clock_skew: int(),
  custom_signing_key: bool(),
  signing_algorithm: enm(["RS256", "ES256", "HS256"]),
  signing_key: opt(anyJson({ description: "Verification key for templates with a custom signing key: an HS256 secret or a public JWK." })),
  ...timestamps,
});

export const actorToken: Schema = obj({
  object: lit("actor_token"),
  id: str(),
  user_id: str(),
  actor: freeObject({ description: "Claims copied into the session's `act` claim." }),
  status: enm(["pending", "accepted", "revoked"]),
  token: opt(str({ description: "One-time token, returned only from the creating request." })),
  url: opt(str()),
  ...timestamps,
});

export const signInToken: Schema = obj({
  object: lit("sign_in_token"),
  id: str(),
  user_id: str(),
  status: enm(["pending", "accepted", "revoked"]),
  token: opt(str({ description: "One-time token, returned only from the creating request." })),
  url: opt(str()),
  ...timestamps,
});

export const webhookEndpoint: Schema = obj({
  object: lit("webhook_endpoint"),
  id: str(),
  url: str({ format: "uri" }),
  description: str(),
  event_types: arr(enm(WEBHOOK_EVENT_TYPES)),
  disabled: bool(),
  secret: opt(str({ description: "`whsec_…` signing secret. Returned on create, on rotate and from `GET …/secret` only." })),
  ...timestamps,
});

export const webhookDelivery: Schema = obj({
  object: lit("webhook_delivery"),
  id: str(),
  endpoint_id: str(),
  event_id: str(),
  event_type: str(),
  status: enm(["pending", "success", "failed"]),
  attempt: int(),
  response_code: nullable(int()),
  response_body: nullable(str()),
  next_attempt_at: nullable(int()),
  created_at: int(),
});

export const apiKey: Schema = obj({
  object: lit("api_key"),
  id: str(),
  name: str(),
  description: nullable(str()),
  subject: str({ description: "Owner of the key: `user_…` or `org_…`." }),
  prefix: str(),
  secret: opt(str({ description: "`ak_live_…` secret. Returned once, when the key is created." })),
  scopes: arr(str()),
  claims: nullable(freeObject()),
  revoked: bool(),
  expiration: nullable(int()),
  last_used_at: nullable(int()),
  created_by: nullable(str()),
  ...timestamps,
});

export const machine: Schema = obj({
  object: lit("machine"),
  id: str(),
  name: str(),
  scoped_machines: arr(str()),
  default_token_ttl: int({ description: "Seconds." }),
  ...timestamps,
});

export const machineToken: Schema = obj({
  object: lit("machine_token"),
  id: str(),
  machine_id: str(),
  token: opt(str({ description: "Opaque `mt_…` token or JWT, returned only from the creating request." })),
  claims: nullable(freeObject()),
  revoked: bool(),
  expired: bool(),
  expiration: nullable(int()),
  created_at: int(),
});

export const oauthApplication: Schema = obj({
  object: lit("oauth_application"),
  id: str(),
  name: str(),
  client_id: str(),
  client_secret: opt(str({ description: "Returned on create and on secret rotation only." })),
  public: bool(),
  redirect_uris: arr(str({ format: "uri" })),
  scopes: str({ description: "Space separated scopes granted to the application." }),
  consent_screen_enabled: bool(),
  pkce_required: bool(),
  ...timestamps,
});

export const enterpriseConnection: Schema = obj({
  object: lit("enterprise_connection"),
  id: str(),
  name: str(),
  protocol: enm(["saml", "oidc"]),
  provider: str(),
  domains: arr(str()),
  active: bool(),
  allow_subdomains: bool(),
  allow_idp_initiated: bool(),
  sync_user_attributes: bool(),
  disable_additional_identifications: bool(),
  saml: opt(obj({
    idp_entity_id: str(),
    idp_sso_url: str(),
    idp_certificate: str(),
    acs_url: str(),
    sp_entity_id: str(),
    sp_metadata_url: str(),
    attribute_mapping: freeObject(),
  })),
  oidc: opt(obj({
    client_id: str(),
    discovery_url: str(),
    auth_url: opt(str()),
    token_url: opt(str()),
    user_info_url: opt(str()),
  })),
  ...timestamps,
});

export const auditLog: Schema = obj({
  object: lit("audit_log"),
  id: str(),
  actor: nullable(str()),
  action: str(),
  target_type: nullable(str()),
  target_id: nullable(str()),
  metadata: freeObject(),
  ip: nullable(str()),
  created_at: int(),
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

export const environment: Schema = obj({
  object: lit("environment"),
  auth_config: obj({
    identification_requirements: arr(arr(str()), { description: "One entry per accepted identifier combination." }),
    first_factors: arr(str()),
    second_factors: arr(str()),
    single_session_mode: bool(),
    sign_up_mode: enm(["public", "restricted", "waitlist"]),
    legal_consent_required: bool(),
  }),
  user_settings: obj({
    attributes: freeObject({ description: "Per-attribute settings keyed by `email_address`, `password`, …" }),
    social: freeObject({ description: "Enabled social providers keyed by provider name." }),
    password_settings: obj({
      min_length: int(), max_length: int(), require_lowercase: bool(), require_uppercase: bool(),
      require_numbers: bool(), require_special_char: bool(),
    }),
    username_settings: obj({ min_length: int(), max_length: int() }),
    sign_up: obj({ mode: str(), progressive: bool() }),
    actions: obj({ delete_self: bool(), create_organization: bool() }),
    passkey_settings: obj({ allow_autofill: bool(), show_sign_in_button: bool() }),
  }),
  organization_settings: obj({
    enabled: bool(), max_allowed_memberships: int(), creation_enabled: bool(), domains_enabled: bool(),
    membership_requests_enabled: bool(), slug_enabled: bool(), force_organization_selection: bool(),
    creator_role: str(), default_role: str(), max_created_organizations_per_user: nullable(int()),
  }),
  display_config: obj({
    application_name: str(), logo_image_url: nullable(str()), home_url: str(), support_email: nullable(str()),
    terms_url: nullable(str()), privacy_url: nullable(str()), primary_color: str(), theme: str(), branded: bool(),
    captcha_enabled: bool(), captcha_provider: str(), captcha_site_key: str(),
  }),
});

export const instanceSettings: Schema = fromZod(instanceSettingsSchema);

/**
 * `GET /v1/instance` returns the settings tree inline with the instance identity fields. The tree is derived from
 * `instanceSettingsSchema` in `@orbitid/shared` so a new setting appears here without editing this file; secrets are
 * returned masked as `••••` with a sibling `<field>Set` boolean, which is why the object stays open.
 */
export const instance: Schema = obj(
  {
    object: lit("instance"),
    id: lit("default"),
    environment_type: enm(["production", "development"]),
    publishable_key: str(),
    database: obj({ dialect: enm(["postgres", "sqlite"]), driver: str(), label: str() }),
    ...((instanceSettings.properties as Record<string, Schema>) ?? {}),
  },
  {
    description:
      "Instance settings. Secret values (`smtpUrl`, `twilioAuthToken`, `captchaSecret`, social `clientSecret`) are " +
      "returned as `••••` together with a sibling `<field>Set` boolean; send the tree back without the masked values to " +
      "keep the stored secrets.",
    additional: true,
  },
);

export const instanceStats: Schema = obj({
  users_total: int(),
  users_active_7d: int(),
  sessions_active: int(),
  organizations_total: int(),
  signups_by_day: arr(obj({ date: str({ description: "UTC day, `YYYY-MM-DD`." }), count: int() })),
  signins_by_day: arr(obj({ date: str(), count: int() })),
  banned_users: int(),
  locked_users: int(),
  mfa_enabled_users: int(),
  top_social_providers: arr(obj({ provider: str(), count: int() })),
});

export const signingKey: Schema = obj({ object: lit("signing_key"), kid: str(), algorithm: str(), active: bool() });

export const testingToken: Schema = obj({ object: lit("testing_token"), token: str(), expires_at: int() });

export const totalCount: Schema = obj({ object: lit("total_count"), total_count: int() });

export const sessionToken: Schema = obj({ object: opt(lit("token")), jwt: str({ description: "Signed session JWT." }) });

export const health: Schema = obj({
  status: lit("ok"),
  publishable_key: str(),
  database: enm(["postgres", "sqlite"]),
  database_driver: str(),
});

export const jwks: Schema = obj({
  keys: arr(obj(
    {
      kty: str(), kid: str(), use: opt(str()), alg: opt(str()), n: opt(str()), e: opt(str()), x: opt(str()), y: opt(str()), crv: opt(str()),
    },
    { description: "JSON Web Key. RSA keys carry `n`/`e`; EC keys carry `x`/`y`/`crv`." },
  )),
});

export const openIdConfiguration: Schema = obj({
  issuer: str(),
  authorization_endpoint: str(),
  token_endpoint: str(),
  userinfo_endpoint: str(),
  jwks_uri: str(),
  registration_endpoint: opt(str()),
  scopes_supported: arr(str()),
  response_types_supported: arr(str()),
  response_modes_supported: opt(arr(str())),
  grant_types_supported: arr(str()),
  subject_types_supported: arr(str()),
  id_token_signing_alg_values_supported: arr(str()),
  token_endpoint_auth_methods_supported: arr(str()),
  code_challenge_methods_supported: arr(str()),
  claims_supported: opt(arr(str())),
});

export const oauthError: Schema = obj({
  error: str({ example: "invalid_request" }),
  error_description: opt(str()),
});

export const oauthTokenResponse: Schema = obj({
  access_token: str(),
  token_type: lit("Bearer"),
  expires_in: int({ description: "Seconds until the access token expires." }),
  refresh_token: opt(str()),
  id_token: opt(str()),
  scope: str(),
});

export const oauthIntrospection: Schema = obj({
  active: bool(),
  scope: opt(str()),
  client_id: opt(str()),
  username: opt(str()),
  token_type: opt(str()),
  exp: opt(int({ description: "Epoch seconds." })),
  iat: opt(int({ description: "Epoch seconds." })),
  sub: opt(str()),
  aud: opt(str()),
  iss: opt(str()),
});

export const oauthApplicationList: Schema = obj({ data: arr(ref("OAuthApplication")), total_count: int() });

export const userInfo: Schema = obj({ sub: str() }, { description: "Claims for the user behind the access token: `sub`, and whichever of `email`, `email_verified`, `name`, `given_name`, `family_name`, `picture` the scopes allow.", additional: true });

export const deletion: Schema = deletedObject("resource");

export const allSchemas: Record<string, Schema> = {
  Verification: verification,
  EmailAddress: emailAddress,
  PhoneNumber: phoneNumber,
  ExternalAccount: externalAccount,
  Passkey: passkey,
  TrustedDevice: trustedDevice,
  OperatorSession: operatorSession,
  User: user,
  Session: session,
  SignIn: signIn,
  SignInFactor: signInFactor,
  SignUp: signUp,
  Client: client,
  Organization: organization,
  OrganizationMembership: organizationMembership,
  OrganizationInvitation: organizationInvitation,
  OrganizationDomain: organizationDomain,
  OrganizationMembershipRequest: organizationMembershipRequest,
  OrganizationSuggestion: organizationSuggestion,
  Role: role,
  Permission: permission,
  Invitation: invitation,
  WaitlistEntry: waitlistEntry,
  AllowlistIdentifier: allowlistIdentifier,
  BlocklistIdentifier: blocklistIdentifier,
  JwtTemplate: jwtTemplate,
  ActorToken: actorToken,
  SignInToken: signInToken,
  WebhookEndpoint: webhookEndpoint,
  WebhookDelivery: webhookDelivery,
  ApiKey: apiKey,
  Machine: machine,
  MachineToken: machineToken,
  OAuthApplication: oauthApplication,
  EnterpriseConnection: enterpriseConnection,
  AuditLog: auditLog,
  Totp: totp,
  BackupCode: backupCode,
  ExternalAccountAccessToken: externalAccountAccessToken,
  Environment: environment,
  Instance: instance,
  InstanceStats: instanceStats,
  SigningKey: signingKey,
  TestingToken: testingToken,
  TotalCount: totalCount,
  SessionToken: sessionToken,
  Health: health,
  Jwks: jwks,
  OpenIdConfiguration: openIdConfiguration,
  OAuthError: oauthError,
  OAuthTokenResponse: oauthTokenResponse,
  OAuthIntrospection: oauthIntrospection,
  OAuthApplicationList: oauthApplicationList,
  UserInfo: userInfo,
};
