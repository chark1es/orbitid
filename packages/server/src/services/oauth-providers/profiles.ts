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
import type { OAuthTokenSet } from "./core";

// ───────────── helpers ─────────────

export const rec = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
export const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
export const strOrEmpty = (v: unknown): string => (typeof v === "string" ? v : "");
/** Providers send flags as booleans or as the strings "true"/"false" (Apple does the latter). Anything else is unknown. */
export const boolOrUndefined = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : v === "true" ? true : v === "false" ? false : undefined);
export const at = (obj: unknown, path: string): unknown => path.split(".").reduce<unknown>((acc, part) => rec(acc)[part], obj);

export async function requestJson(ctx: AppContext, url: string, init: RequestInit = {}): Promise<unknown> {
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

export const bearer = (tokens: OAuthTokenSet) => ({ Authorization: `Bearer ${tokens.accessToken}` });
export const arcticTokens = (tokens: OAuth2Tokens): OAuthTokenSet => ({
  accessToken: tokens.accessToken(),
  refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : undefined,
  expiresAt: tokens.accessTokenExpiresAt().getTime(),
  scopes: tokens.hasScopes() ? tokens.scopes().join(" ") : undefined,
  idToken: tokens.idToken(),
  raw: rec(tokens.data),
});

export const profile = (key: string, p: Partial<ExternalProfile> & { providerUserId: string }, tokens?: OAuthTokenSet): ExternalProfile => ({
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

export function idTokenProfile(key: string, tokens: OAuthTokenSet): ExternalProfile {
  if (!tokens.idToken) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Identity provider did not return an ID token");
  const claims = decodeJwt(tokens.idToken);
  const sub = str(claims.sub);
  if (!sub) throw new OrbitError(502, ErrorCodes.oauth_callback_error, "Identity provider returned an ID token without a subject");
  return profile(key, {
    providerUserId: sub,
    email: str(claims.email),
    emailVerified: boolOrUndefined(claims.email_verified) ?? false,
    firstName: str(claims.given_name),
    lastName: str(claims.family_name),
    username: str(claims.preferred_username),
    imageUrl: str(claims.picture),
    raw: claims as Record<string, unknown>,
  }, tokens);
}

/** Normalizes the userinfo payload of the well-known providers. */
export function normalizeProfile(key: string, data: unknown, tokens: OAuthTokenSet): ExternalProfile {
  switch (key) {
    case "google": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.sub) || strOrEmpty(d.email),
        email: str(d.email), emailVerified: boolOrUndefined(d.email_verified) ?? false,
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
        email: str(d.email), emailVerified: false,
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
        email: str(d.email), emailVerified: !!d.confirmed_at,
        firstName: first || undefined, lastName: rest.join(" ") || undefined, username: str(d.username),
        imageUrl: str(d.avatar_url), raw: d,
      }, tokens);
    }
    case "discord": {
      const d = rec(data);
      const avatar = str(d.avatar);
      return profile(key, {
        providerUserId: String(d.id ?? ""),
        email: str(d.email), emailVerified: boolOrUndefined(d.verified) ?? false,
        username: str(d.username), imageUrl: avatar ? `https://cdn.discordapp.com/avatars/${String(d.id)}/${avatar}.png` : undefined, raw: d,
      }, tokens);
    }
    case "microsoft": {
      const d = rec(data);
      const email = str(d.email) ?? str(d.preferred_username);
      return profile(key, {
        providerUserId: strOrEmpty(d.sub) || strOrEmpty(d.oid) || strOrEmpty(email),
        email, emailVerified: false,
        firstName: str(d.given_name), lastName: str(d.family_name), username: email?.split("@")[0],
        imageUrl: str(d.picture), raw: d,
      }, tokens);
    }
    case "facebook": {
      const d = rec(data);
      const [first, ...rest] = strOrEmpty(d.name).split(" ");
      return profile(key, {
        providerUserId: String(d.id ?? ""),
        email: str(d.email), emailVerified: false,
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
        email: str(d.email), emailVerified: boolOrUndefined(d.email_verified) ?? false,
        firstName: str(d.given_name), lastName: str(d.family_name), imageUrl: str(d.picture), raw: d,
      }, tokens);
    }
    case "slack": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.sub) || strOrEmpty(d.email),
        email: str(d.email), emailVerified: boolOrUndefined(d.email_verified) ?? false,
        firstName: str(d.name), imageUrl: str(d.picture), raw: d,
      }, tokens);
    }
    case "twitch": {
      const d = rec(Array.isArray(rec(data).data) ? (rec(data).data as unknown[])[0] : {});
      return profile(key, {
        providerUserId: String(d.id ?? ""), email: str(d.email), emailVerified: false,
        username: str(d.display_name), firstName: str(d.display_name), imageUrl: str(d.profile_image_url), raw: d,
      }, tokens);
    }
    case "spotify": {
      const d = rec(data);
      const images = Array.isArray(d.images) ? d.images : [];
      return profile(key, {
        providerUserId: String(d.id ?? ""), email: str(d.email), emailVerified: false,
        firstName: str(d.display_name), username: str(d.display_name),
        imageUrl: str(rec(images[0]).url), raw: d,
      }, tokens);
    }
    case "bitbucket": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.uuid) || strOrEmpty(d.username),
        email: str(d.email), emailVerified: false,
        firstName: str(d.display_name), username: str(d.username), imageUrl: str(at(d, "links.avatar.href")), raw: d,
      }, tokens);
    }
    case "dropbox": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.account_id),
        email: str(d.email), emailVerified: boolOrUndefined(d.email_verified) ?? false,
        firstName: str(at(d, "name.display_name")), imageUrl: str(d.profile_photo_url), raw: d,
      }, tokens);
    }
    case "notion": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.id) || strOrEmpty(d.bot_id),
        email: str(at(d, "person.email")), emailVerified: false,
        firstName: str(d.name), imageUrl: str(d.avatar_url), raw: d,
      }, tokens);
    }
    case "hubspot": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.user) || strOrEmpty(d.hub_id),
        email: str(d.user), emailVerified: false, raw: d,
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
        providerUserId: strOrEmpty(d.id), email: str(d.email), emailVerified: false,
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
        providerUserId: strOrEmpty(d.id), email: str(d.email), emailVerified: false,
        firstName: str(d.name), username: str(d.displayName), imageUrl: str(d.avatarUrl), raw: d,
      }, tokens);
    }
    case "huggingface": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.id), email: str(d.email), emailVerified: boolOrUndefined(d.emailVerified) ?? false,
        firstName: str(d.fullname) ?? str(d.name), username: str(d.name), imageUrl: str(d.avatarUrl), raw: d,
      }, tokens);
    }
    case "box": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.id), email: str(d.login), emailVerified: false,
        firstName: str(d.name), username: str(d.login), imageUrl: str(d.avatar_url), raw: d,
      }, tokens);
    }
    case "atlassian": {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.account_id) || strOrEmpty(d.email),
        email: str(d.email), emailVerified: false, firstName: str(d.name), imageUrl: str(d.picture), raw: d,
      }, tokens);
    }
    case "zoom": {
      const d = rec(data);
      const email = str(d.email);
      return profile(key, {
        providerUserId: strOrEmpty(d.id) || strOrEmpty(email),
        email, emailVerified: false,
        firstName: str(d.first_name), lastName: str(d.last_name), username: email?.split("@")[0],
        imageUrl: str(d.pic_url), raw: d,
      }, tokens);
    }
    default: {
      const d = rec(data);
      return profile(key, {
        providerUserId: strOrEmpty(d.sub) || strOrEmpty(d.id) || strOrEmpty(d.email),
        email: str(d.email), emailVerified: boolOrUndefined(d.email_verified) ?? false,
        firstName: str(d.given_name) ?? str(d.first_name) ?? str(d.name),
        lastName: str(d.family_name) ?? str(d.last_name),
        username: str(d.preferred_username) ?? str(d.username),
        imageUrl: str(d.picture) ?? str(d.avatar_url), raw: d,
      }, tokens);
    }
  }
}

// ───────────── OIDC discovery (custom providers) ─────────────
