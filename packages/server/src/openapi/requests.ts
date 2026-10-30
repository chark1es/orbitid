/**
 * Request body schemas, written as zod and converted to JSON Schema by `from-zod.ts`.
 *
 * Each mirrors the schema the handler parses in `src/modules/**`. Fields are optional wherever the handler calls
 * `.optional()`/`.nullish()`; `.partial()` keeps this file readable while still documenting which fields can be sent.
 * Schemas the modules already export are imported rather than copied.
 */
import { z } from "zod";
import { WEBHOOK_EVENT_TYPES } from "@orbitid/shared";

const metadata = z.record(z.string(), z.unknown());
const boolish = z.boolean().describe("Accepts `true` and `false` in JSON, and `\"true\"`/`\"1\"` in form bodies.");
const emailList = z.array(z.string()).max(20).describe("Email addresses to add; they are created verified.");
const partial = <T extends z.ZodRawShape>(shape: T) => z.object(shape).partial();

// ---------- Frontend API: sign in / sign up ----------
export const signInCreate = partial({
  identifier: z.string().describe("Email address, phone number or username. Required unless `strategy` is `oauth_*`, `enterprise_sso` or `ticket`."),
  strategy: z.string().describe("First-factor strategy to start with: `password`, `email_code`, `email_link`, `phone_code`, `passkey`, `ticket`, `enterprise_sso` or `oauth_<provider>`."),
  password: z.string(),
  ticket: z.string().describe("Invitation ticket for sign-up. Tickets cannot replace authentication during sign-in; actor and operator-minted sign-in tokens are not accepted."),
  redirect_url: z.string(),
  action_complete_redirect_url: z.string(),
  captcha_token: z.string(),
  transfer: z.boolean().describe("Carry a transferable OAuth verification from a sign-in into this sign-up."),
});

export const signInPrepareFirst = partial({
  strategy: z.string(),
  email_address_id: z.string(),
  phone_number_id: z.string(),
  redirect_url: z.string(),
  captcha_token: z.string(),
});

export const signInAttemptFirst = partial({
  strategy: z.string(),
  code: z.string(),
  password: z.string(),
  signature: z.string().describe("Signed message for a web3 strategy."),
  public_key_credential: z.unknown().describe("WebAuthn assertion for the `passkey` strategy."),
});

export const signInPrepareSecond = partial({ strategy: z.string(), phone_number_id: z.string() });
export const signInAttemptSecond = partial({ strategy: z.string(), code: z.string() });

export const signInResetPassword = z.object({
  password: z.string(),
  sign_out_of_other_sessions: z.boolean().optional(),
  redirect_url: z.string().optional(),
});

export const signUpCreate = partial({
  email_address: z.string(),
  phone_number: z.string(),
  username: z.string(),
  first_name: z.string(),
  last_name: z.string(),
  password: z.string(),
  external_id: z.string().nullable(),
  strategy: z.string().describe("Start an OAuth or enterprise SSO sign-up, for example `oauth_google`."),
  redirect_url: z.string(),
  action_complete_redirect_url: z.string(),
  ticket: z.string().describe("Invitation or waitlist ticket that allows this sign-up."),
  transfer: z.boolean(),
  unsafe_metadata: metadata,
  legal_accepted: boolish,
  captcha_token: z.string(),
});

export const signUpUpdate = signUpCreate;

export const verificationPrepare = partial({ strategy: z.string(), redirect_url: z.string(), captcha_token: z.string() });
export const verificationAttempt = partial({ strategy: z.string(), code: z.string() });

export const waitlistJoin = z.object({ email_address: z.string().email() });

// ---------- Frontend API: the signed-in user ----------
export const meUpdate = partial({
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  username: z.string().nullable(),
  unsafe_metadata: metadata,
  primary_email_address_id: z.string().nullable(),
  primary_phone_number_id: z.string().nullable(),
  legal_accepted: boolish,
});

export const imageUpload = z.object({ file: z.string().describe("Base64 payload, optionally as a `data:` URL.") });
export const passwordChange = z.object({
  current_password: z.string(),
  new_password: z.string(),
  sign_out_of_other_sessions: z.boolean().optional(),
});
export const passwordRemove = z.object({ current_password: z.string() });
export const emailCreate = z.object({ email_address: z.string() });
export const phoneCreate = z.object({ phone_number: z.string() });
export const phoneUpdate = partial({ reserved_for_second_factor: boolish, default_second_factor: boolish });
export const codeVerification = z.object({ code: z.string(), strategy: z.string().optional() });
export const totpAttempt = z.object({ code: z.string() });
export const externalAccountCreate = z.object({
  strategy: z.string().describe("`oauth_<provider>` strategy to connect."),
  redirect_url: z.string().optional(),
  additional_scopes: z.array(z.string()).optional(),
});
export const passkeyCreate = partial({ name: z.string(), authenticator_type: z.enum(["platform", "cross-platform"]) });
export const passkeyAttempt = z.object({
  public_key_credential: z.unknown().describe("WebAuthn registration response."),
  name: z.string().optional(),
});
export const passkeyRename = z.object({ name: z.string().min(1) });

// ---------- Frontend API: sessions ----------
export const sessionTouch = partial({ active_organization_id: z.string().nullable() });
export const sessionTokenRequest = partial({ template: z.string().nullable(), skip_cache: z.boolean() });
export const sessionVerify = partial({ level: z.enum(["first_factor", "second_factor", "multi_factor"]) });
export const sessionVerifyFirst = partial({
  strategy: z.enum(["email_code", "phone_code", "password"]),
  email_address_id: z.string(),
  phone_number_id: z.string(),
});
export const sessionVerifyFirstAttempt = partial({
  strategy: z.enum(["email_code", "phone_code", "password"]),
  code: z.string(),
  password: z.string(),
});
export const sessionVerifySecond = z.object({ strategy: z.enum(["totp", "phone_code", "backup_code"]), phone_number_id: z.string().optional() });
export const sessionVerifySecondAttempt = z.object({ strategy: z.enum(["totp", "phone_code", "backup_code"]), code: z.string() });

// ---------- Frontend API: organizations ----------
export const organizationCreate = z.object({ name: z.string(), slug: z.string().optional() });
export const organizationUpdate = organizationCreate.partial();
export const membershipRole = z.object({ role: z.string().min(1) });
export const membershipJoin = z.object({ organization_id: z.string().min(1) });
export const organizationInvite = partial({
  email_address: z.string(),
  email_addresses: z.array(z.string()).describe("Send several invitations at once; the response is then an array."),
  role: z.string(),
  redirect_url: z.string(),
  expires_in_days: z.number().int(),
});
export const domainCreate = z.object({
  name: z.string(),
  enrollment_mode: z.enum(["manual_invitation", "automatic_invitation", "automatic_suggestion"]).optional(),
});
export const domainEnrollment = z.object({
  enrollment_mode: z.enum(["manual_invitation", "automatic_invitation", "automatic_suggestion"]),
  delete_pending: z.boolean().optional().describe("Revoke invitations that this domain created."),
});
export const affiliationStart = z.object({ affiliation_email_address: z.string() });
export const affiliationAttempt = z.object({ code: z.string() });
export const membershipRequestStatus = z.object({ user_id: z.string(), status: z.enum(["pending", "accepted", "rejected"]) });

// ---------- Frontend API: API keys ----------
export const apiKeyCreateFrontend = z.object({
  name: z.string(),
  scopes: z.array(z.string()).optional(),
  claims: metadata.nullable().optional(),
  seconds_until_expiration: z.number().int().nullable().optional(),
  description: z.string().nullable().optional(),
});

// ---------- Backend API: users ----------
export const userCreate = partial({
  email_address: emailList,
  phone_number: z.array(z.string()).max(20),
  username: z.string(),
  password: z.string(),
  password_digest: z.string().describe("Pre-hashed password. Requires `password_hasher`."),
  password_hasher: z.enum(["bcrypt", "argon2", "scrypt"]),
  skip_password_checks: boolish,
  skip_password_requirement: boolish,
  external_id: z.string(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  public_metadata: metadata,
  private_metadata: metadata,
  unsafe_metadata: metadata,
  totp_secret: z.string(),
  backup_codes: z.array(z.string()),
  created_at: z.number().int().describe("Epoch milliseconds. Defaults to now."),
  delete_self_enabled: boolish,
  create_organization_enabled: boolish,
  legal_accepted_at: z.number().int().nullable(),
});

export const userUpdate = partial({
  external_id: z.string().nullable(),
  username: z.string().nullable(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
  primary_email_address_id: z.string().nullable(),
  primary_phone_number_id: z.string().nullable(),
  password: z.string(),
  password_digest: z.string(),
  password_hasher: z.enum(["bcrypt", "argon2", "scrypt"]),
  skip_password_checks: boolish,
  sign_out_of_other_sessions: boolish,
  totp_secret: z.string().nullable(),
  backup_codes: z.array(z.string()).nullable(),
  public_metadata: metadata,
  private_metadata: metadata,
  unsafe_metadata: metadata,
  delete_self_enabled: boolish,
  create_organization_enabled: boolish,
  create_organizations_limit: z.number().int().nullable(),
  legal_accepted_at: z.number().int().nullable(),
});

export const metadataPatch = partial({ public_metadata: metadata, private_metadata: metadata, unsafe_metadata: metadata });
export const passwordCheck = z.object({ password: z.string() });
export const totpCheck = z.object({ code: z.string() });

// ---------- Backend API: identifiers ----------
export const emailAddressCreate = partial({
  user_id: z.string(),
  email_address: z.string(),
  verified: boolish,
  primary: boolish,
}).required({ user_id: true, email_address: true });
export const identifierUpdate = partial({ verified: boolish, primary: boolish });
export const phoneNumberUpdate = partial({
  verified: boolish,
  primary: boolish,
  reserved_for_second_factor: boolish,
  default_second_factor: boolish,
});
export const phoneNumberCreate = partial({
  user_id: z.string(),
  phone_number: z.string(),
  verified: boolish,
  primary: boolish,
  reserved_for_second_factor: boolish,
}).required({ user_id: true, phone_number: true });
export const allowlistCreate = z.object({
  identifier: z.string(),
  notify: boolish.optional(),
  public_metadata: metadata.optional(),
});
export const blocklistCreate = z.object({ identifier: z.string() });

// ---------- Backend API: clients, tokens, templates ----------
export const clientVerify = z.object({ token: z.string() });
export const signInTokenCreate = partial({
  user_id: z.string(),
  expires_in_seconds: z.number().int().describe("Between 10 seconds and 30 days. Defaults to 30 days."),
}).required({ user_id: true });
/** Kept so the removed endpoint's request shape is still documented; it is refused with 403. */
export const actorTokenCreate = z.object({
  user_id: z.string(),
  actor: z.object({ sub: z.string() }).passthrough().optional().describe("Ignored: impersonation was removed."),
  expires_in_seconds: z.number().int().optional(),
  session_max_duration_in_seconds: z.number().int().optional(),
});
export const jwtTemplateCreate = partial({
  name: z.string(),
  claims: metadata,
  lifetime: z.number().int().describe("Seconds."),
  allowed_clock_skew: z.number().int(),
  custom_signing_key: boolish,
  signing_algorithm: z.enum(["RS256", "ES256", "HS256"]),
}).required({ name: true });

// ---------- Backend API: instance ----------
export const instancePatch = metadata.describe("Partial `InstanceSettings` tree, deep-merged into the current settings. Omit masked secrets to keep them.");
export const testEmail = partial({ to: z.string().email() });
export const revokeReason = partial({ revocation_reason: z.string().nullable() });

// ---------- Backend API: invitations and waitlist ----------
export const invitationCreate = partial({
  email_address: z.string().email(),
  public_metadata: metadata,
  redirect_url: z.string().url(),
  notify: boolish,
  ignore_existing: boolish,
  expires_in_days: z.number().int(),
}).required({ email_address: true });
export const invitationBulk = partial({
  email_addresses: z.array(z.string().email()).describe("At most 100 addresses."),
  public_metadata: metadata,
  redirect_url: z.string().url(),
  notify: boolish,
  ignore_existing: boolish,
  expires_in_days: z.number().int(),
}).required({ email_addresses: true });
export const waitlistCreate = z.object({ email_address: z.string().email() });

// ---------- Backend API: organizations ----------
export const backendOrganizationCreate = partial({
  name: z.string(),
  slug: z.string(),
  created_by: z.string().describe("User id that becomes the organization's creator and first admin."),
  max_allowed_memberships: z.number().int(),
  admin_delete_enabled: z.boolean(),
  public_metadata: metadata,
  private_metadata: metadata,
}).required({ name: true });
export const backendOrganizationUpdate = partial({
  name: z.string(),
  slug: z.string(),
  max_allowed_memberships: z.number().int(),
  admin_delete_enabled: z.boolean(),
});
export const backendMembershipCreate = partial({ user_id: z.string(), role: z.string(), public_metadata: metadata, private_metadata: metadata }).required({ user_id: true });
export const backendMembershipUpdate = partial({ role: z.string(), public_metadata: metadata, private_metadata: metadata });
export const backendInvitationCreate = partial({
  email_address: z.string(),
  role: z.string(),
  inviter_user_id: z.string(),
  redirect_url: z.string(),
  notify: z.boolean(),
  expires_at: z.number().int().describe("Epoch milliseconds."),
  expires_in_days: z.number().int(),
  public_metadata: metadata,
  private_metadata: metadata,
}).required({ email_address: true });
export const backendInvitationBulk = partial({
  email_addresses: z.array(z.string()),
  role: z.string(),
  inviter_user_id: z.string(),
  redirect_url: z.string(),
  notify: z.boolean(),
  expires_at: z.number().int(),
  expires_in_days: z.number().int(),
  public_metadata: metadata,
  private_metadata: metadata,
}).required({ email_addresses: true });
export const backendDomainCreate = domainCreate;
export const backendDomainUpdate = partial({
  enrollment_mode: z.enum(["manual_invitation", "automatic_invitation", "automatic_suggestion"]),
  delete_pending: z.boolean(),
});
export const userRolesSet = z.object({
  roles: z.array(z.string()).max(50).describe("Instance role keys (`app:...`). Replaces the whole set; an empty array clears it."),
});
export const roleCreate = partial({
  key: z.string().describe("`org:<feature>[:<action>]` for an organization role, `app:<feature>[:<action>]` for an instance role."),
  name: z.string(),
  description: z.string(),
  is_creator_eligible: z.boolean().describe("Organization roles only: may be picked as `organizations.creatorRole`."),
  permissions: z.array(z.string()).describe("Permission keys to grant; they must be in the same scope as the role."),
}).required({ key: true, name: true });
export const roleUpdate = partial({
  name: z.string(),
  description: z.string(),
  is_creator_eligible: z.boolean(),
  permissions: z.array(z.string()),
});
export const rolePermissions = z.object({ permissions: z.array(z.string()) });
export const permissionCreate = partial({ key: z.string(), name: z.string(), description: z.string() }).required({ key: true, name: true });
export const permissionUpdate = partial({ name: z.string(), description: z.string() });

// ---------- Backend API: webhooks ----------
export const webhookEndpointCreate = z.object({
  url: z.string().url(),
  description: z.string().optional(),
  event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)).optional(),
});
export const webhookEndpointUpdate = partial({
  url: z.string().url(),
  description: z.string(),
  event_types: z.array(z.enum(WEBHOOK_EVENT_TYPES)),
  disabled: z.boolean(),
  rotate_secret: z.boolean().describe("Replace the signing secret; the response then includes the new one."),
});

// ---------- Backend API: API keys ----------
export const apiKeyCreateBackend = partial({
  name: z.string(),
  subject: z.string().describe("Owner of the key: `user_…` or `org_…`."),
  scopes: z.array(z.string()),
  claims: metadata.nullable(),
  seconds_until_expiration: z.number().int().nullable(),
  description: z.string().nullable(),
  created_by: z.string().nullable(),
}).required({ name: true, subject: true });
export const apiKeyUpdate = partial({
  name: z.string(),
  description: z.string().nullable(),
  scopes: z.array(z.string()),
  claims: metadata.nullable(),
});
export const apiKeyVerify = z.object({ secret: z.string().describe("The `ak_live_…` secret to inspect.") });

// ---------- Backend API: M2M ----------
export const machineCreate = partial({
  name: z.string(),
  scoped_machines: z.array(z.string()),
  default_token_ttl: z.number().int().describe("Seconds."),
}).required({ name: true });
export const machineUpdate = partial({
  name: z.string(),
  scoped_machines: z.array(z.string()),
  default_token_ttl: z.number().int(),
});
export const machineScope = partial({ machine_id: z.string(), scoped_machine_id: z.string() });
export const machineTokenCreate = partial({
  machine_id: z.string(),
  machine_secret: z.string().describe("Machine secret; a Bearer `mk_…` token may be sent instead."),
  seconds_until_expiration: z.number().int(),
  claims: metadata.nullable(),
  token_format: z.enum(["opaque", "jwt"]),
});
export const machineTokenVerify = z.object({ token: z.string() });

// ---------- OAuth applications ----------
export const oauthApplicationCreate = partial({
  name: z.string(),
  redirect_uris: z.array(z.string().url()),
  scopes: z.string().describe("Space separated scopes. Defaults to `openid profile email`."),
  public: z.boolean().describe("Public clients have no secret and must use PKCE."),
  consent_screen_enabled: z.boolean(),
  pkce_required: z.boolean(),
}).required({ name: true });
export const oauthApplicationUpdate = partial({
  name: z.string(),
  redirect_uris: z.array(z.string().url()),
  scopes: z.string(),
  consent_screen_enabled: z.boolean(),
  pkce_required: z.boolean(),
});

// ---------- OAuth / OIDC protocol ----------
export const oauthTokenRequest = partial({
  grant_type: z.enum(["authorization_code", "refresh_token"]),
  code: z.string(),
  redirect_uri: z.string(),
  code_verifier: z.string().describe("PKCE verifier for public clients."),
  refresh_token: z.string(),
  client_id: z.string(),
  client_secret: z.string(),
  scope: z.string(),
}).required({ grant_type: true });
export const oauthRevoke = partial({ token: z.string(), token_type_hint: z.string(), client_id: z.string(), client_secret: z.string() }).required({ token: true });
export const oauthIntrospect = oauthRevoke;
export const oauthConsent = partial({
  client_id: z.string(),
  approve: z.boolean().describe("`false` denies the request; the browser is then sent back with `error=access_denied`."),
  scopes: z.array(z.string()),
  scope: z.string().describe("Space separated alternative to `scopes`."),
  redirect_uri: z.string(),
  state: z.string().nullable(),
  response_type: z.string(),
  nonce: z.string().nullable(),
  code_challenge: z.string().nullable(),
  code_challenge_method: z.string().nullable(),
  prompt: z.string().nullable(),
});
export const m2mOAuthToken = partial({
  grant_type: z.literal("client_credentials"),
  machine_id: z.string(),
  machine_secret: z.string(),
  seconds_until_expiration: z.number().int(),
  claims: metadata.nullable(),
  token_format: z.enum(["opaque", "jwt"]),
});

// ---------- enterprise SSO ----------
export {
  connectionBodySchema as enterpriseConnectionCreate,
  connectionPatchSchema as enterpriseConnectionUpdate,
} from "../modules/machine/enterprise-config";
