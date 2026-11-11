// Custom OIDC and plain OAuth 2.0 providers (`custom_<key>`).
//
// A custom provider is either discovered (a `.well-known` document) or configured with manual endpoints.
// OIDC providers may return a signed ID token; OAuth 2.0 providers return a profile from `userinfo`. Both can
// map their claims with dotted JSON paths, which is what makes providers with wrapped payloads usable without
// code changes.
import { createHash } from "node:crypto";
import { jwtVerify } from "jose";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../../context";
import { assertPublicUrl, remoteJwks, safeFetch } from "../../lib/safe-fetch";
import type { ExternalProfile } from "../external-identity";
import type { OAuthAdapter, OAuthProviderConfig, OAuthTokenSet } from "./core";
import { at, bearer, boolOrUndefined, profile, rec, requestJson, str } from "./profiles";

export interface OidcDiscovery {
  issuer?: string;
  authorization_endpoint: string;
  token_endpoint: string;
  userinfo_endpoint?: string;
  jwks_uri?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  token_endpoint_auth_methods_supported?: string[];
}

const discoveryCache = new Map<string, { doc: OidcDiscovery; expiresAt: number }>();

/** Forgets cached discovery documents (tests change providers between cases). */
export function resetDiscoveryCache() {
  discoveryCache.clear();
}

const stringList = (value: unknown): string[] | undefined =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;

/** Fetches a discovery document, validates its shape and judges every endpoint it names. */
export async function loadDiscovery(ctx: AppContext, url: string): Promise<OidcDiscovery> {
  const cached = discoveryCache.get(url);
  if (cached && cached.expiresAt > Date.now()) return cached.doc;
  const raw = rec(await requestJson(ctx, url));
  const doc: OidcDiscovery = {
    issuer: str(raw.issuer),
    authorization_endpoint: str(raw.authorization_endpoint) ?? "",
    token_endpoint: str(raw.token_endpoint) ?? "",
    userinfo_endpoint: str(raw.userinfo_endpoint),
    jwks_uri: str(raw.jwks_uri),
    scopes_supported: stringList(raw.scopes_supported),
    code_challenge_methods_supported: stringList(raw.code_challenge_methods_supported),
    token_endpoint_auth_methods_supported: stringList(raw.token_endpoint_auth_methods_supported),
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

/**
 * The endpoints a custom provider talks to: the discovery document when there is one, otherwise the manual
 * fields. Discovery wins so an operator can switch between the two without clearing the other.
 */
export async function customEndpoints(ctx: AppContext, cfg: OAuthProviderConfig): Promise<OidcDiscovery> {
  if (cfg.discoveryUrl?.trim()) return loadDiscovery(ctx, cfg.discoveryUrl.trim());
  const authorization = cfg.authorizationUrl?.trim();
  const token = cfg.tokenUrl?.trim();
  if (!authorization || !token) {
    throw new OrbitError(
      400,
      ErrorCodes.oauth_provider_not_enabled,
      "The custom provider needs a discovery URL or manual authorization and token endpoints",
    );
  }
  for (const [url, field] of [[authorization, "authorizationUrl"], [token, "tokenUrl"], [cfg.userinfoUrl?.trim(), "userinfoUrl"], [cfg.jwksUrl?.trim(), "jwksUrl"]] as const) {
    if (url) await assertPublicUrl(ctx, url, field);
  }
  return {
    issuer: cfg.issuer?.trim() || undefined,
    authorization_endpoint: authorization,
    token_endpoint: token,
    userinfo_endpoint: cfg.userinfoUrl?.trim() || undefined,
    jwks_uri: cfg.jwksUrl?.trim() || undefined,
  };
}

const firstString = (data: unknown, paths: string[]): string | undefined => {
  for (const path of paths) {
    const value = path ? at(data, path) : undefined;
    if (typeof value === "string" && value.length > 0) return value;
    if (typeof value === "number") return String(value);
  }
  return undefined;
};

const splitName = (name: string | undefined): { firstName?: string; lastName?: string } => {
  if (!name) return {};
  const [first, ...rest] = name.trim().split(/\s+/);
  return { firstName: first || undefined, lastName: rest.join(" ") || undefined };
};

/**
 * Reads an `email_verified`-style claim without ever turning an explicit negative into true. Providers send
 * booleans, the strings "true"/"false", and 0/1; all of those are preserved. Only a genuinely absent claim falls
 * back to the operator's `trustEmailVerified` promise.
 */
function verifiedClaim(value: unknown): boolean | undefined {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value === 1 ? true : value === 0 ? false : undefined;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true" || normalized === "1") return true;
    if (normalized === "false" || normalized === "0") return false;
  }
  return undefined;
}

/**
 * Turns a claim set (ID token or userinfo) into an `ExternalProfile`. `claimMapping` maps any field to a dotted
 * path; empty entries fall back to the conventional OIDC/OAuth names. `trustEmailVerified` is the operator's
 * explicit promise that the provider checked the address when it sends no `email_verified` claim — it never
 * overrides a claim that says `false`.
 */
export function mappedProfile(cfg: OAuthProviderConfig, data: unknown, tokens: OAuthTokenSet): ExternalProfile {
  const map = cfg.claimMapping ?? {};
  const mapped = (field: keyof typeof map) => (map[field] ?? "").trim();
  const subject = firstString(data, [mapped("sub"), "sub", "id", "user_id", "userId", "open_id", "account_id"]);
  if (!subject) {
    throw new OrbitError(502, ErrorCodes.oauth_callback_error, "The identity provider returned a profile without a subject");
  }
  const email = firstString(data, [mapped("email"), "email", "mail", "email_address"]);
  const verifiedRaw = mapped("emailVerified")
    ? at(data, mapped("emailVerified"))
    : at(data, "email_verified") ?? at(data, "verified") ?? at(data, "email_verified_flag");
  const explicit = verifiedClaim(verifiedRaw);
  const emailVerified = explicit !== undefined ? explicit : (cfg.trustEmailVerified ? !!email : false);
  const name = firstString(data, [mapped("name"), "name", "display_name", "displayName", "fullname", "full_name"]);
  const fromName = splitName(name);
  return profile(cfg.key, {
    providerUserId: subject,
    email,
    emailVerified,
    firstName: firstString(data, [mapped("firstName"), "given_name", "first_name", "firstName"]) ?? fromName.firstName,
    lastName: firstString(data, [mapped("lastName"), "family_name", "last_name", "lastName"]) ?? fromName.lastName,
    username: firstString(data, [mapped("username"), "preferred_username", "username", "login", "screen_name"]),
    imageUrl: firstString(data, [mapped("picture"), "picture", "avatar_url", "avatarUrl", "image", "profile_image_url"]),
    raw: rec(data),
  }, tokens);
}

/**
 * Verifies a custom provider's ID token: signature against its JWKS, issuer when one is known, audience, expiry
 * and (when one was sent) the nonce. A failed check is final — falling back to userinfo would let a forged
 * token's claims be replaced by someone else's.
 */
export async function verifyCustomIdToken(
  ctx: AppContext,
  cfg: OAuthProviderConfig,
  disco: Pick<OidcDiscovery, "issuer" | "jwks_uri">,
  idToken: string,
  nonce: string | undefined,
): Promise<Record<string, unknown>> {
  if (!disco.jwks_uri) {
    throw new OrbitError(502, ErrorCodes.oauth_callback_error, "The identity provider has no JWKS to verify its ID token");
  }
  // A key rotation between the fetch and the verification is common: retry once against a fresh key set.
  for (const forceRefresh of [false, true]) {
    try {
      const jwks = await remoteJwks(ctx, disco.jwks_uri, { forceRefresh });
      const { payload } = await jwtVerify(idToken, jwks, {
        issuer: disco.issuer,
        audience: cfg.clientId,
        // A minute of clock skew is normal between self-hosted servers.
        clockTolerance: 60,
        // Pin the algorithms: without this an RS256 key could be used as an HMAC secret ("alg confusion").
        algorithms: ["RS256", "ES256", "PS256", "EdDSA"],
      });
      if (nonce && payload.nonce !== nonce) throw new Error("nonce mismatch");
      return payload as Record<string, unknown>;
    } catch (err) {
      const message = (err as Error).message;
      if (message === "nonce mismatch") {
        throw new OrbitError(502, ErrorCodes.oauth_callback_error, "The identity provider returned an ID token whose nonce did not match");
      }
      if (!forceRefresh) continue;
      throw new OrbitError(502, ErrorCodes.oauth_callback_error, "The identity provider returned an ID token that could not be verified");
    }
  }
  // Unreachable: the loop either returns or throws.
  throw new OrbitError(502, ErrorCodes.oauth_callback_error, "The identity provider returned an ID token that could not be verified");
}

/** Uses verified ID-token claims when present, otherwise the userinfo endpoint. */
async function customProfile(ctx: AppContext, cfg: OAuthProviderConfig, tokens: OAuthTokenSet, nonce?: string): Promise<ExternalProfile> {
  const endpoints = await customEndpoints(ctx, cfg);
  if (tokens.idTokenClaims) return mappedProfile(cfg, tokens.idTokenClaims, tokens);
  if (tokens.idToken && endpoints.jwks_uri) {
    const claims = await verifyCustomIdToken(ctx, cfg, endpoints, tokens.idToken, nonce);
    return mappedProfile(cfg, claims, tokens);
  }
  if (endpoints.userinfo_endpoint) {
    const data = rec(await requestJson(ctx, endpoints.userinfo_endpoint, { headers: bearer(tokens) }));
    return mappedProfile(cfg, data, tokens);
  }
  throw new OrbitError(502, ErrorCodes.oauth_callback_error, "The identity provider did not return a usable profile");
}

const pkceChallenge = (verifier: string) => createHash("sha256").update(verifier).digest("base64url");
const basicAuth = (cfg: OAuthProviderConfig) =>
  `Basic ${Buffer.from(`${cfg.clientId}:${cfg.clientSecret}`, "utf8").toString("base64")}`;

/** True when the provider is configured for plain OAuth 2.0 (no ID token expected). */
export const isOAuth2Provider = (cfg: OAuthProviderConfig) => cfg.protocol === "oauth2";

/** Builds the adapter for a `custom_<key>` provider, discovered or manually configured. */
export async function customAdapter(ctx: AppContext, cfg: OAuthProviderConfig, redirectUri: string): Promise<OAuthAdapter> {
  const endpoints = await customEndpoints(ctx, cfg);
  const usesPkce = cfg.pkce !== false;
  const idTokenVerifiable = !isOAuth2Provider(cfg) && !!endpoints.jwks_uri;
  return {
    key: cfg.key,
    usesNonce: idTokenVerifiable,
    async createAuthorizationUrl({ state, codeVerifier, scopes, nonce }) {
      const url = new URL(endpoints.authorization_endpoint);
      url.searchParams.set("response_type", "code");
      url.searchParams.set("client_id", cfg.clientId);
      url.searchParams.set("redirect_uri", redirectUri);
      if (scopes.length) url.searchParams.set("scope", scopes.join(" "));
      url.searchParams.set("state", state);
      if (nonce) url.searchParams.set("nonce", nonce);
      if (usesPkce) {
        url.searchParams.set("code_challenge", pkceChallenge(codeVerifier));
        url.searchParams.set("code_challenge_method", "S256");
      }
      return url;
    },
    async exchangeCode({ code, codeVerifier, nonce }) {
      const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirectUri });
      if (usesPkce && codeVerifier) body.set("code_verifier", codeVerifier);
      const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
      const basic = cfg.clientAuthMethod !== "client_secret_post" && !!cfg.clientSecret;
      if (basic) headers.authorization = basicAuth(cfg);
      else {
        body.set("client_id", cfg.clientId);
        if (cfg.clientSecret) body.set("client_secret", cfg.clientSecret);
      }
      const raw = rec(await requestJson(ctx, endpoints.token_endpoint, { method: "POST", headers, body }));
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
      if (idToken && idTokenVerifiable) tokens.idTokenClaims = await verifyCustomIdToken(ctx, cfg, endpoints, idToken, nonce);
      return tokens;
    },
    async fetchProfile({ tokens }) {
      return customProfile(ctx, cfg, tokens);
    },
  };
}

// ───────────── discovery / endpoint preview (dashboard "Test connection") ─────────────

export interface ProviderPreviewInput {
  protocol?: "oidc" | "oauth2";
  discoveryUrl?: string;
  issuer?: string;
  authorizationUrl?: string;
  tokenUrl?: string;
  userinfoUrl?: string;
  jwksUrl?: string;
}

export interface EndpointCheck {
  name: string;
  url: string;
  reachable: boolean;
  status?: number;
  error?: string;
}

export interface ProviderPreview {
  ok: boolean;
  protocol: "oidc" | "oauth2";
  issuer?: string;
  endpoints: { authorization: string; token: string; userinfo?: string; jwks?: string };
  scopes_supported?: string[];
  pkce_supported?: boolean;
  client_auth_methods?: string[];
  checks: EndpointCheck[];
  warnings: string[];
  errors: string[];
}

/** A bounded GET: any HTTP answer proves the endpoint exists; only a transport failure is an error. */
async function probe(ctx: AppContext, name: string, url: string): Promise<EndpointCheck> {
  try {
    const res = await safeFetch(ctx, url, { timeoutMs: 5_000, maxBytes: 256 * 1024, headers: { accept: "application/json, application/xml;q=0.9, */*;q=0.8" } });
    return { name, url, reachable: true, status: res.status };
  } catch (err) {
    return { name, url, reachable: false, error: (err as Error).message };
  }
}

/**
 * Checks a custom provider's URLs without saving them: resolves discovery when one is given, validates the
 * endpoints, probes them and reports what the provider advertises. Errors are returned, never thrown, so the
 * dashboard can show all of them at once.
 */
export async function previewProvider(ctx: AppContext, input: ProviderPreviewInput): Promise<ProviderPreview> {
  const protocol: "oidc" | "oauth2" = input.protocol ?? "oidc";
  const errors: string[] = [];
  const warnings: string[] = [];
  let endpoints: OidcDiscovery | null = null;

  if (input.discoveryUrl?.trim()) {
    try {
      endpoints = await loadDiscovery(ctx, input.discoveryUrl.trim());
    } catch (err) {
      errors.push((err as Error).message);
    }
  } else {
    const authorization = input.authorizationUrl?.trim();
    const token = input.tokenUrl?.trim();
    if (!authorization || !token) {
      errors.push("Add a discovery URL, or the manual authorization and token endpoints.");
    } else {
      try {
        await assertPublicUrl(ctx, authorization, "authorizationUrl");
        await assertPublicUrl(ctx, token, "tokenUrl");
        endpoints = {
          issuer: input.issuer?.trim() || undefined,
          authorization_endpoint: authorization,
          token_endpoint: token,
          userinfo_endpoint: input.userinfoUrl?.trim() || undefined,
          jwks_uri: input.jwksUrl?.trim() || undefined,
        };
      } catch (err) {
        errors.push((err as Error).message);
      }
    }
  }

  const checks: EndpointCheck[] = [];
  if (endpoints) {
    const candidates: [string, string | undefined][] = [
      ["Authorization endpoint", endpoints.authorization_endpoint],
      ["Token endpoint", endpoints.token_endpoint],
      ["Userinfo endpoint", endpoints.userinfo_endpoint],
      ["JWKS", endpoints.jwks_uri],
    ];
    for (const [name, url] of candidates) {
      // Userinfo/JWKS are optional; the two token endpoints are required.
      if (!url) {
        if (name === "Authorization endpoint" || name === "Token endpoint") errors.push(`${name} is missing.`);
        continue;
      }
      checks.push(await probe(ctx, name, url));
    }
    if (!endpoints.jwks_uri) {
      if (protocol === "oidc") warnings.push("No JWKS: an ID token cannot be verified, so the profile is read from userinfo.");
      if (!endpoints.userinfo_endpoint) errors.push("An OIDC provider without a JWKS needs a userinfo endpoint.");
    }
    if (!endpoints.userinfo_endpoint && !endpoints.jwks_uri) warnings.push("The provider has no userinfo endpoint; only ID-token claims can identify a user.");
    if (endpoints.scopes_supported && !endpoints.scopes_supported.includes("openid") && protocol === "oidc") {
      warnings.push("The discovery document does not advertise the `openid` scope; check that this is an OpenID Connect provider.");
    }
    if (endpoints.code_challenge_methods_supported && !endpoints.code_challenge_methods_supported.includes("S256")) {
      warnings.push("The provider does not advertise PKCE S256; turn PKCE off only if it rejects the request.");
    }
    if (endpoints.token_endpoint_auth_methods_supported?.length) {
      warnings.push(`Token endpoint authentication methods: ${endpoints.token_endpoint_auth_methods_supported.join(", ")}.`);
    }
    if (protocol === "oidc" && !endpoints.issuer) warnings.push("No issuer: ID-token issuer checks are skipped, so the profile is read from userinfo.");
  }

  const failed = checks.filter((check) => !check.reachable).map((check) => `${check.name} is unreachable: ${check.error}`);
  return {
    ok: errors.length === 0 && failed.length === 0,
    protocol,
    issuer: endpoints?.issuer,
    endpoints: {
      authorization: endpoints?.authorization_endpoint ?? "",
      token: endpoints?.token_endpoint ?? "",
      userinfo: endpoints?.userinfo_endpoint,
      jwks: endpoints?.jwks_uri,
    },
    scopes_supported: endpoints?.scopes_supported,
    pkce_supported: endpoints?.code_challenge_methods_supported?.includes("S256"),
    client_auth_methods: endpoints?.token_endpoint_auth_methods_supported,
    checks,
    warnings: [...warnings, ...failed],
    errors,
  };
}

/** Reads a claim by dotted path (exported for tests and future mappings). */
export const claimAt = (data: unknown, path: string) => (path ? at(data, path) : undefined);
