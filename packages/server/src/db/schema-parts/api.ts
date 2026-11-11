import type { Kit } from "../kit";
import { dialect } from "../dialect";
import { sql } from "drizzle-orm";
import { tableBuilders, type Meta } from "./columns";
import type { IdentityTables } from "./identity";

export type ApiTables = ReturnType<typeof apiTables>;

export function apiTables(kit: Kit, users: IdentityTables["users"]) {
  const { table, text, int, bool, json, index, uniqueIndex, primaryKey, ts, created } = tableBuilders(kit);

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
    /** RP-initiated logout: only these exact URIs may receive the browser after `end_session`. */
    postLogoutRedirectUris: json<string[]>("post_logout_redirect_uris").notNull().$defaultFn(() => []).default([]),
    scopes: text("scopes").notNull().default("openid profile email"),
    /** Show the consent screen; off means this is a first-party/trusted app and consent is skipped. */
    consentScreenEnabled: bool("consent_screen_enabled").notNull().default(true),
    /**
     * PKCE is mandatory for public clients; confidential clients may opt in. The product default is false, but the
     * original SQLite table was created with a physical `DEFAULT true` and SQLite cannot change a column default
     * without rebuilding the table — forbidden here because `oauth_grants.application_id` cascades from it. The
     * Drizzle default therefore mirrors each dialect's real table (SQLite true, Postgres false), and every insert
     * supplies the value explicitly (`createApplication`, the transfer importer), so stored rows are false by
     * default on both.
     */
    pkceRequired: bool("pkce_required").notNull().default(dialect === "sqlite"),
    accessTokenLifetimeSeconds: int("access_token_lifetime_seconds").notNull().default(3600),
    refreshTokenLifetimeSeconds: int("refresh_token_lifetime_seconds").notNull().default(2592000),
    idTokenLifetimeSeconds: int("id_token_lifetime_seconds").notNull().default(3600),
    /** none | organizations | roles | all — what the `groups` claim contains (see services/oidc/shared.ts). */
    groupsClaim: text("groups_claim").notNull().default("all"),
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
    /** OIDC `nonce` of an authorization code. */
    nonce: text("nonce"),
    /** Token chain id: access and refresh tokens from one authorization share it, so reuse can revoke the whole family. */
    familyId: text("family_id"),
    /** Session that authorized the grant; keeps `sid` and organization claims tied to it. */
    sessionId: text("session_id"),
    /**
     * When a refresh token was rotated out (epoch ms). A retry of this exact token inside the reuse grace window
     * returns `successorId` again and never slides the window; outside it the family is revoked.
     */
    consumedAt: int("consumed_at"),
    /** The refresh token that replaced this consumed one (idempotent retry target). */
    successorId: text("successor_id"),
    /**
     * The successor refresh token sealed with the instance encryption key, kept only so a retry inside the grace
     * window can return the *same* token instead of rotating again. A database dump alone cannot open it.
     */
    successorTokenEnc: text("successor_token_enc"),
    revoked: bool("revoked").notNull().default(false),
    expiresAt: int("expires_at").notNull(),
    createdAt: ts("created_at"),
  }, (t) => [index("oauth_grants_family_idx").on(t.familyId)]);
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

  return { apiKeys, machines, m2mTokens, oauthApplications, oauthGrants, oauthConsents, enterpriseConnections, auditLogs };
}
