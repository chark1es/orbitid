// Enterprise SSO: SAML 2.0 service provider + enterprise OIDC connections.
//
// SAML responses are validated by @node-saml/node-saml (signature, audience, timestamps). Request/flow
// state (including IdP-initiated decisions) travels in RelayState via `oauth_states`, because the SAML
// client is constructed per request and therefore has no in-memory request cache.
import { X509Certificate } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { SAML, ValidateInResponseTo, type CacheProvider, type Profile } from "@node-saml/node-saml";
import { and, eq } from "drizzle-orm";
import { ErrorCodes, OrbitError, type EnterpriseConnectionJSON } from "@orbitid/shared";
import type { AppContext } from "../context";
import * as s from "../db/schema";
import { decrypt, encrypt } from "../lib/crypto";
import type { ExternalProfile } from "./external-identity";
import { first } from "../lib/db";

type ConnectionRow = typeof s.enterpriseConnections.$inferSelect;

export const DEFAULT_ATTRIBUTE_MAPPING = {
  email: "email",
  first_name: "firstName",
  last_name: "lastName",
  user_id: "nameID",
} as const;
export type AttributeMapping = typeof DEFAULT_ATTRIBUTE_MAPPING;

export interface SamlConfig {
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  attributeMapping: AttributeMapping;
}

export interface OidcConfig {
  clientId: string;
  clientSecretEnc: string;
  discoveryUrl: string;
  discovery?: OidcDiscovery;
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri: string;
}

export const spEntityIdFor = (ctx: AppContext, id: string) => `${ctx.env.baseUrl}/v1/saml/${id}`;
export const acsUrlFor = (ctx: AppContext, id: string) => `${ctx.env.baseUrl}/v1/saml/${id}/acs`;
export const metadataUrlFor = (ctx: AppContext, id: string) => `${ctx.env.baseUrl}/v1/saml/${id}/metadata`;

/** Rejects anything that is not a parseable X.509 certificate (the IdP signing certificate). */
export function assertValidCertificate(pem: string): string {
  const trimmed = pem.trim();
  if (!/-----BEGIN CERTIFICATE-----/.test(trimmed) || !/-----END CERTIFICATE-----/.test(trimmed)) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "idp_certificate must be a PEM encoded X.509 certificate", { param_name: "idp_certificate" });
  }
  try {
    const cert = new X509Certificate(trimmed);
    if (!cert.publicKey) throw new Error("no public key");
  } catch {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "idp_certificate is not a valid X.509 certificate", { param_name: "idp_certificate" });
  }
  return trimmed;
}

export function normalizeDomains(domains: string[] | undefined): string[] {
  return [...new Set((domains ?? []).map((d) => d.trim().toLowerCase()).filter(Boolean))];
}

export function assertValidDomains(domains: string[]): void {
  const bad = domains.find((d) => !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(d));
  if (bad) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `"${bad}" is not a valid domain`, { param_name: "domains" });
}

export function samlConfig(conn: ConnectionRow): SamlConfig {
  const cfg = (conn.config ?? {}) as Partial<SamlConfig>;
  if (!cfg.idpEntityId || !cfg.idpSsoUrl || !cfg.idpCertificate) {
    throw new OrbitError(422, ErrorCodes.form_param_missing, "SAML connection is missing IdP configuration");
  }
  return {
    idpEntityId: cfg.idpEntityId,
    idpSsoUrl: cfg.idpSsoUrl,
    idpCertificate: cfg.idpCertificate,
    attributeMapping: { ...DEFAULT_ATTRIBUTE_MAPPING, ...(cfg.attributeMapping ?? {}) },
  };
}

export function oidcConfig(conn: ConnectionRow): OidcConfig {
  const cfg = (conn.config ?? {}) as Partial<OidcConfig>;
  if (!cfg.clientId || !cfg.clientSecretEnc || !cfg.discoveryUrl) {
    throw new OrbitError(422, ErrorCodes.form_param_missing, "OIDC connection is missing client configuration");
  }
  return { clientId: cfg.clientId, clientSecretEnc: cfg.clientSecretEnc, discoveryUrl: cfg.discoveryUrl, discovery: cfg.discovery };
}

const SAML_CACHE_TTL_MS = 10 * 60_000;
/** An assertion issued longer ago than this is refused (node-saml also bounds how long its ID must be remembered). */
const SAML_ASSERTION_MAX_AGE_MS = 24 * 60 * 60_000;

/**
 * Remembers AuthnRequest IDs (so a response must answer a request we issued, once) and assertion IDs
 * (so a captured response cannot be replayed). Rows live in `oauth_states`; better-sqlite3 is synchronous,
 * so each check-then-write below is atomic.
 */
function samlCache(ctx: AppContext): CacheProvider {
  const rowKey = (key: string) => `saml:${key}`;
  const live = async (key: string) => {
    const row = first(await ctx.db.select().from(s.oauthStates).where(eq(s.oauthStates.state, rowKey(key))));
    if (row && row.expiresAt <= Date.now()) {
      await ctx.db.delete(s.oauthStates).where(eq(s.oauthStates.state, rowKey(key)));
      return undefined;
    }
    return row;
  };
  const write = async (key: string, value: string, expiresAt: number) =>
    (await ctx.db.insert(s.oauthStates).values({ state: rowKey(key), provider: "saml_cache", flow: { value }, expiresAt }));
  const valueOf = (row: { flow: Record<string, unknown> } | undefined) => (row ? String(row.flow.value) : null);
  return {
    async saveAsync(key, value) {
      await ctx.db.delete(s.oauthStates).where(eq(s.oauthStates.state, rowKey(key)));
      await write(key, value, Date.now() + SAML_CACHE_TTL_MS);
      return { value, createdAt: Date.now() };
    },
    async getAsync(key) {
      return valueOf(await live(key));
    },
    async removeAsync(key) {
      if (!key) return null;
      const value = valueOf(await live(key));
      await ctx.db.delete(s.oauthStates).where(eq(s.oauthStates.state, rowKey(key)));
      return value;
    },
    async consumeAsync(key) {
      const value = valueOf(await live(key));
      await ctx.db.delete(s.oauthStates).where(eq(s.oauthStates.state, rowKey(key)));
      return value;
    },
    async saveIfAbsentAsync(key, value, expiresAtMs) {
      if (await live(key)) return false;
      // node-saml passes the instant until which it would still accept this assertion.
      await write(key, value, expiresAtMs);
      return true;
    },
  };
}

export function samlClient(ctx: AppContext, conn: ConnectionRow): SAML {
  const cfg = samlConfig(conn);
  return new SAML({
    callbackUrl: acsUrlFor(ctx, conn.id),
    entryPoint: cfg.idpSsoUrl,
    issuer: spEntityIdFor(ctx, conn.id),
    idpCert: cfg.idpCertificate,
    audience: spEntityIdFor(ctx, conn.id),
    wantAssertionsSigned: true,
    // IdPs commonly sign the assertion only; assertion signature is mandatory above.
    wantAuthnResponseSigned: false,
    // Responses must answer a request we issued; IdP-initiated logins (when allowed) carry no InResponseTo.
    validateInResponseTo: conn.allowIdpInitiated ? ValidateInResponseTo.ifPresent : ValidateInResponseTo.always,
    cacheProvider: samlCache(ctx),
    requestIdExpirationPeriodMs: SAML_CACHE_TTL_MS,
    rejectReplayedAssertions: true,
    maxAssertionAgeMs: SAML_ASSERTION_MAX_AGE_MS,
    acceptedClockSkewMs: 5000,
    disableRequestedAuthnContext: true,
  });
}

/** Service provider metadata XML (EntityDescriptor/SPSSODescriptor). */
export function serviceProviderMetadata(ctx: AppContext, conn: ConnectionRow): string {
  return samlClient(ctx, conn).generateServiceProviderMetadata(null, null);
}

export async function samlAuthorizeUrl(ctx: AppContext, conn: ConnectionRow, relayState: string): Promise<string> {
  return samlClient(ctx, conn).getAuthorizeUrlAsync(relayState, undefined);
}

/** Validates a signed POST response and returns the parsed profile. */
export async function validateSamlResponse(ctx: AppContext, conn: ConnectionRow, container: { SAMLResponse?: string }): Promise<Profile> {
  if (!container.SAMLResponse) {
    throw new OrbitError(400, ErrorCodes.verification_failed, "SAMLResponse is missing");
  }
  try {
    const { profile } = await samlClient(ctx, conn).validatePostResponseAsync({ SAMLResponse: container.SAMLResponse });
    if (!profile) throw new Error("no profile");
    return profile;
  } catch (err) {
    throw new OrbitError(400, ErrorCodes.verification_failed, `SAML assertion validation failed: ${(err as Error).message}`);
  }
}

function attributeValue(profile: Profile, name: string): string | undefined {
  if (!name) return undefined;
  if (["nameid", "name_id", "user_id"].includes(name.toLowerCase())) return profile.nameID ?? undefined;
  const attributes = (profile.attributes ?? {}) as Record<string, string | string[] | undefined>;
  const key = attributes[name] !== undefined ? name : Object.keys(attributes).find((k) => k.toLowerCase() === name.toLowerCase());
  const value = key ? attributes[key] : undefined;
  if (Array.isArray(value)) return value[0];
  return value;
}

/** Maps a validated SAML profile through the connection's attribute mapping. */
export function profileToExternalProfile(conn: ConnectionRow, profile: Profile): ExternalProfile {
  const mapping = samlConfig(conn).attributeMapping;
  const email = attributeValue(profile, mapping.email) ?? profile.email ?? undefined;
  const providerUserId = attributeValue(profile, mapping.user_id) ?? profile.nameID ?? email;
  if (!providerUserId) {
    throw new OrbitError(400, ErrorCodes.oauth_callback_error, "SAML assertion did not contain a user identifier");
  }
  return {
    provider: `saml_${conn.id}`,
    providerUserId,
    email: email || undefined,
    emailVerified: !!email,
    firstName: attributeValue(profile, mapping.first_name),
    lastName: attributeValue(profile, mapping.last_name),
    username: profile.nameID && profile.nameID.includes("@") ? profile.nameID.split("@")[0] : profile.nameID ?? undefined,
    raw: { nameID: profile.nameID, sessionIndex: profile.sessionIndex, attributes: profile.attributes },
  };
}

/** Active connection matching an email, a bare domain or an identifier (`user@sub.acme.com`). */
export async function findConnectionForIdentifier(ctx: AppContext, identifier: string): Promise<ConnectionRow | null> {
  const value = identifier.trim().toLowerCase();
  if (!value) return null;
  const domain = (value.includes("@") ? value.slice(value.lastIndexOf("@") + 1) : value).replace(/^https?:\/\//, "").replace(/[/:].*$/, "");
  const rows = (await ctx.db.select().from(s.enterpriseConnections).where(eq(s.enterpriseConnections.active, true)));
  for (const row of rows) {
    for (const candidate of normalizeDomains(row.domains)) {
      if (domain === candidate) return row;
      if (row.allowSubdomains && domain.endsWith(`.${candidate}`)) return row;
    }
  }
  return null;
}

export async function findActiveConnection(ctx: AppContext, id: string): Promise<ConnectionRow | null> {
  return first(await ctx.db.select().from(s.enterpriseConnections)
      .where(and(eq(s.enterpriseConnections.id, id), eq(s.enterpriseConnections.active, true)))) ?? null;
}

// ───────────── enterprise OIDC connection (OrbitID acting as OIDC client) ─────────────

export function encryptClientSecret(ctx: AppContext, secret: string): string {
  return encrypt(ctx.env.encryptionKey, secret);
}

export function decryptClientSecret(ctx: AppContext, conn: ConnectionRow): string {
  return decrypt(ctx.env.encryptionKey, oidcConfig(conn).clientSecretEnc);
}

/** Loads (and caches in `config.discovery`) the IdP discovery document. */
export async function getOidcDiscovery(ctx: AppContext, conn: ConnectionRow): Promise<OidcDiscovery> {
  const cfg = oidcConfig(conn);
  if (cfg.discovery) return cfg.discovery;
  let doc: Record<string, unknown>;
  try {
    const res = await fetch(cfg.discoveryUrl, { headers: { accept: "application/json" } });
    if (!res.ok) throw new Error(`discovery returned ${res.status}`);
    doc = (await res.json()) as Record<string, unknown>;
  } catch (err) {
    throw new OrbitError(400, ErrorCodes.oauth_callback_error, `Could not load OIDC discovery document: ${(err as Error).message}`);
  }
  const discovery: OidcDiscovery = {
    issuer: String(doc.issuer ?? ""),
    authorization_endpoint: String(doc.authorization_endpoint ?? ""),
    token_endpoint: String(doc.token_endpoint ?? ""),
    userinfo_endpoint: doc.userinfo_endpoint ? String(doc.userinfo_endpoint) : undefined,
    jwks_uri: String(doc.jwks_uri ?? ""),
  };
  if (!discovery.issuer || !discovery.authorization_endpoint || !discovery.token_endpoint || !discovery.jwks_uri) {
    throw new OrbitError(400, ErrorCodes.oauth_callback_error, "OIDC discovery document is incomplete");
  }
  await ctx.db.update(s.enterpriseConnections)
            .set({ config: { ...(conn.config ?? {}), discovery }, updatedAt: Date.now() })
            .where(eq(s.enterpriseConnections.id, conn.id));
  return discovery;
}

export function enterpriseOidcAuthorizeUrl(
  conn: ConnectionRow,
  discovery: OidcDiscovery,
  params: { redirectUri: string; state: string; nonce: string; codeChallenge: string; scope?: string },
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", oidcConfig(conn).clientId);
  url.searchParams.set("redirect_uri", params.redirectUri);
  url.searchParams.set("scope", params.scope ?? "openid profile email");
  url.searchParams.set("state", params.state);
  url.searchParams.set("nonce", params.nonce);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export interface EnterpriseOidcTokenResponse {
  access_token: string;
  id_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
}

export async function exchangeEnterpriseOidcCode(
  ctx: AppContext,
  conn: ConnectionRow,
  discovery: OidcDiscovery,
  params: { code: string; redirectUri: string; codeVerifier?: string | null },
): Promise<EnterpriseOidcTokenResponse> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: oidcConfig(conn).clientId,
    client_secret: decryptClientSecret(ctx, conn),
  });
  if (params.codeVerifier) body.set("code_verifier", params.codeVerifier);
  const res = await fetch(discovery.token_endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new OrbitError(400, ErrorCodes.oauth_callback_error, `OIDC token exchange failed (${res.status}): ${text.slice(0, 200)}`);
  }
  const json = (await res.json()) as Record<string, unknown>;
  if (typeof json.access_token !== "string") throw new OrbitError(400, ErrorCodes.oauth_callback_error, "OIDC token response has no access_token");
  return {
    access_token: json.access_token,
    id_token: typeof json.id_token === "string" ? json.id_token : undefined,
    token_type: typeof json.token_type === "string" ? json.token_type : undefined,
    expires_in: typeof json.expires_in === "number" ? json.expires_in : undefined,
    refresh_token: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
  };
}

/** Verifies the IdP's id_token against its published JWKS (issuer + audience + nonce). */
export async function verifyEnterpriseIdToken(
  conn: ConnectionRow,
  discovery: OidcDiscovery,
  idToken: string,
  nonce: string | null,
): Promise<Record<string, unknown>> {
  const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: discovery.issuer,
      audience: oidcConfig(conn).clientId,
    });
    if (nonce && payload.nonce !== nonce) throw new Error("nonce mismatch");
    return payload as Record<string, unknown>;
  } catch (err) {
    throw new OrbitError(400, ErrorCodes.oauth_callback_error, `OIDC id_token verification failed: ${(err as Error).message}`);
  }
}

export async function fetchEnterpriseUserInfo(discovery: OidcDiscovery, accessToken: string): Promise<Record<string, unknown>> {
  if (!discovery.userinfo_endpoint) return {};
  const res = await fetch(discovery.userinfo_endpoint, { headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" } });
  if (!res.ok) throw new OrbitError(400, ErrorCodes.oauth_callback_error, `OIDC userinfo request failed (${res.status})`);
  return (await res.json()) as Record<string, unknown>;
}

/** Builds the external profile for an enterprise OIDC login from id_token + userinfo claims. */
export function enterpriseOidcProfile(conn: ConnectionRow, claims: Record<string, unknown>, tokens: EnterpriseOidcTokenResponse): ExternalProfile {
  const str = (v: unknown) => (typeof v === "string" && v ? v : undefined);
  const sub = str(claims.sub);
  if (!sub) throw new OrbitError(400, ErrorCodes.oauth_callback_error, "OIDC id_token has no subject");
  return {
    provider: `oidc_${conn.id}`,
    providerUserId: sub,
    email: str(claims.email),
    emailVerified: claims.email_verified === true || claims.email_verified === "true",
    firstName: str(claims.given_name) ?? str(claims.first_name),
    lastName: str(claims.family_name) ?? str(claims.last_name),
    username: str(claims.preferred_username) ?? str(claims.username),
    imageUrl: str(claims.picture),
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? Date.now() + tokens.expires_in * 1000 : undefined,
    scopes: str(claims.scope),
    raw: claims,
  };
}

export function serializeConnection(ctx: AppContext, row: ConnectionRow): EnterpriseConnectionJSON {
  const json: EnterpriseConnectionJSON = {
    object: "enterprise_connection",
    id: row.id,
    name: row.name,
    protocol: row.protocol as "saml" | "oidc",
    provider: row.provider,
    domains: normalizeDomains(row.domains),
    active: row.active,
    allow_subdomains: row.allowSubdomains,
    allow_idp_initiated: row.allowIdpInitiated,
    sync_user_attributes: row.syncUserAttributes,
    disable_additional_identifications: row.disableAdditionalIdentifications,
    created_at: row.createdAt,
    updated_at: row.updatedAt,
  };
  if (row.protocol === "saml") {
    const cfg = samlConfig(row);
    json.saml = {
      idp_entity_id: cfg.idpEntityId,
      idp_sso_url: cfg.idpSsoUrl,
      idp_certificate: cfg.idpCertificate,
      attribute_mapping: { ...cfg.attributeMapping },
      acs_url: acsUrlFor(ctx, row.id),
      sp_entity_id: spEntityIdFor(ctx, row.id),
      sp_metadata_url: metadataUrlFor(ctx, row.id),
    };
  } else {
    const cfg = oidcConfig(row);
    json.oidc = {
      client_id: cfg.clientId,
      discovery_url: cfg.discoveryUrl,
      auth_url: cfg.discovery?.authorization_endpoint,
      token_url: cfg.discovery?.token_endpoint,
      user_info_url: cfg.discovery?.userinfo_endpoint,
    };
  }
  return json;
}
