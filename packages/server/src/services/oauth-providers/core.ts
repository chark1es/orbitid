// Social OAuth / OIDC provider adapters (arctic under the hood) + profile normalization.
import {
  Atlassian, Bitbucket, Box, Coinbase, Discord, Dropbox, Facebook, GitHub, GitLab, Google, Line, Linear,
  MicrosoftEntraId, Notion, OAuth2Client, CodeChallengeMethod, Slack, Spotify, Twitch, Twitter,
} from "arctic";
import type { OAuth2Tokens } from "arctic";
import { decodeJwt, importPKCS8, jwtVerify, SignJWT } from "jose";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";
import { sha256 } from "../../lib/crypto";
import { assertPublicUrl, remoteJwks, safeFetch } from "../../lib/safe-fetch";
import type { ExternalProfile } from "../external-identity";

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
export const adapterOverrides = new Map<string, OAuthAdapterFactory>();
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
export const APPLE_TOKEN_URL = "https://appleid.apple.com/auth/token";
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
