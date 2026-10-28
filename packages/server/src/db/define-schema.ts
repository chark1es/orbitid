import { sql } from "drizzle-orm";
import type { Kit } from "./kit";

type Meta = Record<string, unknown>;

/**
 * Every table, defined once. `kit` supplies the dialect's column builders, so the Postgres and SQLite
 * schemas cannot drift. All timestamps are epoch milliseconds (bigint on Postgres, integer on SQLite).
 */
export function defineSchema(kit: Kit) {
  const { table, text, int, bool, json, index, uniqueIndex, primaryKey } = kit;
  const ts = (name: string) => int(name).notNull().$defaultFn(() => Date.now());
  const created = () => ({ createdAt: ts("created_at"), updatedAt: ts("updated_at") });

  // ───────────── instance ─────────────
  /** Single row (id = "default"). `settings` is `InstanceSettings` from @orbitid/shared (secrets included). */
  const instance = table("instance", {
    id: text("id").primaryKey(),
    settings: json<Record<string, unknown>>("settings").notNull(),
    secretKeyHash: text("secret_key_hash"),
    ...created(),
  });

  /** JWT signing keys; private JWK encrypted at rest with ORBITID_ENCRYPTION_KEY (AES-256-GCM). */
  const signingKeys = table("signing_keys", {
    kid: text("kid").primaryKey(),
    alg: text("alg").notNull(),
    publicJwk: json<Record<string, unknown>>("public_jwk").notNull(),
    privateJwkEnc: text("private_jwk_enc").notNull(),
    active: bool("active").notNull().default(true),
    createdAt: ts("created_at"),
    rotatedAt: int("rotated_at"),
  });

  // ───────────── users & identifications ─────────────
  const users = table("users", {
    id: text("id").primaryKey(),
    externalId: text("external_id").unique(),
    username: text("username"),
    usernameLower: text("username_lower").unique(),
    firstName: text("first_name"),
    lastName: text("last_name"),
    imageUrl: text("image_url"),
    hasImage: bool("has_image").notNull().default(false),
    passwordHash: text("password_hash"),
    passwordUpdatedAt: int("password_updated_at"),
    primaryEmailAddressId: text("primary_email_address_id"),
    primaryPhoneNumberId: text("primary_phone_number_id"),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    privateMetadata: json<Meta>("private_metadata").notNull().$defaultFn(() => ({})),
    unsafeMetadata: json<Meta>("unsafe_metadata").notNull().$defaultFn(() => ({})),
    banned: bool("banned").notNull().default(false),
    locked: bool("locked").notNull().default(false),
    lockoutExpiresAt: int("lockout_expires_at"),
    failedAttempts: int("failed_attempts").notNull().default(0),
    // MFA
    totpSecretEnc: text("totp_secret_enc"),
    totpVerified: bool("totp_verified").notNull().default(false),
    /** sha256 hashes of unused backup codes */
    backupCodes: json<string[]>("backup_codes"),
    /** Guest account created without credentials; becomes a regular user once an identifier is attached. */
    isAnonymous: bool("is_anonymous").notNull().default(false),
    deleteSelfEnabled: bool("delete_self_enabled").notNull().default(true),
    createOrganizationEnabled: bool("create_organization_enabled").notNull().default(true),
    createOrganizationsLimit: int("create_organizations_limit"),
    legalAcceptedAt: int("legal_accepted_at"),
    lastSignInAt: int("last_sign_in_at"),
    lastActiveAt: int("last_active_at"),
    ...created(),
  });

  const emailAddresses = table("email_addresses", {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    email: text("email").notNull(), // stored lowercased
    verified: bool("verified").notNull().default(false),
    verifiedAt: int("verified_at"),
    verifiedStrategy: text("verified_strategy"),
    reserved: bool("reserved").notNull().default(false),
    ...created(),
  }, (t) => [uniqueIndex("email_unique_verified").on(t.email).where(sql`${t.verified} = true`), index("email_user_idx").on(t.userId), index("email_addr_idx").on(t.email)]);

  const phoneNumbers = table("phone_numbers", {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    phone: text("phone").notNull(), // E.164
    verified: bool("verified").notNull().default(false),
    verifiedAt: int("verified_at"),
    reservedForSecondFactor: bool("reserved_for_second_factor").notNull().default(false),
    defaultSecondFactor: bool("default_second_factor").notNull().default(false),
    ...created(),
  }, (t) => [uniqueIndex("phone_unique_verified").on(t.phone).where(sql`${t.verified} = true`), index("phone_user_idx").on(t.userId)]);

  const externalAccounts = table("external_accounts", {
    id: text("id").primaryKey(),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    provider: text("provider").notNull(),
    providerUserId: text("provider_user_id").notNull(),
    emailAddress: text("email_address").notNull().default(""),
    firstName: text("first_name").notNull().default(""),
    lastName: text("last_name").notNull().default(""),
    username: text("username"),
    imageUrl: text("image_url"),
    approvedScopes: text("approved_scopes").notNull().default(""),
    accessTokenEnc: text("access_token_enc"),
    refreshTokenEnc: text("refresh_token_enc"),
    tokenExpiresAt: int("token_expires_at"),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    ...created(),
  }, (t) => [uniqueIndex("ext_provider_uid").on(t.provider, t.providerUserId), index("ext_user_idx").on(t.userId)]);

  const passkeys = table("passkeys", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    credentialId: text("credential_id").notNull().unique(), // base64url
    publicKey: text("public_key").notNull(), // base64url COSE key
    counter: int("counter").notNull().default(0),
    transports: json<string[]>("transports"),
    deviceType: text("device_type"),
    backedUp: bool("backed_up").notNull().default(false),
    lastUsedAt: int("last_used_at"),
    ...created(),
  });

  // ───────────── clients, sessions, sign-in/up attempts ─────────────
  const clients = table("clients", {
    id: text("id").primaryKey(),
    /** sha256 of the opaque `__client` cookie value */
    tokenHash: text("token_hash").notNull().unique(),
    lastActiveSessionId: text("last_active_session_id"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    ...created(),
  });

  const sessions = table("sessions", {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("active"),
    lastActiveAt: ts("last_active_at"),
    lastActiveOrganizationId: text("last_active_organization_id"),
    expireAt: int("expire_at").notNull(),
    abandonAt: int("abandon_at").notNull(),
    actor: json<Record<string, unknown>>("actor"),
    /** epoch ms of last successful first/second factor verification (reverification) */
    firstFactorVerifiedAt: int("first_factor_verified_at"),
    secondFactorVerifiedAt: int("second_factor_verified_at"),
    ip: text("ip"),
    userAgent: text("user_agent"),
    city: text("city"),
    country: text("country"),
    /** One of AuthMethod from @orbitid/shared. */
    authMethod: text("auth_method"),
    ...created(),
  }, (t) => [index("sess_user_idx").on(t.userId), index("sess_client_idx").on(t.clientId)]);

  const signIns = table("sign_ins", {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    identifier: text("identifier"),
    userId: text("user_id"),
    /** serialized verification state: { first: VerificationJSON-ish + internal, second: ... , passwordResetPending: bool } */
    state: json<Record<string, unknown>>("state").notNull().$defaultFn(() => ({})),
    createdSessionId: text("created_session_id"),
    abandonAt: int("abandon_at").notNull(),
    ...created(),
  });

  const signUps = table("sign_ups", {
    id: text("id").primaryKey(),
    clientId: text("client_id").notNull().references(() => clients.id, { onDelete: "cascade" }),
    status: text("status").notNull(),
    /** collected fields: emailAddress, phoneNumber, username, firstName, lastName, passwordHash, externalId, legalAcceptedAt, externalAccount{...} */
    fields: json<Record<string, unknown>>("fields").notNull().$defaultFn(() => ({})),
    unsafeMetadata: json<Meta>("unsafe_metadata").notNull().$defaultFn(() => ({})),
    /** per-field verification state: { email_address: {...}, phone_number: {...}, external_account: {...} } */
    verifications: json<Record<string, unknown>>("verifications").notNull().$defaultFn(() => ({})),
    invitationId: text("invitation_id"),
    orgInvitationId: text("org_invitation_id"),
    createdSessionId: text("created_session_id"),
    createdUserId: text("created_user_id"),
    abandonAt: int("abandon_at").notNull(),
    ...created(),
  });

  /** One-time codes / magic-link tokens / tickets, hashed. */
  const verifications = table("verifications", {
    id: text("id").primaryKey(),
    /** e.g. sign_in_first_factor | sign_in_second_factor | sign_up_email | add_email | add_phone | reverify | reset_password | org_domain */
    purpose: text("purpose").notNull(),
    strategy: text("strategy").notNull(), // email_code | email_link | phone_code | ...
    identifier: text("identifier").notNull(), // email / phone the code was sent to
    /** resource that owns the attempt (sign_in id, sign_up id, email_address id, ...) */
    ownerId: text("owner_id").notNull(),
    codeHash: text("code_hash"),
    tokenHash: text("token_hash"),
    attempts: int("attempts").notNull().default(0),
    maxAttempts: int("max_attempts").notNull().default(5),
    redirectUrl: text("redirect_url"),
    /** extra state for the verification (passkey challenge/rpID/origin, email being verified, ...) */
    data: json<Record<string, unknown>>("data"),
    /** magic-link: set when link was clicked in any browser */
    consumedAt: int("consumed_at"),
    verifiedAt: int("verified_at"),
    expiresAt: int("expires_at").notNull(),
    createdAt: ts("created_at"),
  }, (t) => [index("ver_owner_idx").on(t.ownerId, t.purpose), index("ver_token_idx").on(t.tokenHash)]);

  /** In-flight OAuth authorizations (state → flow). */
  const oauthStates = table("oauth_states", {
    state: text("state").primaryKey(),
    provider: text("provider").notNull(),
    codeVerifier: text("code_verifier"),
    nonce: text("nonce"),
    /** { kind: "sign_in"|"sign_up"|"connect", ownerId, userId?, redirectUrl, actionCompleteRedirectUrl, additionalScopes? } */
    flow: json<Record<string, unknown>>("flow").notNull(),
    expiresAt: int("expires_at").notNull(),
  });

  /** Sliding-window rate limit counters (also used for lockout of IPs). */
  const rateLimits = table("rate_limits", {
    key: text("key").primaryKey(),
    count: int("count").notNull(),
    resetAt: int("reset_at").notNull(),
  });

  // ───────────── organizations & RBAC ─────────────
  const organizations = table("organizations", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").unique(),
    imageUrl: text("image_url"),
    hasImage: bool("has_image").notNull().default(false),
    maxAllowedMemberships: int("max_allowed_memberships").notNull().default(5),
    adminDeleteEnabled: bool("admin_delete_enabled").notNull().default(true),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    privateMetadata: json<Meta>("private_metadata").notNull().$defaultFn(() => ({})),
    createdBy: text("created_by"),
    ...created(),
  });
  /** Instance-wide custom roles. System roles `org:admin` and `org:member` are seeded. */
  const roles = table("roles", {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(), // "org:admin"
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    isCreatorEligible: bool("is_creator_eligible").notNull().default(false),
    isSystem: bool("is_system").notNull().default(false),
    ...created(),
  });
  const permissions = table("permissions", {
    id: text("id").primaryKey(),
    key: text("key").notNull().unique(), // "org:billing:manage"
    name: text("name").notNull(),
    description: text("description").notNull().default(""),
    type: text("type").notNull().default("user"), // system | user
    ...created(),
  });
  const rolePermissions = table("role_permissions", {
    roleId: text("role_id").notNull().references(() => roles.id, { onDelete: "cascade" }),
    permissionId: text("permission_id").notNull().references(() => permissions.id, { onDelete: "cascade" }),
  }, (t) => [primaryKey({ columns: [t.roleId, t.permissionId] })]);

  const organizationMemberships = table("organization_memberships", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    roleKey: text("role_key").notNull(),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    privateMetadata: json<Meta>("private_metadata").notNull().$defaultFn(() => ({})),
    ...created(),
  }, (t) => [uniqueIndex("om_org_user").on(t.organizationId, t.userId), index("om_user_idx").on(t.userId)]);

  const organizationInvitations = table("organization_invitations", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    email: text("email").notNull(),
    roleKey: text("role_key").notNull(),
    status: text("status").notNull().default("pending"),
    tokenHash: text("token_hash").notNull().unique(),
    inviterUserId: text("inviter_user_id"),
    redirectUrl: text("redirect_url"),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    privateMetadata: json<Meta>("private_metadata").notNull().$defaultFn(() => ({})),
    expiresAt: int("expires_at"),
    ...created(),
  }, (t) => [index("oi_org_idx").on(t.organizationId), index("oi_email_idx").on(t.email)]);

  const organizationDomains = table("organization_domains", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    enrollmentMode: text("enrollment_mode").notNull().default("manual_invitation"),
    verified: bool("verified").notNull().default(false),
    affiliationEmailAddress: text("affiliation_email_address"),
    ...created(),
  }, (t) => [uniqueIndex("od_org_name").on(t.organizationId, t.name)]);

  const organizationMembershipRequests = table("organization_membership_requests", {
    id: text("id").primaryKey(),
    organizationId: text("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"),
    ...created(),
  });

  // ───────────── instance-level access control ─────────────
  const invitations = table("invitations", {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    status: text("status").notNull().default("pending"),
    tokenHash: text("token_hash").notNull().unique(),
    redirectUrl: text("redirect_url"),
    publicMetadata: json<Meta>("public_metadata").notNull().$defaultFn(() => ({})),
    expiresAt: int("expires_at"),
    ...created(),
  });
  const waitlistEntries = table("waitlist_entries", {
    id: text("id").primaryKey(),
    email: text("email").notNull().unique(),
    status: text("status").notNull().default("pending"),
    invitationId: text("invitation_id"),
    ...created(),
  });
  const allowlistIdentifiers = table("allowlist_identifiers", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull().unique(), // email, phone, or "@domain.com" / "*@domain.com"
    identifierType: text("identifier_type").notNull(),
    invitationId: text("invitation_id"),
    ...created(),
  });
  const blocklistIdentifiers = table("blocklist_identifiers", {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull().unique(),
    identifierType: text("identifier_type").notNull(),
    ...created(),
  });

  // ───────────── tokens & templates ─────────────
  const jwtTemplates = table("jwt_templates", {
    id: text("id").primaryKey(),
    name: text("name").notNull().unique(),
    /** claims with shortcodes e.g. { "email": "{{user.primary_email_address}}", "org": "{{org.slug}}" } */
    claims: json<Record<string, unknown>>("claims").notNull(),
    lifetime: int("lifetime").notNull().default(60),
    allowedClockSkew: int("allowed_clock_skew").notNull().default(5),
    customSigningKey: bool("custom_signing_key").notNull().default(false),
    signingAlgorithm: text("signing_algorithm").notNull().default("RS256"),
    signingKeyEnc: text("signing_key_enc"),
    ...created(),
  });
  const actorTokens = table("actor_tokens", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    actor: json<Record<string, unknown>>("actor").notNull(),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("pending"),
    expiresAt: int("expires_at").notNull(),
    sessionMaxDurationSeconds: int("session_max_duration_seconds").notNull().default(1800),
    ...created(),
  });
  const signInTokens = table("sign_in_tokens", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    status: text("status").notNull().default("pending"),
    expiresAt: int("expires_at").notNull(),
    ...created(),
  });

  /** Remembered browsers that may skip the second factor until `expiresAt`. Only the token hash is stored. */
  const trustedDevices = table("trusted_devices", {
    id: text("id").primaryKey(),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    label: text("label"),
    userAgent: text("user_agent"),
    ipAddress: text("ip_address"),
    expiresAt: int("expires_at").notNull(),
    lastUsedAt: int("last_used_at"),
    revokedAt: int("revoked_at"),
    ...created(),
  }, (t) => [index("trusted_devices_user_idx").on(t.userId)]);

  /** OAuth 2.0 device authorization grant (RFC 8628): a CLI or TV polls with `deviceCodeHash` while the user approves `userCode` in a browser. */
  const deviceCodes = table("device_codes", {
    id: text("id").primaryKey(),
    applicationId: text("application_id").notNull().references(() => oauthApplications.id, { onDelete: "cascade" }),
    deviceCodeHash: text("device_code_hash").notNull().unique(),
    /** Short code the user types, stored upper-case without separators. */
    userCode: text("user_code").notNull().unique(),
    scopes: text("scopes").notNull(),
    /** pending | approved | denied | consumed */
    status: text("status").notNull().default("pending"),
    userId: text("user_id").references(() => users.id, { onDelete: "cascade" }),
    intervalSeconds: int("interval_seconds").notNull().default(5),
    lastPolledAt: int("last_polled_at"),
    expiresAt: int("expires_at").notNull(),
    createdAt: ts("created_at"),
  });

  // ───────────── webhooks ─────────────
  const webhookEndpoints = table("webhook_endpoints", {
    id: text("id").primaryKey(),
    url: text("url").notNull(),
    description: text("description").notNull().default(""),
    eventTypes: json<string[]>("event_types").notNull().$defaultFn(() => []), // [] = all
    secret: text("secret").notNull(), // whsec_<base64>
    disabled: bool("disabled").notNull().default(false),
    ...created(),
  });
  const webhookEvents = table("webhook_events", {
    id: text("id").primaryKey(),
    type: text("type").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull(),
    createdAt: ts("created_at"),
  });
  const webhookDeliveries = table("webhook_deliveries", {
    id: text("id").primaryKey(),
    endpointId: text("endpoint_id").notNull().references(() => webhookEndpoints.id, { onDelete: "cascade" }),
    eventId: text("event_id").notNull().references(() => webhookEvents.id, { onDelete: "cascade" }),
    status: text("status").notNull().default("pending"), // pending | success | failed
    attempt: int("attempt").notNull().default(0),
    responseCode: int("response_code"),
    responseBody: text("response_body"),
    nextAttemptAt: int("next_attempt_at"),
    createdAt: ts("created_at"),
  }, (t) => [index("wd_due_idx").on(t.status, t.nextAttemptAt)]);

  // ───────────── API keys, M2M, OAuth provider, enterprise SSO ─────────────
  const apiKeys = table("api_keys", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    /** user_xxx or org_xxx */
    subject: text("subject").notNull(),
    prefix: text("prefix").notNull(), // first chars shown in UI, e.g. "ak_live_AbCd"
    secretHash: text("secret_hash").notNull().unique(),
    scopes: json<string[]>("scopes").notNull().$defaultFn(() => []),
    claims: json<Record<string, unknown>>("claims"),
    revoked: bool("revoked").notNull().default(false),
    revocationReason: text("revocation_reason"),
    expiresAt: int("expires_at"),
    lastUsedAt: int("last_used_at"),
    createdBy: text("created_by"),
    ...created(),
  }, (t) => [index("ak_subject_idx").on(t.subject)]);
  const machines = table("machines", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    secretHash: text("secret_hash").notNull().unique(),
    scopedMachines: json<string[]>("scoped_machines").notNull().$defaultFn(() => []),
    defaultTokenTtl: int("default_token_ttl").notNull().default(3600),
    ...created(),
  });
  const m2mTokens = table("m2m_tokens", {
    id: text("id").primaryKey(),
    machineId: text("machine_id").notNull().references(() => machines.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    claims: json<Record<string, unknown>>("claims"),
    revoked: bool("revoked").notNull().default(false),
    expiresAt: int("expires_at"),
    createdAt: ts("created_at"),
  });
  const oauthApplications = table("oauth_applications", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    clientId: text("client_id").notNull().unique(),
    clientSecretHash: text("client_secret_hash"),
    isPublic: bool("is_public").notNull().default(false),
    redirectUris: json<string[]>("redirect_uris").notNull().$defaultFn(() => []),
    scopes: text("scopes").notNull().default("openid profile email"),
    consentScreenEnabled: bool("consent_screen_enabled").notNull().default(true),
    pkceRequired: bool("pkce_required").notNull().default(true),
    ...created(),
  });
  /** Authorization codes + access/refresh tokens issued by the OIDC provider. `kind`: code | access | refresh */
  const oauthGrants = table("oauth_grants", {
    id: text("id").primaryKey(),
    kind: text("kind").notNull(),
    applicationId: text("application_id").notNull().references(() => oauthApplications.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    scopes: text("scopes").notNull(),
    redirectUri: text("redirect_uri"),
    codeChallenge: text("code_challenge"),
    codeChallengeMethod: text("code_challenge_method"),
    nonce: text("nonce"),
    revoked: bool("revoked").notNull().default(false),
    expiresAt: int("expires_at").notNull(),
    createdAt: ts("created_at"),
  });
  const oauthConsents = table("oauth_consents", {
    applicationId: text("application_id").notNull().references(() => oauthApplications.id, { onDelete: "cascade" }),
    userId: text("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    scopes: text("scopes").notNull(),
    createdAt: ts("created_at"),
  }, (t) => [primaryKey({ columns: [t.applicationId, t.userId] })]);
  const enterpriseConnections = table("enterprise_connections", {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    protocol: text("protocol").notNull(), // saml | oidc
    provider: text("provider").notNull().default("custom"),
    domains: json<string[]>("domains").notNull().$defaultFn(() => []),
    active: bool("active").notNull().default(false),
    allowSubdomains: bool("allow_subdomains").notNull().default(false),
    allowIdpInitiated: bool("allow_idp_initiated").notNull().default(false),
    syncUserAttributes: bool("sync_user_attributes").notNull().default(true),
    disableAdditionalIdentifications: bool("disable_additional_identifications").notNull().default(false),
    /** SAML: { idpEntityId, idpSsoUrl, idpCertificate, attributeMapping }; OIDC: { clientId, clientSecretEnc, discoveryUrl, ... } */
    config: json<Record<string, unknown>>("config").notNull().$defaultFn(() => ({})),
    ...created(),
  });

  const auditLogs = table("audit_logs", {
    id: text("id").primaryKey(),
    actor: text("actor"),
    action: text("action").notNull(),
    targetType: text("target_type"),
    targetId: text("target_id"),
    metadata: json<Record<string, unknown>>("metadata").notNull().$defaultFn(() => ({})),
    ip: text("ip"),
    createdAt: ts("created_at"),
  }, (t) => [index("audit_created_idx").on(t.createdAt)]);

  return {
    instance,
    signingKeys,
    users,
    emailAddresses,
    phoneNumbers,
    externalAccounts,
    passkeys,
    clients,
    sessions,
    signIns,
    signUps,
    verifications,
    oauthStates,
    rateLimits,
    organizations,
    roles,
    permissions,
    rolePermissions,
    organizationMemberships,
    organizationInvitations,
    organizationDomains,
    organizationMembershipRequests,
    invitations,
    waitlistEntries,
    allowlistIdentifiers,
    blocklistIdentifiers,
    jwtTemplates,
    actorTokens,
    signInTokens,
    webhookEndpoints,
    webhookEvents,
    webhookDeliveries,
    apiKeys,
    machines,
    m2mTokens,
    oauthApplications,
    oauthGrants,
    oauthConsents,
    enterpriseConnections,
    trustedDevices,
    deviceCodes,
    auditLogs,
  };
}

export type Schema = ReturnType<typeof defineSchema>;
export const TABLE_NAMES = ["instance", "signingKeys", "users", "emailAddresses", "phoneNumbers", "externalAccounts", "passkeys", "clients", "sessions", "signIns", "signUps", "verifications", "oauthStates", "rateLimits", "organizations", "roles", "permissions", "rolePermissions", "organizationMemberships", "organizationInvitations", "organizationDomains", "organizationMembershipRequests", "invitations", "waitlistEntries", "allowlistIdentifiers", "blocklistIdentifiers", "jwtTemplates", "actorTokens", "signInTokens", "webhookEndpoints", "webhookEvents", "webhookDeliveries", "apiKeys", "machines", "m2mTokens", "oauthApplications", "oauthGrants", "oauthConsents", "enterpriseConnections", "trustedDevices", "deviceCodes", "auditLogs"] as const;
