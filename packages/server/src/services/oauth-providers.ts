// Social OAuth / OIDC provider adapters (arctic under the hood) + profile normalization.
import {
  Atlassian, Bitbucket, Box, Coinbase, Discord, Dropbox, Facebook, GitHub, GitLab, Google, Line, Linear,
  MicrosoftEntraId, Notion, OAuth2Client, CodeChallengeMethod, Slack, Spotify, Twitch, Twitter,
} from "arctic";
import type { OAuth2Tokens } from "arctic";
import { createRemoteJWKSet, decodeJwt, jwtVerify } from "jose";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import type { ExternalProfile } from "./external-identity";

export interface OAuthProviderConfig {
  key: string;
  name: string;
  clientId: string;
  clientSecret: string;
  scopes: string[];
  discoveryUrl?: string;
}

export interface OAuthTokenSet {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string;
  idToken?: string;
  raw: Record<string, unknown>;
}

export interface OAuthAdapter {
  key: string;
  createAuthorizationUrl(input: { state: string; codeVerifier: string; scopes: string[] }): Promise<URL>;
  exchangeCode(input: { code: string; codeVerifier: string }): Promise<OAuthTokenSet>;
  fetchProfile(input: { tokens: OAuthTokenSet }): Promise<ExternalProfile>;
}

export type OAuthAdapterFactory = (cfg: OAuthProviderConfig, redirectUri: string) => OAuthAdapter;

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
  };
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

async function requestJson(url: string, init: RequestInit = {}): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
  } catch {
    throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Could not reach the identity provider");
  }
  const text = await res.text();
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

async function loadDiscovery(url: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.doc;
  const raw = rec(await requestJson(url));
  const doc: OidcDiscovery = {
    issuer: str(raw.issuer),
    authorization_endpoint: str(raw.authorization_endpoint) ?? "",
    token_endpoint: str(raw.token_endpoint) ?? "",
    userinfo_endpoint: str(raw.userinfo_endpoint),
    jwks_uri: str(raw.jwks_uri),
  };
  if (!doc.authorization_endpoint || !doc.token_endpoint) {
    throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "The OIDC discovery document is missing its endpoints");
  }
  discoveryCache.set(url, { doc, expiresAt: Date.now() + 3_600_000 });
  return doc;
}

// ───────────── adapter construction ─────────────

interface ArcticPkce { createAuthorizationURL(state: string, codeVerifier: string, scopes: string[]): URL; validateAuthorizationCode(code: string, codeVerifier: string): Promise<OAuth2Tokens> }
interface ArcticBasic { createAuthorizationURL(state: string, scopes: string[]): URL; validateAuthorizationCode(code: string): Promise<OAuth2Tokens> }
function arcticAdapter(cfg: OAuthProviderConfig, _redirectUri: string, client: ArcticPkce | ArcticBasic): OAuthAdapter {
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
      return fetchProfileFor(cfg, tokens);
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

async function fetchProfileFor(cfg: OAuthProviderConfig, tokens: OAuthTokenSet): Promise<ExternalProfile> {
  const key = cfg.key;
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(bearer(tokens))) headers[k] = v;

  switch (key) {
    case "github": {
      const data = await requestJson("https://api.github.com/user", { headers: { ...headers, "User-Agent": "OrbitID", Accept: "application/vnd.github+json" } });
      const p = normalizeProfile(key, data, tokens);
      if (!p.email) {
        const emails = await requestJson("https://api.github.com/user/emails", { headers: { ...headers, "User-Agent": "OrbitID", Accept: "application/vnd.github+json" } });
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
      const data = await requestJson("https://discord.com/api/users/@me", { headers });
      return normalizeProfile(key, data, tokens);
    }
    case "bitbucket": {
      const p = normalizeProfile(key, await requestJson(USERINFO_URLS.bitbucket!, { headers }), tokens);
      if (!p.email) {
        const emails = rec(await requestJson("https://api.bitbucket.org/2.0/user/emails", { headers }));
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
      const data = await requestJson(USERINFO_URLS.twitch!, { headers: { ...headers, "Client-Id": cfg.clientId } });
      return normalizeProfile(key, data, tokens);
    }
    case "dropbox": {
      const data = await requestJson("https://api.dropboxapi.com/2/users/get_current_account", { method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: "null" });
      return normalizeProfile(key, data, tokens);
    }
    case "notion": {
      const data = await requestJson("https://api.notion.com/v1/users/me", { headers: { ...headers, "Notion-Version": "2022-06-28" } });
      return normalizeProfile(key, data, tokens);
    }
    case "hubspot": {
      const data = await requestJson(`https://api.hubapi.com/oauth/v1/access-tokens/${encodeURIComponent(tokens.accessToken)}`, {});
      return normalizeProfile(key, data, tokens);
    }
    case "tiktok": {
      const data = await requestJson("https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name", { headers });
      return normalizeProfile(key, data, tokens);
    }
    case "coinbase": {
      const data = await requestJson("https://api.coinbase.com/v2/user", { headers });
      const p = normalizeProfile(key, data, tokens);
      try {
        const auth = rec(await requestJson("https://api.coinbase.com/v2/user/auth", { headers }));
        const email = str(rec(auth.data).email) ?? str(rec(rec(auth.data).user).email);
        if (email) { p.email = email; p.emailVerified = true; }
      } catch {
        // email scope may be unavailable; ignore.
      }
      return p;
    }
    case "line": {
      const data = await requestJson("https://api.line.me/v2/profile", { headers });
      const p = normalizeProfile(key, data, tokens);
      if (tokens.idToken) {
        const claims = decodeJwt(tokens.idToken);
        p.email = str(claims.email);
        p.emailVerified = !!p.email;
      }
      return p;
    }
    case "linear": {
      const data = await requestJson(USERINFO_URLS.linear!, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify({ query: "query { viewer { id name displayName email avatarUrl } }" }),
      });
      return normalizeProfile(key, data, tokens);
    }
    case "apple":
    case "xero":
      return idTokenProfile(key, tokens);
    case "custom": {
      return customOidcProfile(cfg, tokens);
    }
    default: {
      const url = USERINFO_URLS[key];
      if (!url) {
        if (tokens.idToken) return idTokenProfile(key, tokens);
        throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `No profile endpoint configured for provider "${key}"`);
      }
      const data = await requestJson(url, { headers });
      return normalizeProfile(key, data, tokens);
    }
  }
}

async function customOidcProfile(cfg: OAuthProviderConfig, tokens: OAuthTokenSet): Promise<ExternalProfile> {
  if (!cfg.discoveryUrl) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "Custom OIDC provider is missing its discovery URL");
  const disco = await loadDiscovery(cfg.discoveryUrl);
  if (tokens.idToken && disco.jwks_uri) {
    try {
      const jwks = createRemoteJWKSet(new URL(disco.jwks_uri));
      const { payload } = await jwtVerify(tokens.idToken, jwks, {
        issuer: disco.issuer,
        audience: cfg.clientId,
      });
      return normalizeProfile("custom", payload, tokens);
    } catch {
      // Fall through to userinfo when the ID token cannot be verified.
    }
  }
  if (disco.userinfo_endpoint) {
    return normalizeProfile("custom", await requestJson(disco.userinfo_endpoint, { headers: bearer(tokens) }), tokens);
  }
  throw new OrbitError(502, ErrorCodes.oauth_callback_error, "The identity provider did not return a usable profile");
}

function manualTikTokAdapter(cfg: OAuthProviderConfig, redirectUri: string): OAuthAdapter {
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
      const data = rec(await requestJson("https://open.tiktokapis.com/v2/oauth/token/", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
      const accessToken = str(data.access_token);
      if (!accessToken) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Identity provider did not return an access token");
      return { accessToken, refreshToken: str(data.refresh_token), expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined, scopes: str(data.scope), raw: data };
    },
    async fetchProfile({ tokens }) {
      return normalizeProfile("tiktok", await requestJson(USERINFO_URLS.tiktok ?? "https://open.tiktokapis.com/v2/user/info/?fields=open_id,union_id,avatar_url,display_name", { headers: bearer(tokens) }), tokens);
    },
  };
}

function manualAppleAdapter(cfg: OAuthProviderConfig, redirectUri: string): OAuthAdapter {
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
      // `clientSecret` for Apple is a pre-generated ES256 JWT (see Apple docs / dashboard).
      const body = new URLSearchParams({
        client_id: cfg.clientId, client_secret: cfg.clientSecret, code, grant_type: "authorization_code", redirect_uri: redirectUri,
      });
      const data = rec(await requestJson("https://appleid.apple.com/auth/token", { method: "POST", body, headers: { "Content-Type": "application/x-www-form-urlencoded" } }));
      const accessToken = str(data.access_token);
      const idToken = str(data.id_token);
      if (!accessToken || !idToken) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Apple did not return tokens");
      return { accessToken, refreshToken: str(data.refresh_token), idToken, expiresAt: typeof data.expires_in === "number" ? Date.now() + data.expires_in * 1000 : undefined, raw: data };
    },
    async fetchProfile({ tokens }) {
      return idTokenProfile("apple", tokens);
    },
  };
}

const GENERIC_ENDPOINTS: Record<string, { authUrl: string; tokenUrl: string }> = {
  huggingface: { authUrl: "https://huggingface.co/oauth/authorize", tokenUrl: "https://huggingface.co/oauth/token" },
  xero: { authUrl: "https://login.xero.com/identity/connect/authorize", tokenUrl: "https://identity.xero.com/connect/token" },
  linkedin_oidc: { authUrl: "https://www.linkedin.com/oauth/v2/authorization", tokenUrl: "https://www.linkedin.com/oauth/v2/accessToken" },
  hubspot: { authUrl: "https://app.hubspot.com/oauth/authorize", tokenUrl: "https://api.hubapi.com/oauth/v1/token" },
};

function genericAdapter(cfg: OAuthProviderConfig, redirectUri: string): OAuthAdapter {
  const endpoints = GENERIC_ENDPOINTS[cfg.key];
  if (!endpoints) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, `Unsupported OAuth provider "${cfg.key}"`);
  const client = new OAuth2Client(cfg.clientId, cfg.clientSecret, redirectUri);
  return arcticAdapter(cfg, redirectUri, {
    createAuthorizationURL: (state, codeVerifier, scopes) =>
      client.createAuthorizationURLWithPKCE(endpoints.authUrl, state, CodeChallengeMethod.S256, codeVerifier, scopes),
    validateAuthorizationCode: (code, codeVerifier) => client.validateAuthorizationCode(endpoints.tokenUrl, code, codeVerifier),
  });
}

async function customOidcAdapter(cfg: OAuthProviderConfig, redirectUri: string): Promise<OAuthAdapter> {
  if (!cfg.discoveryUrl) throw new OrbitError(400, ErrorCodes.oauth_provider_not_enabled, "Custom OIDC provider is missing its discovery URL");
  const client = new OAuth2Client(cfg.clientId, cfg.clientSecret, redirectUri);
  const discovery = await loadDiscovery(cfg.discoveryUrl);
  return {
    key: cfg.key,
    async createAuthorizationUrl({ state, codeVerifier, scopes }) {
      const disco = await discovery;
      return client.createAuthorizationURLWithPKCE(disco.authorization_endpoint, state, CodeChallengeMethod.S256, codeVerifier, scopes);
    },
    async exchangeCode({ code, codeVerifier }) {
      const disco = await discovery;
      return arcticTokens(await client.validateAuthorizationCode(disco.token_endpoint, code, codeVerifier));
    },
    async fetchProfile({ tokens }) {
      return customOidcProfile(cfg, tokens);
    },
  };
}

/** Builds (or returns the test override for) a provider adapter. Null when the provider is not configured. */
export async function getOAuthAdapter(ctx: AppContext, key: string): Promise<OAuthAdapter | null> {
  const cfg = providerConfig(ctx, key);
  if (!cfg) return null;
  const redirectUri = providerRedirectUri(ctx, key);
  const override = adapterOverrides.get(key);
  if (override) return override(cfg, redirectUri);

  switch (key) {
    case "google": return arcticAdapter(cfg, redirectUri, new Google(cfg.clientId, cfg.clientSecret, redirectUri));
    case "github": return arcticAdapter(cfg, redirectUri, new GitHub(cfg.clientId, cfg.clientSecret, redirectUri));
    case "gitlab": return arcticAdapter(cfg, redirectUri, new GitLab("gitlab.com", cfg.clientId, cfg.clientSecret, redirectUri));
    case "discord": return arcticAdapter(cfg, redirectUri, new Discord(cfg.clientId, cfg.clientSecret, redirectUri));
    case "microsoft": return arcticAdapter(cfg, redirectUri, new MicrosoftEntraId("common", cfg.clientId, cfg.clientSecret, redirectUri));
    case "facebook": return arcticAdapter(cfg, redirectUri, new Facebook(cfg.clientId, cfg.clientSecret, redirectUri));
    case "twitter":
    case "x": return arcticAdapter(cfg, redirectUri, new Twitter(cfg.clientId, cfg.clientSecret, redirectUri));
    case "slack": return arcticAdapter(cfg, redirectUri, new Slack(cfg.clientId, cfg.clientSecret, redirectUri));
    case "twitch": return arcticAdapter(cfg, redirectUri, new Twitch(cfg.clientId, cfg.clientSecret, redirectUri));
    case "spotify": return arcticAdapter(cfg, redirectUri, new Spotify(cfg.clientId, cfg.clientSecret, redirectUri));
    case "bitbucket": return arcticAdapter(cfg, redirectUri, new Bitbucket(cfg.clientId, cfg.clientSecret, redirectUri));
    case "dropbox": return arcticAdapter(cfg, redirectUri, new Dropbox(cfg.clientId, cfg.clientSecret, redirectUri));
    case "notion": return arcticAdapter(cfg, redirectUri, new Notion(cfg.clientId, cfg.clientSecret, redirectUri));
    case "box": return arcticAdapter(cfg, redirectUri, new Box(cfg.clientId, cfg.clientSecret, redirectUri));
    case "coinbase": return arcticAdapter(cfg, redirectUri, new Coinbase(cfg.clientId, cfg.clientSecret, redirectUri));
    case "line": return arcticAdapter(cfg, redirectUri, new Line(cfg.clientId, cfg.clientSecret, redirectUri));
    case "linear": return arcticAdapter(cfg, redirectUri, new Linear(cfg.clientId, cfg.clientSecret, redirectUri));
    case "atlassian": return arcticAdapter(cfg, redirectUri, new Atlassian(cfg.clientId, cfg.clientSecret, redirectUri));
    case "apple": return manualAppleAdapter(cfg, redirectUri);
    case "tiktok": return manualTikTokAdapter(cfg, redirectUri);
    case "hubspot":
    case "huggingface":
    case "xero":
    case "linkedin_oidc": return genericAdapter(cfg, redirectUri);
    default:
      if (key.startsWith("custom_")) return customOidcAdapter(cfg, redirectUri);
      return null;
  }
}
