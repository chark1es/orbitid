// Social OAuth / OIDC provider adapters (arctic under the hood) + profile normalization.
import {
  Atlassian, Bitbucket, Box, Coinbase, Discord, Dropbox, Facebook, GitHub, GitLab, Google, Line, Linear,
  MicrosoftEntraId, Notion, OAuth2Client, CodeChallengeMethod, Slack, Spotify, Twitch, Twitter,
} from "arctic";
import type { OAuth2Tokens } from "arctic";
import { decodeJwt, importPKCS8, jwtVerify, SignJWT } from "jose";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import { sha256 } from "../lib/crypto";
import { assertPublicUrl, remoteJwks, safeFetch } from "../lib/safe-fetch";
import type { ExternalProfile } from "./external-identity";

export interface OAuthProviderConfig {
  key: string;
  name: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  discoveryUrl?: string;
  /** Apple only: the `.p8` key material the server uses to mint the client secret. */
  appleTeamId?: string;
  appleKeyId?: string;
  applePrivateKey?: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string;
  idToken?: string;
  /** Claims of an ID token already verified against the provider's JWKS during the code exchange. */
  idTokenClaims?: Record<string, unknown>;
  raw: Record<string, unknown>;
}

export interface OAuthAdapter {
  key: string;
  /**
   * True when the provider is an OpenID Connect provider: the authorization request then carries a `nonce`
   * and the ID token must repeat it. Providers that only speak OAuth 2 have nothing to bind a nonce to.
   */
  usesNonce?: boolean;
  createAuthorizationUrl(input: { state: string; codeVerifier: string; scopes: string[]; nonce?: string }): Promise<URL>;
  exchangeCode(input: { code: string; codeVerifier: string; nonce?: string }): Promise<OAuthTokenSet>;
  fetchProfile(input: { tokens: OAuthTokenSet }): Promise<ExternalProfile>;
}

export type OAuthAdapterFactory = (cfg: OAuthProviderConfig, redirectUri: string, ctx: AppContext) => OAuthAdapter;

/** Test seam: replaces a provider's adapter (e.g. a fake provider that never leaves the process). */
const adapterOverrides = new Map<string, OAuthAdapterFactory>();
export function registerOAuthProvider(key: string, factory: OAuthAdapterFactory) {
  adapterOverrides.set(key, factory);
}
export function resetOAuthProviders() {
  adapterOverrides.clear();
}

/** `oauth_google` → `google`; `oauth_custom_acme` → `custom_acme`. */
export const providerKeyFromStrategy = (strategy: string) => strategy.replace(/^oauth_/, "");

const PROVIDER_NAMES: Record<string, string> = {
  google: "Google", github: "GitHub", gitlab: "GitLab", discord: "Discord", microsoft: "Microsoft", apple: "Apple",
  facebook: "Facebook", twitter: "Twitter", x: "X", linkedin_oidc: "LinkedIn", slack: "Slack", twitch: "Twitch",
  spotify: "Spotify", bitbucket: "Bitbucket", dropbox: "Dropbox", notion: "Notion", hubspot: "HubSpot",
  tiktok: "TikTok", coinbase: "Coinbase", line: "LINE", linear: "Linear", huggingface: "Hugging Face",
  box: "Box", atlassian: "Atlassian", xero: "Xero",
};

const LOGO_SLUGS: Record<string, string> = { twitter: "x", x: "x", linkedin_oidc: "linkedin", microsoft: "microsoft" };

export const providerDisplayName = (key: string, fallback?: string): string =>
  fallback || PROVIDER_NAMES[key] || (key.startsWith("custom_") ? key.slice(7) : key);

export const providerLogoUrl = (key: string): string =>
  `https://cdn.simpleicons.org/${LOGO_SLUGS[key] ?? (key.startsWith("custom_") ? "openid" : key)}`;

const DEFAULT_SCOPES: Record<string, string[]> = {
  google: ["openid", "email", "profile"],
  github: ["read:user", "user:email"],
  gitlab: ["read_user"],
  discord: ["identify", "email"],
  microsoft: ["openid", "profile", "email", "User.Read"],
  apple: ["name", "email"],
  facebook: ["email", "public_profile"],
  twitter: ["users.read", "tweet.read", "offline.access"],
  x: ["users.read", "tweet.read", "offline.access"],
  linkedin_oidc: ["openid", "profile", "email"],
  slack: ["openid", "profile", "email"],
  twitch: ["user:read:email"],
  spotify: ["user-read-email", "user-read-private"],
  bitbucket: ["account", "email"],
  dropbox: ["account_info.read"],
  notion: [],
  hubspot: ["oauth"],
  tiktok: ["user.info.basic", "user.info.profile"],
  coinbase: ["wallet:user:read", "wallet:accounts:read"],
  line: ["profile", "openid", "email"],
  linear: ["read"],
  huggingface: ["openid", "profile", "email"],
  box: [],
  atlassian: ["read:me", "read:account", "offline_access"],
  xero: ["openid", "profile", "email", "offline_access"],
};

export const providerRedirectUri = (ctx: AppContext, key: string) => `${ctx.env.baseUrl}/v1/oauth_callback/${key}`;

/** Reads the provider's configuration from instance settings (empty client id/secret ⇒ disabled). */
export function providerConfig(ctx: AppContext, key: string): OAuthProviderConfig | null {
  const social = ctx.settings.get().social;
  const cfg = social[key];
  if (!cfg || !cfg.enabled || !cfg.clientId) return null;
  return {
    key,
    name: providerDisplayName(key, cfg.name),
    clientId: cfg.clientId,
    clientSecret: cfg.clientSecret,
    scopes: cfg.scopes.length ? cfg.scopes : DEFAULT_SCOPES[key] ?? (key.startsWith("custom_") ? ["openid", "profile", "email"] : []),
    discoveryUrl: cfg.discoveryUrl,
    appleTeamId: cfg.appleTeamId,
    appleKeyId: cfg.appleKeyId,
    applePrivateKey: cfg.applePrivateKey,
  };
}

/** Apple's issuer and JWKS; the ID token signature is checked against the published keys. */
export const APPLE_ISSUER = "https://appleid.apple.com";
export const APPLE_JWKS_URL = "https://appleid.apple.com/auth/keys";
const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
/** Apple caps the client secret's lifetime at six months; renew a day early so a long request never straddles it. */
export const APPLE_CLIENT_SECRET_LIFETIME_SECONDS = 180 * 24 * 60 * 60;
const APPLE_CLIENT_SECRET_RENEW_BEFORE_SECONDS = 24 * 60 * 60;

interface CachedAppleSecret { jwt: string; expiresAt: number }
const appleSecretCache = new Map<string, CachedAppleSecret>();

/** Test seam: forget cached Apple client secrets (the cache is process-wide, keyed by client + key id). */
export function resetAppleClientSecretCache() {
  appleSecretCache.clear();
}

const appleCacheKey = (cfg: OAuthProviderConfig) =>
  sha256([cfg.clientId, cfg.appleTeamId ?? "", cfg.appleKeyId ?? "", cfg.applePrivateKey ?? ""].join("\u0000"));

/** True when the server can mint the Apple client secret from a `.p8` key. */
export const hasAppleKey = (cfg: OAuthProviderConfig) => !!(cfg.appleTeamId && cfg.appleKeyId && cfg.applePrivateKey);

/**
 * Apple requires `client_secret` to be an ES256 JWT: `iss` = team id, `sub` = client id,
 * `aud` = https://appleid.apple.com, max six months, `kid` in the header. Minted on demand and cached
 * until shortly before it expires. A configured `clientSecret` is used instead when no key is present.
 */
export async function appleClientSecret(cfg: OAuthProviderConfig, now = Date.now()): Promise<string> {
  if (!hasAppleKey(cfg)) {
    if (cfg.clientSecret) return cfg.clientSecret;
    throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "Apple needs a client secret or a team id, key id and private key");
  }
  const cacheKey = appleCacheKey(cfg);
  const cached = appleSecretCache.get(cacheKey);
  if (cached && cached.expiresAt > now) return cached.jwt;

  let key: CryptoKey;
  try {
    key = await importPKCS8(normalizeP8(cfg.applePrivateKey!), "ES256");
  } catch {
    throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "The Apple private key is not a valid ES256 (.p8) key");
  }
  const issuedAt = Math.floor(now / 1000);
  const expiresAt = issuedAt + APPLE_CLIENT_SECRET_LIFETIME_SECONDS;
  const jwt = await new SignJWT({})
    .setProtectedHeader({ alg: "ES256", kid: cfg.appleKeyId })
    .setIssuer(cfg.appleTeamId!)
    .setSubject(cfg.clientId)
    .setAudience(APPLE_ISSUER)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key);
  appleSecretCache.set(cacheKey, { jwt, expiresAt: (expiresAt - APPLE_CLIENT_SECRET_RENEW_BEFORE_SECONDS) * 1000 });
  return jwt;
}

/** Accepts the key with or without the PEM header/footer and with the line breaks a dashboard paste usually loses. */
function normalizeP8(raw: string): string {
  const trimmed = raw.trim().replace(/\\n/g, "\n");
  if (trimmed.includes("-----BEGIN")) return trimmed;
  const body = trimmed.replace(/\s+/g, "");
  const lines = body.match(/.{1,64}/g)?.join("\n") ?? body;
  return `-----BEGIN PRIVATE KEY-----\n${lines}\n-----END PRIVATE KEY-----\n`;
}

/** Test seam: replaces Apple's published JWKS (a local key set that never leaves the process). */
let appleJwksOverride: ((protectedHeader?: { kid?: string }) => Promise<CryptoKey>) | null = null;
export function registerAppleJwks(resolver: ((protectedHeader?: { kid?: string }) => Promise<CryptoKey>) | null) {
  appleJwksOverride = resolver;
}

/**
 * Verifies an Apple ID token: signature against Apple's JWKS, `iss` = https://appleid.apple.com,
 * `aud` = the configured client id, and expiry. Returns the verified claims.
 */
export async function verifyAppleIdToken(idToken: string, clientId: string): Promise<Record<string, unknown>> {
  try {
    const key = appleJwksOverride ?? (await remoteJwks(null, APPLE_JWKS_URL));
    const { payload } = await jwtVerify(idToken, key as Parameters<typeof jwtVerify>[1], { issuer: APPLE_ISSUER, audience: clientId });
    return payload as Record<string, unknown>;
  } catch {
    throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Apple returned an ID token that could not be verified");
  }
}

/** Apple's first-authorization `user` form field carries the name; it is absent on every later authorization. */
export function appleProfileName(userJson: string | undefined): { firstName?: string; lastName?: string } {
  const name = firstAuthorizationName(userJson);
  return name ?? {};
}

/** Returns the parsed name only for a first authorization (the field is absent afterwards). */
function firstAuthorizationName(userJson: string | undefined): { firstName?: string; lastName?: string } | null {
  if (!userJson) return null;
  try {
    const parsed = JSON.parse(userJson) as { name?: { firstName?: string; lastName?: string } };
    if (!parsed.name) return null;
    return {
      firstName: typeof parsed.name.firstName === "string" ? parsed.name.firstName : undefined,
      lastName: typeof parsed.name.lastName === "string" ? parsed.name.lastName : undefined,
    };
  } catch {
    return null;
  }
}

export function isProviderEnabled(ctx: AppContext, key: string): boolean {
  return providerConfig(ctx, key) !== null;
}

export interface SocialProviderListing { key: string; strategy: string; name: string; logo_url: string; authenticatable: boolean }
export function listEnabledSocialProviders(ctx: AppContext): SocialProviderListing[] {
  const social = ctx.settings.get().social;
  return Object.entries(social)
    .filter(([, cfg]) => cfg.enabled && !!cfg.clientId)
    .map(([key, cfg]) => ({
      key,
      strategy: `oauth_${key}`,
      name: providerDisplayName(key, cfg.name),
      logo_url: providerLogoUrl(key),
      authenticatable: cfg.authenticatableAtSignIn,
    }));
}

// ───────────── helpers ─────────────

const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const strOrEmpty = (v: unknown): string => (typeof v === "string" ? v : "");
const boolOrUndefined = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);
const at = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((acc, part) => rec(acc)[part], obj);

async function requestJson(ctx: AppContext, url: string, init: RequestInit = {}): Promise<unknown> {
  let res;
  try {
    // The context carries the instance settings the SSRF guard reads (`developmentMode` lets a
    // self-hosted IdP on a private address through); without it every test/local provider is refused.
    res = await safeFetch(ctx, url, {
      method: init.method,
      headers: init.headers as Record<string, string> | undefined,
      body: init.body as string | URLSearchParams | undefined,
      timeoutMs: 10_000,
      maxBytes: 512 * 1024,
    });
  } catch (err) {
    if (err instanceof OrbitError && err.code === ErrorCodes.form_param_format_invalid) {
      // The URL was refused before any connection: say so instead of blaming the provider.
      throw new OrbitError(502, ErrorCodes.oauth_callback_error, `The identity provider URL was refused: ${err.message}`);
    }
    throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Could not reach the identity provider");
  }
  const text = res.body;
  if (!res.ok) {
    throw new OrbitError(502, ErrorCodes.oauth_callback_error, `Identity provider request failed (${res.status})`);
  }
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

const bearer = (tokens: OAuthTokenSet) => ({ Authorization: `Bearer ${tokens.accessToken}` });
const arcticTokens = (tokens: OAuth2Tokens): OAuthTokenSet => ({
  accessToken: tokens.accessToken(),
  refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
  expiresAt: tokens.accessTokenExpiresAt().getTime(),
  scopes: tokens.hasScopes() ? tokens.scopes().join(" ") : undefined,
  idToken: tokens.idToken(),
  raw: rec(tokens.data),
});

const profile = (key: string, p: Partial<ExternalProfile> & { providerUserId: string }, tokens?: OAuthTokenSet): ExternalProfile => ({
  provider: key,
  providerUserId: p.providerUserId,
  email: p.email,
  emailVerified: p.emailVerified,
  firstName: p.firstName,
  lastName: p.lastName,
  username: p.username,
  imageUrl: p.imageUrl,
  accessToken: tokens?.accessToken,
  refreshToken: tokens?.refreshToken,
  expiresAt: tokens?.expiresAt,
  scopes: tokens?.scopes,
  raw: p.raw,
});

function idTokenProfile(key: string, tokens: OAuthTokenSet): ExternalProfile {
  if (!tokens.idToken) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Identity provider did not return an ID token");
  const claims = decodeJwt(tokens.idToken);
  const sub = str(claims.sub);
  if (!sub) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Identity provider returned an ID token without a subject");
  return profile(key, {
    providerUserId: sub,
    email: str(claims.email),
    emailVerified: boolOrUndefined(claims.email_verified) ?? !!claims.email,
    firstName: str(claims.given_name),
    lastName: str(claims.family_name),
    username: str(claims.preferred_username),
    imageUrl: str(claims.picture),
    raw: claims as Record<string, unknown>,
  }, tokens);
}

/** Normalizes the userinfo payload of the well-known providers. */
function normalizeProfile(key: string, data: unknown, tokens: OAuthTokenSet): ExternalProfile {
  switch (key) {
    case "google": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.sub) || strOrEmpty(d.email),
        email: str(d.email), emailVerified: boolOrUndefined(d.email_verified) ?? true,
        firstName: str(d.given_name), lastName: str(d.family_name), username: str(d.email)?.split("@")[0],
        imageUrl: str(d.picture), raw: d,
      }, tokens);
    }
    case "github": {
      const d = rec(data);
      const name = str(d.name);
      const [first, ...rest] = (name ?? "").split(" ");
      return profile(key, {
        providerUserId: String(d.id ?? ""),
        email: str(d.email), emailVerified: true,
        firstName: first || undefined, lastName: rest.join(" ") || undefined, username: str(d.login),
        imageUrl: str(d.avatar_url), raw: d,
      }, tokens);
    }
    case "gitlab": {
      const d = rec(data);
      const name = str(d.name);
      const [first, ...rest] = (name ?? "").split(" ");
      return profile(key, {
        providerUserId: String(d.id ?? ""),
        email: str(d.email), emailVerified: true,
        firstName: first || undefined, lastName: rest.join(" ") || undefined, username: str(d.username),
        imageUrl: str(d.avatar_url), raw: d,
      }, tokens);
    }
    case "discord": {
      const d = rec(data);
      const avatar = str(d.avatar);
      return profile(key, {
        providerUserId: String(d.id ?? ""),
        email: str(d.email), emailVerified: boolOrUndefined(d.verified) ?? true,
        username: str(d.username), imageUrl: avatar ? `https://cdn.discordapp.com/avatars/${String(d.id)}/${avatar}.png` : undefined, raw: d,
      }, tokens);
    }
    case "microsoft": {
      const d = rec(data);
      const email = str(d.email) ?? str(d.preferred_username);
      return profile(key, {
        providerUserId: strOrEmpty(d.sub) || strOrEmpty(d.oid) || strOrEmpty(email),
        email, emailVerified: true,
        firstName: str(d.given_name), lastName: str(d.family_name), username: email?.split("@")[0],
        imageUrl: str(d.picture), raw: d,
      }, tokens);
    }
    case "facebook": {
      const d = rec(data);
      const [first, ...rest] = strOrEmpty(d.name).split(" ");
      return profile(key, {
        providerUserId: String(d.id ?? ""),
        email: str(d.email), emailVerified: !!d.email,
        firstName: str(d.first_name) ?? first, lastName: str(d.last_name) ?? (rest.join(" ") || undefined),
        imageUrl: str(at(d, "picture.data.url")), raw: d,
      }, tokens);
    }
    case "twitter":
    case "x": {
      const d = rec(rec(data).data);
      return profile(key, {
        providerUserId: String(d.id ?? ""),
        username: str(d.username), firstName: str(d.name),
        imageUrl: str(d.profile_image_url), raw: d,
      }, tokens);
    }
    case "linkedin_oidc": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.sub) || strOrEmpty(d.email),
        email: str(d.email), emailVerified: boolOrUndefined(d.email_verified) ?? true,
        firstName: str(d.given_name), lastName: str(d.family_name), imageUrl: str(d.picture), raw: d,
      }, tokens);
    }
    case "slack": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.sub) || strOrEmpty(d.email),
        email: str(d.email), emailVerified: boolOrUndefined(d.email_verified) ?? true,
        firstName: str(d.name), imageUrl: str(d.picture), raw: d,
      }, tokens);
    }
    case "twitch": {
      const d = rec(Array.isArray(rec(data).data) ? (rec(data).data as unknown[])[0] : {});
      return profile(key, {
        providerUserId: String(d.id ?? ""), email: str(d.email), emailVerified: true,
        username: str(d.display_name), firstName: str(d.display_name), imageUrl: str(d.profile_image_url), raw: d,
      }, tokens);
    }
    case "spotify": {
      const d = rec(data);
      const images = Array.isArray(d.images) ? d.images : [];
      return profile(key, {
        providerUserId: String(d.id ?? ""), email: str(d.email), emailVerified: true,
        firstName: str(d.display_name), username: str(d.display_name),
        imageUrl: str(rec(images[0]).url), raw: d,
      }, tokens);
    }
    case "bitbucket": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.uuid) || strOrEmpty(d.username),
        email: str(d.email), emailVerified: true,
        firstName: str(d.display_name), username: str(d.username), imageUrl: str(at(d, "links.avatar.href")), raw: d,
      }, tokens);
    }
    case "dropbox": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.account_id),
        email: str(d.email), emailVerified: boolOrUndefined(d.email_verified) ?? true,
        firstName: str(at(d, "name.display_name")), imageUrl: str(d.profile_photo_url), raw: d,
      }, tokens);
    }
    case "notion": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.id) || strOrEmpty(d.bot_id),
        email: str(at(d, "person.email")), emailVerified: true,
        firstName: str(d.name), imageUrl: str(d.avatar_url), raw: d,
      }, tokens);
    }
    case "hubspot": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.user) || strOrEmpty(d.hub_id),
        email: str(d.user), emailVerified: true, raw: d,
      }, tokens);
    }
    case "tiktok": {
      const d = rec(at(data, "data.user"));
      return profile(key, {
        providerUserId: strOrEmpty(d.open_id) || strOrEmpty(d.union_id),
        firstName: str(d.display_name), username: str(d.display_name), imageUrl: str(d.avatar_url), raw: d,
      }, tokens);
    }
    case "coinbase": {
      const d = rec(rec(data).data);
      return profile(key, {
        providerUserId: strOrEmpty(d.id), email: str(d.email), emailVerified: !!d.email,
        firstName: str(d.name), username: str(d.username), imageUrl: str(d.avatar_url), raw: d,
      }, tokens);
    }
    case "line": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.userId), firstName: str(d.displayName),
        imageUrl: str(d.pictureUrl), raw: d,
      }, tokens);
    }
    case "linear": {
      const d = rec(at(data, "data.viewer"));
      return profile(key, {
        providerUserId: strOrEmpty(d.id), email: str(d.email), emailVerified: true,
        firstName: str(d.name), username: str(d.displayName), imageUrl: str(d.avatarUrl), raw: d,
      }, tokens);
    }
    case "huggingface": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.id), email: str(d.email), emailVerified: boolOrUndefined(d.emailVerified) ?? !!d.email,
        firstName: str(d.fullname) ?? str(d.name), username: str(d.name), imageUrl: str(d.avatarUrl), raw: d,
      }, tokens);
    }
    case "box": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.id), email: str(d.login), emailVerified: true,
        firstName: str(d.name), username: str(d.login), imageUrl: str(d.avatar_url), raw: d,
      }, tokens);
    }
    case "atlassian": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.account_id) || strOrEmpty(d.email),
        email: str(d.email), emailVerified: true, firstName: str(d.name), imageUrl: str(d.picture), raw: d,
      }, tokens);
    }
    default: {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.sub) || strOrEmpty(d.id) || strOrEmpty(d.email),
        email: str(d.email), emailVerified: boolOrUndefined(d.email_verified) ?? !!d.email,
        firstName: str(d.given_name) ?? str(d.first_name) ?? str(d.name),
        lastName: str(d.family_name) ?? str(d.last_name),
        username: str(d.preferred_username) ?? str(d.username),
        imageUrl: str(d.picture) ?? str(d.avatar_url), raw: d,
      }, tokens);
    }
  }
}

// ───────────── OIDC discovery (custom providers) ─────────────

interface OidcDiscovery {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
}
const discoveryCache = new Map<string, { doc: OidcDiscovery; expiresAt: number }>();

async function loadDiscovery(ctx: AppContext, url: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.doc;
  const raw = rec(await requestJson(ctx, url));
  const doc: OidcDiscovery = {
    issuer: str(raw.issuer),
    authorization_endpoint: str(raw.authorization_endpoint) ?? "",
    token_endpoint: str(raw.token_endpoint) ?? "",
    userinfo_endpoint: str(raw.userinfo_endpoint),
    jwks_uri: str(raw.jwks_uri),
  };
  if (!doc.issuer || !doc.authorization_endpoint || !doc.token_endpoint) {
    throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "The OIDC discovery document is missing its issuer or endpoints");
  }
  // The document is operator-controlled, so every endpoint it names is judged like any other outbound URL.
  for (const endpoint of [doc.authorization_endpoint, doc.token_endpoint, doc.userinfo_endpoint, doc.jwks_uri]) {
    if (endpoint) await assertPublicUrl(ctx, endpoint, "discoveryUrl").catch(() => {
      throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "The OIDC discovery document points at a non-public address");
    });
  }
  discoveryCache.set(url, { doc, expiresAt: Date.now() + 3_600_000 });
  return doc;
}

// ───────────── adapter construction ─────────────

interface ArcticPkce { createAuthorizationURL(state: string, codeVerifier: string, scopes: string[]): URL; validateAuthorizationCode(code: string, codeVerifier: string): Promise<OAuth2Tokens> }
interface ArcticBasic { createAuthorizationURL(state: string, scopes: string[]): URL; validateAuthorizationCode(code: string): Promise<OAuth2Tokens> }
function arcticAdapter(ctx: AppContext, cfg: OAuthProviderConfig, _redirectUri: string, client: ArcticPkce | ArcticBasic): OAuthAdapter {
  const usesPkce = client.createAuthorizationURL.length >= 3;
  return {
    key: cfg.key,
    async createAuthorizationUrl({ state, codeVerifier, scopes }) {
      return usesPkce
        ? (client as ArcticPkce).createAuthorizationURL(state, codeVerifier, scopes)
        : (client as ArcticBasic).createAuthorizationURL(state, scopes);
    },
    async exchangeCode({ code, codeVerifier }) {
      const tokens = usesPkce
        ? await (client as ArcticPkce).validateAuthorizationCode(code, codeVerifier)
        : await (client as ArcticBasic).validateAuthorizationCode(code);
      return arcticTokens(tokens);
    },
    async fetchProfile({ tokens }) {
      return fetchProfileFor(ctx, cfg, tokens);
    },
  };
}

const USERINFO_URLS: Record<string, string> = {
  google: "https://openidconnect.googleapis.com/v1/userinfo",
  gitlab: "https://gitlab.com/api/v4/user",
  microsoft: "https://graph.microsoft.com/oidc/userinfo",
  facebook: "https://graph.facebook.com/me?fields=id,name,email,first_name,last_name,picture",
  twitter: "https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username",
  x: "https://api.twitter.com/2/users/me?user.fields=profile_image_url,name,username",
  linkedin_oidc: "https://api.linkedin.com/v2/userinfo",
  slack: "https://slack.com/api/openid.connect.userInfo",
  twitch: "https://api.twitch.tv/helix/users",
  spotify: "https://api.spotify.com/v1/me",
  bitbucket: "https://api.bitbucket.org/2.0/user",
  box: "https://api.box.com/2.0/users/me",
  atlassian: "https://api.atlassian.com/me",
  huggingface: "https://huggingface.co/oauth/userinfo",
  linear: "https://api.linear.app/graphql",
};

async function fetchProfileFor(ctx: AppContext, cfg: OAuthProviderConfig, tokens: OAuthTokenSet): Promise<ExternalProfile> {
  const key = cfg.key;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(bearer(tokens))) headers[k] = v;

  switch (key) {
    case "github": {
      const data = await requestJson(ctx, "https://api.github.com/user", { headers: { ...headers, "User-Agent": "OrbitID", Accept: "application/vnd.github+json" } });
      const p = normalizeProfile(key, data, tokens);
      if (!p.email) {
        const emails = await requestJson(ctx, "https://api.github.com/user/emails", { headers: { ...headers, "User-Agent": "OrbitID", Accept: "application/vnd.github+json" } });
        if (Array.isArray(emails)) {
          const primary = emails.map(rec).find((e) => e.primary === true) ?? emails.map(rec).find((e) => e.verified === true);
          if (primary) {
            p.email = str(primary.email);
            p.emailVerified = primary.verified === true;
          }
        }
      }
      return p;
    }
    case "discord": {
      const data = await requestJson(ctx, "https://discord.com/api/users/@me", { headers });
      return normalizeProfile(key, data, tokens);
    }
    case "bitbucket": {
      const p = normalizeProfile(key, await requestJson(ctx, USERINFO_URLS.bitbucket!, { headers }), tokens);
      if (!p.email) {
        const emails = rec(await requestJson(ctx, "https://api.bitbucket.org/2.0/user/emails", { headers }));
        const values = Array.isArray(emails.values) ? emails.values.map(rec) : [];
        const primary = values.find((e) => e.is_primary === true) ?? values.find((e) => e.is_confirmed === true);
        if (primary) {
          p.email = str(primary.email);
          p.emailVerified = primary.is_confirmed === true;
        }
      }
      return p;
    }
    case "twitch": {
      const data = await requestJson(ctx, USERINFO_URLS.twitch!, { headers: { ...headers, "Client-Id": cfg.clientId } });
      return normalizeProfile(key, data, tokens);
    }
    case "dropbox": {
      const data = await requestJson(ctx, "https://api.dropboxapi.com/2/users/get_current_account", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "null" });
      return normalizeProfile(key, data, tokens);
    }
    case "notion": {
      const data = await requestJson(ctx, "https://api.notion.com/v1/users/me", { headers: { ...headers, "Notion-Version": "2022-06-28" } });
      return normalizeProfile(key, data, tokens);
    }
    case "hubspot": {
      const data = await requestJson(ctx, `https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(tokens.accessToken)}`, {});
      return normalizeProfile(key, data, tokens);
    }
    case "tiktok": {
      const data = await requestJson(ctx, "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name", { headers });
      return normalizeProfile(key, data, tokens);
    }
    case "coinbase": {
      const data = await requestJson(ctx, "https://api.coinbase.com/v2/user", { headers });
      const p = normalizeProfile(key, data, tokens);
      try {
        const auth = rec(await requestJson(ctx, "https://api.coinbase.com/v2/user/auth", { headers }));
        const email = str(rec(auth.data).email) ?? str(rec(rec(auth.data).user).email);
        if (email) { p.email = email; p.emailVerified = true; }
      } catch {
        // email scope may be unavailable; ignore.
      }
      return p;
    }
    case "line": {
      const data = await requestJson(ctx, "https://api.line.me/v2/profile", { headers });
      const p = normalizeProfile(key, data, tokens);
      if (tokens.idToken) {
        const claims = decodeJwt(tokens.idToken);
        p.email = str(claims.email);
        p.emailVerified = !!p.email;
      }
      return p;
    }
    case "linear": {
      const data = await requestJson(ctx, USERINFO_URLS.linear!, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query { viewer { id name displayName email avatarUrl } }" }),
      });
      return normalizeProfile(key, data, tokens);
    }
    case "apple":
      return appleProfile(ctx, cfg, tokens);
    case "xero":
      return idTokenProfile(key, tokens);
    case "custom": {
      return customOidcProfile(ctx, cfg, tokens);
    }
    default: {
      const url = USERINFO_URLS[key];
      if (!url) {
        if (tokens.idToken) return idTokenProfile(key, tokens);
        throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `No profile endpoint configured for provider "${key}"`);
      }
      const data = await requestJson(ctx, url, { headers });
      return normalizeProfile(key, data, tokens);
    }
  }
}

/**
 * Verifies an ID token from a custom OIDC provider: signature against its published JWKS, `iss` from the
 * discovery document, `aud` = our client id, and (when one was sent) the `nonce`. An ID token the provider
 * returned is never trusted unverified, and a failed check is final — falling back to userinfo after a
 * failed signature check would let a forged token's claims be read from somewhere else.
 */
async function verifyCustomIdToken(
  ctx: AppContext,
  cfg: OAuthProviderConfig,
  disco: OidcDiscovery,
  idToken: string,
  nonce: string | undefined,
): Promise<Record<string, unknown>> {
  if (!disco.jwks_uri) {
    throw new OrbitError(502, ErrorCodes.oauth_callback_error, "The identity provider has no JWKS to verify its ID token");
  }
  try {
    const jwks = await remoteJwks(ctx, disco.jwks_uri);
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: disco.issuer,
      audience: cfg.clientId,
      // Pin the algorithms: without this an RS256 key could be used as an HMAC secret ("alg confusion").
      algorithms: ["RS256", "ES256", "PS256", "EdDSA"],
    });
    if (nonce && payload.nonce !== nonce) throw new Error("nonce mismatch");
    return payload as Record<string, unknown>;
  } catch (err) {
    const reason = (err as Error).message === "nonce mismatch" ? "its nonce did not match" : "it could not be verified";
    throw new OrbitError(502, ErrorCodes.oauth_callback_error, `The identity provider returned an ID token that ${reason}`);
  }
}

async function customOidcProfile(ctx: AppContext, cfg: OAuthProviderConfig, tokens: OAuthTokenSet, nonce?: string): Promise<ExternalProfile> {
  if (!cfg.discoveryUrl) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "Custom OIDC provider is missing its discovery URL");
  const disco = await loadDiscovery(ctx, cfg.discoveryUrl);
  if (tokens.idToken) {
    // Already verified during the code exchange against the same nonce; reuse those claims rather than refetch.
    const claims = tokens.idTokenClaims ?? await verifyCustomIdToken(ctx, cfg, disco, tokens.idToken, nonce);
    return normalizeProfile(cfg.key, claims, tokens);
  }
  if (disco.userinfo_endpoint) {
    const data = rec(await requestJson(ctx, disco.userinfo_endpoint, { headers: bearer(tokens) }));
    // A userinfo response is only as trustworthy as the access token that fetched it; the nonce cannot
    // appear here, so callers that demanded one are satisfied by the ID token path above.
    return normalizeProfile(cfg.key, data, tokens);
  }
  throw new OrbitError(502, ErrorCodes.oauth_callback_error, "The identity provider did not return a usable profile");
}

function manualTikTokAdapter(ctx: AppContext, cfg: OAuthProviderConfig, redirectUri: string): OAuthAdapter {
  return {
    key: cfg.key,
    async createAuthorizationUrl({ state, scopes }) {
      const url = new URL("https://www.tiktok.com/v2/auth/authorize/");
      url.searchParams.set("client_key", cfg.clientId);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("scope", scopes.join(","));
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("state", state);
      return url;
    },
    async exchangeCode({ code }) {
      const body = new URLSearchParams({
        client_key: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri,
      });
      const data = rec(await requestJson(ctx, "https://open.tiktokapis.com/v2/oauth/token/", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
      const accessToken = str(data.access_token);
      if (!accessToken) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Identity provider did not return an access token");
      return { accessToken, refreshToken: str(data.refresh_token), expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined, scopes: str(data.scope), raw: data };
    },
    async fetchProfile({ tokens }) {
      return normalizeProfile("tiktok", await requestJson(ctx, USERINFO_URLS.tiktok ?? "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name", { headers: bearer(tokens) }), tokens);
    },
  };
}

function manualAppleAdapter(ctx: AppContext, cfg: OAuthProviderConfig, redirectUri: string): OAuthAdapter {
  return {
    key: cfg.key,
    async createAuthorizationUrl({ state, scopes }) {
      const url = new URL("https://appleid.apple.com/auth/authorize");
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("response_mode", "form_post");
      url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      return url;
    },
    async exchangeCode({ code }) {
      // A configured secret wins; otherwise the server mints the ES256 JWT Apple expects from the .p8 key.
      const body = new URLSearchParams({
        client_id: cfg.clientId, client_secret: await appleClientSecret(cfg), code, grant_type: "authorization_code", redirect_uri: redirectUri,
      });
      const data = rec(await requestJson(ctx, APPLE_TOKEN_URL, { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
      const accessToken = str(data.access_token);
      const idToken = str(data.id_token);
      if (!accessToken || !idToken) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Apple did not return tokens");
      // Verify before anything reads the claims: signature, issuer, audience and expiry.
      const idTokenClaims = await verifyAppleIdToken(idToken, cfg.clientId);
      return {
        accessToken,
        refreshToken: str(data.refresh_token),
        idToken,
        idTokenClaims,
        expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined,
        raw: data,
      };
    },
    async fetchProfile({ tokens }) {
      return appleProfile(ctx, cfg, tokens);
    },
  };
}

/**
 * Apple has no userinfo endpoint: everything comes from the ID token. Claims verified during the code
 * exchange are used as-is; a token that reaches us unverified is verified here rather than trusted.
 */
async function appleProfile(_ctx: AppContext, cfg: OAuthProviderConfig, tokens: OAuthTokenSet): Promise<ExternalProfile> {
  const claims = tokens.idTokenClaims
    ?? (tokens.idToken ? await verifyAppleIdToken(tokens.idToken, cfg.clientId) : null);
  if (!claims) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Apple did not return an ID token");
  const sub = str(claims.sub);
  if (!sub) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Apple returned an ID token without a subject");
  return profile("apple", {
    providerUserId: sub,
    email: str(claims.email),
    emailVerified: boolOrUndefined(claims.email_verified) ?? !!claims.email,
    raw: claims as Record<string, unknown>,
  }, tokens);
}

const GENERIC_ENDPOINTS: Record<string, { authUrl: string; tokenUrl: string }> = {
  huggingface: { authUrl: "https://huggingface.co/oauth/authorize", tokenUrl: "https://huggingface.co/oauth/token" },
  xero: { authUrl: "https://login.xero.com/identity/connect/authorize", tokenUrl: "https://identity.xero.com/connect/token" },
  linkedin_oidc: { authUrl: "https://www.linkedin.com/oauth/v2/authorization", tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken" },
  hubspot: { authUrl: "https://app.hubspot.com/oauth/authorize", tokenUrl: "https://api.hubapi.com/oauth/v1/token" },
};

function genericAdapter(ctx: AppContext, cfg: OAuthProviderConfig, redirectUri: string): OAuthAdapter {
  const endpoints = GENERIC_ENDPOINTS[cfg.key];
  if (!endpoints) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `Unsupported OAuth provider "${cfg.key}"`);
  const client = new OAuth2Client(cfg.clientId, cfg.clientSecret, redirectUri);
  return arcticAdapter(ctx, cfg, redirectUri, {
    createAuthorizationURL: (state, codeVerifier, scopes) =>
      client.createAuthorizationURLWithPKCE(endpoints.authUrl, state, CodeChallengeMethod.S256, codeVerifier, scopes),
    validateAuthorizationCode: (code, codeVerifier) => client.validateAuthorizationCode(endpoints.tokenUrl, code, codeVerifier),
  });
}

/**
 * Custom OIDC provider. Arctic builds the authorization URL (PKCE S256) but the token request goes through
 * `safeFetch`, because arctic uses the global `fetch` and would bypass the SSRF guard for a
 * `discoveryUrl` that resolves to a private address.
 */
async function customOidcAdapter(ctx: AppContext, cfg: OAuthProviderConfig, redirectUri: string): Promise<OAuthAdapter> {
  if (!cfg.discoveryUrl) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "Custom OIDC provider is missing its discovery URL");
  const client = new OAuth2Client(cfg.clientId, cfg.clientSecret, redirectUri);
  const discovery = await loadDiscovery(ctx, cfg.discoveryUrl);
  return {
    key: cfg.key,
    usesNonce: true,
    async createAuthorizationUrl({ state, codeVerifier, scopes, nonce }) {
      const disco = await discovery;
      const url = client.createAuthorizationURLWithPKCE(disco.authorization_endpoint, state, CodeChallengeMethod.S256, codeVerifier, scopes);
      if (nonce) url.searchParams.set("nonce", nonce);
      return url;
    },
    async exchangeCode({ code, codeVerifier, nonce }) {
      const disco = await discovery;
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri, code_verifier: codeVerifier });
      const raw = rec(await requestJson(ctx, disco.token_endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json", authorization: basicAuth(cfg) },
        body,
      }));
      const accessToken = str(raw.access_token);
      if (!accessToken) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Identity provider did not return an access token");
      const idToken = str(raw.id_token);
      const tokens: OAuthTokenSet = {
        accessToken,
        refreshToken: str(raw.refresh_token),
        expiresAt: typeof raw.expires_in === "number" ? Date.now() + raw.expires_in * 1000 : undefined,
        scopes: str(raw.scope),
        idToken,
        raw,
      };
      if (idToken) tokens.idTokenClaims = await verifyCustomIdToken(ctx, cfg, disco, idToken, nonce);
      return tokens;
    },
    async fetchProfile({ tokens }) {
      return customOidcProfile(ctx, cfg, tokens);
    },
  };
}

/** `client_secret_basic`: base64 of `client_id:client_secret` (RFC 6749 §2.3.1). */
function basicAuth(cfg: OAuthProviderConfig): string {
  return `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString("base64")}`;
}

/** Builds (or returns the test override for) a provider adapter. Null when the provider is not configured. */
export async function getOAuthAdapter(ctx: AppContext, key: string): Promise<OAuthAdapter | null> {
  const cfg = providerConfig(ctx, key);
  if (!cfg) return null;
  const redirectUri = providerRedirectUri(ctx, key);
  const override = adapterOverrides.get(key);
  if (override) return override(cfg, redirectUri, ctx);

  switch (key) {
    case "google": return arcticAdapter(ctx, cfg, redirectUri, new Google(cfg.clientId, cfg.clientSecret, redirectUri));
    case "github": return arcticAdapter(ctx, cfg, redirectUri, new GitHub(cfg.clientId, cfg.clientSecret, redirectUri));
    case "gitlab": return arcticAdapter(ctx, cfg, redirectUri, new GitLab("gitlab.com", cfg.clientId, cfg.clientSecret, redirectUri));
    case "discord": return arcticAdapter(ctx, cfg, redirectUri, new Discord(cfg.clientId, cfg.clientSecret, redirectUri));
    case "microsoft": return arcticAdapter(ctx, cfg, redirectUri, new MicrosoftEntraId("common", cfg.clientId, cfg.clientSecret, redirectUri));
    case "facebook": return arcticAdapter(ctx, cfg, redirectUri, new Facebook(cfg.clientId, cfg.clientSecret, redirectUri));
    case "twitter":
    case "x": return arcticAdapter(ctx, cfg, redirectUri, new Twitter(cfg.clientId, cfg.clientSecret, redirectUri));
    case "slack": return arcticAdapter(ctx, cfg, redirectUri, new Slack(cfg.clientId, cfg.clientSecret, redirectUri));
    case "twitch": return arcticAdapter(ctx, cfg, redirectUri, new Twitch(cfg.clientId, cfg.clientSecret, redirectUri));
    case "spotify": return arcticAdapter(ctx, cfg, redirectUri, new Spotify(cfg.clientId, cfg.clientSecret, redirectUri));
    case "bitbucket": return arcticAdapter(ctx, cfg, redirectUri, new Bitbucket(cfg.clientId, cfg.clientSecret, redirectUri));
    case "dropbox": return arcticAdapter(ctx, cfg, redirectUri, new Dropbox(cfg.clientId, cfg.clientSecret, redirectUri));
    case "notion": return arcticAdapter(ctx, cfg, redirectUri, new Notion(cfg.clientId, cfg.clientSecret, redirectUri));
    case "box": return arcticAdapter(ctx, cfg, redirectUri, new Box(cfg.clientId, cfg.clientSecret, redirectUri));
    case "coinbase": return arcticAdapter(ctx, cfg, redirectUri, new Coinbase(cfg.clientId, cfg.clientSecret, redirectUri));
    case "line": return arcticAdapter(ctx, cfg, redirectUri, new Line(cfg.clientId, cfg.clientSecret, redirectUri));
    case "linear": return arcticAdapter(ctx, cfg, redirectUri, new Linear(cfg.clientId, cfg.clientSecret, redirectUri));
    case "atlassian": return arcticAdapter(ctx, cfg, redirectUri, new Atlassian(cfg.clientId, cfg.clientSecret, redirectUri));
    case "apple": return manualAppleAdapter(ctx, cfg, redirectUri);
    case "tiktok": return manualTikTokAdapter(ctx, cfg, redirectUri);
    case "hubspot":
    case "huggingface":
    case "xero":
    case "linkedin_oidc": return genericAdapter(ctx, cfg, redirectUri);
    default:
      if (key.startsWith("custom_")) return customOidcAdapter(ctx, cfg, redirectUri);
      return null;
  }
}
