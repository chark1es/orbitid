import { SOCIAL_PROVIDERS, type SocialProviderConfig } from "@orbitid/shared";
import { isHttpUrl } from "../_config/settings";

export const BUILT_IN_KEYS: string[] = [...SOCIAL_PROVIDERS];

export type ProviderProtocol = "oidc" | "oauth2";

export const CLAIM_FIELDS = [
  { key: "sub", label: "Subject", placeholder: "sub" },
  { key: "email", label: "Email", placeholder: "email" },
  { key: "emailVerified", label: "Email verified", placeholder: "email_verified" },
  { key: "name", label: "Full name", placeholder: "name" },
  { key: "firstName", label: "First name", placeholder: "given_name" },
  { key: "lastName", label: "Last name", placeholder: "family_name" },
  { key: "username", label: "Username", placeholder: "preferred_username" },
  { key: "picture", label: "Picture", placeholder: "picture" },
] as const;

export type ClaimFieldKey = (typeof CLAIM_FIELDS)[number]["key"];

export const protocolOf = (config: SocialProviderConfig): ProviderProtocol => config.protocol ?? "oidc";

/** A provider key as it is stored: `custom_<lowercase>`. */
export const customKeyValue = (raw: string) => raw.trim().toLowerCase().replace(/[^a-z0-9_-]/g, "-");

export function customKeyErrors(raw: string, existing: string[]): string[] {
  const value = customKeyValue(raw);
  const errors: string[] = [];
  if (!value) return ["Provider key is required."];
  if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(value)) errors.push("Key must use lowercase letters, numbers, dashes or underscores.");
  if (existing.includes(`custom_${value}`)) errors.push("That provider key already exists.");
  return errors;
}

/**
 * Mirrors the server's settings policy so the save button explains a problem before the request. `enabled`
 * providers only: a draft that is still off may keep incomplete values.
 */
export function customProviderErrors(key: string, config: SocialProviderConfig): string[] {
  // The server only validates providers that are on; a disabled draft may keep incomplete values.
  if (!config.enabled) return [];
  const errors: string[] = [];
  const custom = key.startsWith("custom_");
  const protocol = protocolOf(config);
  if (custom && !config.name?.trim()) errors.push("Display name is required.");
  if (!config.clientId.trim()) errors.push(`${key}: client ID is required.`);
  const publicClient = custom && config.pkce !== false && !config.clientSecret;
  if (!config.clientSecret && !publicClient && key !== "apple") errors.push(`${key}: client secret is required (or keep PKCE on for a public client).`);
  if (!custom) return errors;
  const discovery = config.discoveryUrl?.trim();
  const hasManual = Boolean(config.authorizationUrl?.trim() && config.tokenUrl?.trim());
  if (config.enabled && !discovery && !hasManual) errors.push(`${key}: add a discovery URL, or the authorization and token endpoints.`);
  if (discovery && !isHttpUrl(discovery)) errors.push(`${key}: discovery URL must be an http(s) URL.`);
  for (const [field, label] of [
    ["authorizationUrl", "Authorization URL"],
    ["tokenUrl", "Token URL"],
    ["userinfoUrl", "Userinfo URL"],
    ["jwksUrl", "JWKS URL"],
    ["logoUrl", "Logo URL"],
    ["issuer", "Issuer"],
  ] as const) {
    const value = config[field]?.trim();
    if (value && !isHttpUrl(value)) errors.push(`${key}: ${label} must be an http(s) URL.`);
  }
  if (config.enabled && !discovery && hasManual) {
    if (protocol === "oauth2" && !config.userinfoUrl?.trim()) errors.push(`${key}: an OAuth 2.0 provider needs a userinfo URL.`);
    if (protocol === "oidc" && !config.userinfoUrl?.trim() && !config.jwksUrl?.trim()) {
      errors.push(`${key}: add a userinfo URL or a JWKS URL so the profile can be read.`);
    }
  }
  return errors;
}

/** The body `POST /v1/instance/social/test` expects, built from the draft the operator is looking at. */
export function previewBody(config: SocialProviderConfig) {
  return {
    protocol: protocolOf(config),
    discoveryUrl: config.discoveryUrl?.trim() || undefined,
    issuer: config.issuer?.trim() || undefined,
    authorizationUrl: config.authorizationUrl?.trim() || undefined,
    tokenUrl: config.tokenUrl?.trim() || undefined,
    userinfoUrl: config.userinfoUrl?.trim() || undefined,
    jwksUrl: config.jwksUrl?.trim() || undefined,
  };
}
