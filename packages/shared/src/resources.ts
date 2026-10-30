/**
 * Wire (JSON, snake_case) representations of every resource. Timestamps are unix epoch **milliseconds**.
 * Frontend API (cookie-authenticated, `/v1/client/*`) and Backend API (secret-key, `/v1/*`) share these shapes;
 * the Backend API simply returns more fields (private_metadata etc.).
 */
export type Metadata = Record<string, unknown>;

export interface VerificationJSON {
  status: "unverified" | "verified" | "transferable" | "failed" | "expired";
  strategy: string; // email_code | email_link | phone_code | from_oauth_google | passkey | totp | backup_code | ...
  attempts: number | null;
  expire_at: number | null;
  external_verification_redirect_url?: string | null; // oauth
  error?: { code: string; message: string } | null;
  nonce?: string | null; // passkey / web3
}

export interface EmailAddressJSON {
  object: "email_address";
  id: string;
  email_address: string;
  verification: VerificationJSON | null;
  linked_to: { type: string; id: string }[];
  reserved: boolean;
  created_at: number;
  updated_at: number;
}
export interface PhoneNumberJSON {
  object: "phone_number";
  id: string;
  phone_number: string;
  reserved_for_second_factor: boolean;
  default_second_factor: boolean;
  verification: VerificationJSON | null;
  linked_to: { type: string; id: string }[];
  created_at: number;
  updated_at: number;
}
export interface ExternalAccountJSON {
  object: "external_account";
  id: string;
  provider: string; // "google" | "github" | "oauth_custom_xyz"
  provider_user_id: string;
  identification_id: string;
  email_address: string;
  first_name: string;
  last_name: string;
  username: string | null;
  image_url: string | null;
  avatar_url: string | null;
  approved_scopes: string;
  public_metadata: Metadata;
  label: string | null;
  verification: VerificationJSON | null;
  created_at: number;
  updated_at: number;
}
export interface PasskeyJSON {
  object: "passkey";
  id: string;
  name: string;
  verification: VerificationJSON | null;
  last_used_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface UserJSON {
  object: "user";
  id: string;
  external_id: string | null;
  username: string | null;
  first_name: string | null;
  last_name: string | null;
  image_url: string;
  has_image: boolean;
  primary_email_address_id: string | null;
  primary_phone_number_id: string | null;
  password_enabled: boolean;
  totp_enabled: boolean;
  backup_code_enabled: boolean;
  two_factor_enabled: boolean;
  passkeys: PasskeyJSON[];
  email_addresses: EmailAddressJSON[];
  phone_numbers: PhoneNumberJSON[];
  external_accounts: ExternalAccountJSON[];
  public_metadata: Metadata;
  unsafe_metadata: Metadata;
  /** Backend API only. */
  private_metadata?: Metadata;
  /** Guest account created without any identifier; flips to false once it gains one. */
  is_anonymous: boolean;
  banned: boolean;
  locked: boolean;
  lockout_expires_in_seconds: number | null;
  verification_attempts_remaining: number | null;
  delete_self_enabled: boolean;
  create_organization_enabled: boolean;
  create_organizations_limit: number | null;
  /** Instance-wide role keys assigned by an operator (`app:...`); never modifiable by the user. */
  roles: string[];
  /** Permissions granted by those instance roles. */
  role_permissions: string[];
  last_sign_in_at: number | null;
  last_active_at: number | null;
  legal_accepted_at: number | null;
  created_at: number;
  updated_at: number;
}

/** How the user proved who they are when the session was created. */
export type AuthMethod = "password" | "email_code" | "email_link" | "sms" | "passkey" | "oauth" | "sso" | "ticket";

export type SessionStatus = "active" | "ended" | "expired" | "removed" | "abandoned" | "replaced" | "revoked" | "pending";
export interface SessionJSON {
  object: "session";
  id: string;
  status: SessionStatus;
  expire_at: number;
  abandon_at: number;
  last_active_at: number;
  last_active_organization_id: string | null;
  actor: { sub: string; [k: string]: unknown } | null;
  user: UserJSON | null; // included in client responses
  public_user_data: { first_name: string | null; last_name: string | null; image_url: string; has_image: boolean; identifier: string; user_id: string } | null;
  factor_verification_age: [number, number] | null; // minutes since first / second factor
  /** The second factor was skipped because this browser holds a valid trusted-device token. */
  second_factor_skipped_by_trusted_device?: boolean;
  sign_in_method: AuthMethod | null;
  last_active_token: { object: "token"; jwt: string } | null;
  latest_activity?: { id: string; is_mobile: boolean; ip_address: string; city: string | null; country: string | null; browser_name: string; browser_version: string; device_type: string } | null;
  created_at: number;
  updated_at: number;
}
export interface ClientJSON {
  object: "client";
  id: string;
  sessions: SessionJSON[];
  sign_in: SignInJSON | null;
  sign_up: SignUpJSON | null;
  last_active_session_id: string | null;
  cookie_expires_at: number | null;
  created_at: number;
  updated_at: number;
}

export type SignInStatus = "needs_identifier" | "needs_first_factor" | "needs_second_factor" | "needs_new_password" | "complete";
export type FirstFactorStrategy =
  | "password" | "email_code" | "email_link" | "phone_code" | "passkey" | "ticket" | "reset_password_email_code" | "reset_password_phone_code" | "web3_metamask_signature" | `oauth_${string}` | "enterprise_sso" | "saml";
export type SecondFactorStrategy = "totp" | "phone_code" | "email_code" | "backup_code";
export interface SignInFactor {
  strategy: string;
  email_address_id?: string; safe_identifier?: string; phone_number_id?: string; primary?: boolean; default?: boolean;
}
export interface SignInJSON {
  object: "sign_in";
  id: string;
  status: SignInStatus;
  supported_identifiers: ("email_address" | "phone_number" | "username" | "web3_wallet" | "passkey")[];
  supported_first_factors: SignInFactor[] | null;
  supported_second_factors: SignInFactor[] | null;
  first_factor_verification: VerificationJSON | null;
  second_factor_verification: VerificationJSON | null;
  identifier: string | null;
  user_data: { first_name: string | null; last_name: string | null; image_url: string; has_image: boolean } | null;
  created_session_id: string | null;
  abandon_at: number;
}

export type SignUpStatus = "missing_requirements" | "complete" | "abandoned";
export interface SignUpJSON {
  object: "sign_up";
  id: string;
  status: SignUpStatus;
  required_fields: string[];
  optional_fields: string[];
  missing_fields: string[];
  unverified_fields: string[]; // e.g. ["email_address"]
  verifications: {
    email_address: VerificationJSON | null;
    phone_number: VerificationJSON | null;
    external_account: VerificationJSON | null;
    web3_wallet: VerificationJSON | null;
  };
  username: string | null;
  email_address: string | null;
  phone_number: string | null;
  first_name: string | null;
  last_name: string | null;
  password_enabled: boolean;
  unsafe_metadata: Metadata;
  public_metadata: Metadata;
  custom_action: boolean;
  external_id: string | null;
  created_session_id: string | null;
  created_user_id: string | null;
  abandon_at: number;
  legal_accepted_at: number | null;
}

// ---------- organizations ----------
export interface OrganizationJSON {
  object: "organization";
  id: string;
  name: string;
  slug: string;
  image_url: string;
  has_image: boolean;
  members_count?: number;
  pending_invitations_count?: number;
  max_allowed_memberships: number;
  admin_delete_enabled: boolean;
  public_metadata: Metadata;
  private_metadata?: Metadata;
  created_by: string | null;
  created_at: number;
  updated_at: number;
}
export interface OrganizationMembershipJSON {
  object: "organization_membership";
  id: string;
  role: string; // "org:admin" | "org:member" | custom "org:xyz"
  role_name: string;
  permissions: string[];
  public_metadata: Metadata;
  private_metadata?: Metadata;
  organization: OrganizationJSON;
  public_user_data: { user_id: string; first_name: string | null; last_name: string | null; image_url: string; has_image: boolean; identifier: string };
  created_at: number;
  updated_at: number;
}
export interface OrganizationInvitationJSON {
  object: "organization_invitation";
  id: string;
  email_address: string;
  organization_id: string;
  organization_name?: string;
  organization_image_url?: string;
  role: string;
  role_name: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  public_metadata: Metadata;
  private_metadata?: Metadata;
  url?: string | null; // backend API, for "no email" flows
  created_at: number;
  updated_at: number;
}
export interface OrganizationDomainJSON {
  object: "organization_domain";
  id: string;
  organization_id: string;
  name: string;
  enrollment_mode: "manual_invitation" | "automatic_invitation" | "automatic_suggestion";
  verification: VerificationJSON | null;
  affiliation_email_address: string | null;
  total_pending_invitations: number;
  total_pending_suggestions: number;
  created_at: number;
  updated_at: number;
}
export interface OrganizationMembershipRequestJSON {
  object: "organization_membership_request";
  id: string;
  organization_id: string;
  status: "pending" | "accepted" | "rejected";
  public_user_data: OrganizationMembershipJSON["public_user_data"];
  created_at: number;
  updated_at: number;
}
export interface OrganizationSuggestionJSON {
  object: "organization_suggestion";
  id: string;
  public_organization_data: { id: string; name: string; slug: string; image_url: string; has_image: boolean };
  status: "pending" | "accepted";
  created_at: number;
  updated_at: number;
}
export interface RoleJSON {
  object: "role";
  id: string;
  key: string;
  name: string;
  description: string;
  /**
   * Where this role can be assigned. `organization` roles (`org:...`) are memberships; `instance` roles
   * are attached to a user by an operator and travel in the session token's `roles` claim.
   */
  scope: "organization" | "instance";
  /** True for the seeded `org:admin` / `org:member` rows, which cannot be edited or deleted. */
  is_system: boolean;
  /** Instance roles may be picked as the `organizations.creatorRole` default. Organization-only. */
  is_creator_eligible: boolean;
  permissions: PermissionJSON[];
  created_at: number;
  updated_at: number;
}
export interface PermissionJSON {
  object: "permission";
  id: string;
  key: string; // "org:team:manage"
  name: string;
  description: string;
  type: "system" | "user";
  /** `organization` for `org:*` keys, `instance` for everything else. */
  scope: "organization" | "instance";
  created_at: number;
  updated_at: number;
}

// ---------- backend-only resources ----------
export interface InvitationJSON { object: "invitation"; id: string; email_address: string; status: "pending" | "accepted" | "revoked" | "expired"; url?: string; public_metadata: Metadata; created_at: number; updated_at: number; expires_at: number | null }
export interface WaitlistEntryJSON { object: "waitlist_entry"; id: string; email_address: string; status: "pending" | "invited" | "completed" | "rejected"; invitation: InvitationJSON | null; created_at: number; updated_at: number }
export interface AllowlistIdentifierJSON { object: "allowlist_identifier"; id: string; identifier: string; identifier_type: "email_address" | "phone_number" | "web3_wallet"; invitation_id: string | null; created_at: number; updated_at: number }
export interface BlocklistIdentifierJSON { object: "blocklist_identifier"; id: string; identifier: string; identifier_type: "email_address" | "phone_number" | "web3_wallet"; created_at: number; updated_at: number }
export interface JwtTemplateJSON { object: "jwt_template"; id: string; name: string; claims: Record<string, unknown>; lifetime: number; allowed_clock_skew: number; custom_signing_key: boolean; signing_algorithm: string; /** Verification key for custom-key templates: HS256 secret, or public JWK. */ signing_key?: string | Record<string, unknown>; created_at: number; updated_at: number }
export interface SignInTokenJSON { object: "sign_in_token"; id: string; user_id: string; status: "pending" | "accepted" | "revoked"; token?: string; url?: string; created_at: number; updated_at: number }
/**
 * Instance-wide roles of a user (`GET`/`PUT /v1/users/{id}/roles`). Written only by an operator through the
 * Backend API; the keys travel in the session token as the `roles` and `role_permissions` claims.
 */
export interface UserRolesJSON { object: "user_roles"; user_id: string; roles: string[]; role_permissions: string[] }
export interface WebhookEndpointJSON { object: "webhook_endpoint"; id: string; url: string; description: string; event_types: string[]; disabled: boolean; secret?: string; created_at: number; updated_at: number }
export interface WebhookDeliveryJSON { object: "webhook_delivery"; id: string; endpoint_id: string; event_id: string; event_type: string; status: "pending" | "success" | "failed"; attempt: number; response_code: number | null; response_body: string | null; next_attempt_at: number | null; created_at: number }
export interface ApiKeyJSON { object: "api_key"; id: string; name: string; description: string | null; subject: string; prefix: string; secret?: string; scopes: string[]; claims: Record<string, unknown> | null; revoked: boolean; expiration: number | null; last_used_at: number | null; created_by: string | null; created_at: number; updated_at: number }
export interface M2MMachineJSON { object: "machine"; id: string; name: string; scoped_machines: string[]; default_token_ttl: number; created_at: number; updated_at: number }
export interface M2MTokenJSON { object: "machine_token"; id: string; machine_id: string; token?: string; claims: Record<string, unknown> | null; revoked: boolean; expired: boolean; expiration: number | null; created_at: number }
export interface OAuthApplicationJSON { object: "oauth_application"; id: string; name: string; client_id: string; client_secret?: string; public: boolean; redirect_uris: string[]; scopes: string; consent_screen_enabled: boolean; pkce_required: boolean; created_at: number; updated_at: number }
export interface EnterpriseConnectionJSON {
  object: "enterprise_connection"; id: string; name: string; protocol: "saml" | "oidc"; provider: string; domains: string[]; active: boolean;
  allow_subdomains: boolean; allow_idp_initiated: boolean; sync_user_attributes: boolean; disable_additional_identifications: boolean;
  saml?: { idp_entity_id: string; idp_sso_url: string; idp_certificate: string; acs_url: string; sp_entity_id: string; sp_metadata_url: string; attribute_mapping: Record<string, string> };
  oidc?: { client_id: string; discovery_url: string; auth_url?: string; token_url?: string; user_info_url?: string };
  created_at: number; updated_at: number;
}
export interface AuditLogJSON { object: "audit_log"; id: string; actor: string | null; action: string; target_type: string | null; target_id: string | null; metadata: Record<string, unknown>; ip: string | null; created_at: number }
/** A browser that may skip the second factor until `expires_at`. The token itself is never serialized. */
export interface TrustedDeviceJSON {
  object: "trusted_device";
  id: string;
  user_id: string;
  label: string | null;
  user_agent: string | null;
  ip_address: string | null;
  expires_at: number;
  last_used_at: number | null;
  revoked_at: number | null;
  created_at: number;
  updated_at: number;
}
export interface PaginatedList<T> { data: T[]; total_count: number }
export interface DeletedObjectJSON { object: string; id: string; deleted: true }
