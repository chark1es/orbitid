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
import {
  APPLE_TOKEN_URL, adapterOverrides, appleClientSecret, providerConfig, providerRedirectUri, verifyAppleIdToken,
  type OAuthAdapter, type OAuthProviderConfig, type OAuthTokenSet,
} from "./core";
import {
  arcticTokens, at, bearer, boolOrUndefined, idTokenProfile,
  normalizeProfile, profile, rec, requestJson, str,
} from "./profiles";

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
      // The public profile email is unverified, so always ask for the verified list and prefer it.
      try {
        const emails = await requestJson(ctx, "https://api.github.com/user/emails", { headers: { ...headers, "User-Agent": "OrbitID", Accept: "application/vnd.github+json" } });
        if (Array.isArray(emails)) {
          const list = emails.map(rec);
          const primary = list.find((e) => e.primary === true && e.verified === true) ?? list.find((e) => e.verified === true);
          if (primary) {
            p.email = str(primary.email);
            p.emailVerified = primary.verified === true;
          }
        }
      } catch {
        // Without the `user:email` scope only the (unverified) public address is known.
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
        if (email) { p.email = email; p.emailVerified = false; }
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
        p.emailVerified = boolOrUndefined(claims.email_verified) ?? false;
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
    emailVerified: boolOrUndefined(claims.email_verified) ?? false,
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
