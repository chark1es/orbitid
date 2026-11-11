import { type InstanceSettings, type SocialProviderConfig } from "@orbitid/shared";

export const PROVIDER_LABELS: Record<string, string> = {
  google: "Google",
  github: "GitHub",
  gitlab: "GitLab",
  discord: "Discord",
  microsoft: "Microsoft",
  apple: "Apple",
  facebook: "Facebook",
  twitter: "Twitter",
  linkedin_oidc: "LinkedIn",
  slack: "Slack",
  twitch: "Twitch",
  spotify: "Spotify",
  bitbucket: "Bitbucket",
  dropbox: "Dropbox",
  notion: "Notion",
  hubspot: "HubSpot",
  tiktok: "TikTok",
  coinbase: "Coinbase",
  line: "LINE",
  linear: "Linear",
  huggingface: "Hugging Face",
  box: "Box",
  atlassian: "Atlassian",
  xero: "Xero",
  x: "X",
  zoom: "Zoom",
};

export const PROVIDER_ACCENTS: Record<string, string> = {
  google: "#4285f4",
  github: "#24292f",
  gitlab: "#fc6d26",
  discord: "#5865f2",
  microsoft: "#0078d4",
  apple: "#111111",
  facebook: "#1877f2",
  twitter: "#1d9bf0",
  linkedin_oidc: "#0a66c2",
  slack: "#4a154b",
  twitch: "#9146ff",
  spotify: "#1db954",
  bitbucket: "#0052cc",
  dropbox: "#0061ff",
  notion: "#111111",
  hubspot: "#ff7a59",
  tiktok: "#111111",
  coinbase: "#0052ff",
  line: "#06c755",
  linear: "#5e6ad2",
  huggingface: "#ffcc4d",
  box: "#0061d5",
  atlassian: "#0052cc",
  xero: "#13b5ea",
  x: "#111111",
  zoom: "#2d8cff",
};

export const PROVIDER_DEFAULT_SCOPES: Record<string, string[]> = {
  google: ["openid", "email", "profile"],
  github: ["read:user", "user:email"],
  gitlab: ["read_user"],
  discord: ["identify", "email"],
  microsoft: ["openid", "email", "profile"],
  apple: ["name", "email"],
  facebook: ["email", "public_profile"],
  twitter: ["tweet.read", "users.read"],
  linkedin_oidc: ["openid", "profile", "email"],
  slack: ["openid", "profile", "email"],
  twitch: ["user:read:email"],
  spotify: ["user-read-email", "user-read-private"],
  bitbucket: ["account", "email"],
  dropbox: ["account_info.read"],
  notion: ["read_user"],
  hubspot: ["oauth"],
  tiktok: ["user.info.basic"],
  coinbase: ["wallet:user:read"],
  line: ["profile", "openid", "email"],
  linear: ["read"],
  huggingface: ["openid", "profile", "email"],
  box: ["openid"],
  atlassian: ["read:me"],
  xero: ["openid", "profile", "email"],
  x: ["users.read", "tweet.read"],
  zoom: ["user:read"],
};

export const emptySocialProvider = (): SocialProviderConfig => ({
  enabled: false,
  clientId: "",
  clientSecret: "",
  scopes: [],
  authenticatableAtSignIn: true,
  clientAuthMethod: "client_secret_basic",
  pkce: true,
  trustEmailVerified: false,
  claimMapping: { sub: "", email: "", emailVerified: "", name: "", firstName: "", lastName: "", username: "", picture: "" },
});

export function socialProviderConfig(settings: InstanceSettings, key: string): SocialProviderConfig {
  return { ...emptySocialProvider(), ...(settings.social[key] ?? {}) };
}

export function providerLabel(key: string, config?: SocialProviderConfig): string {
  if (config?.name) return config.name;
  if (PROVIDER_LABELS[key]) return PROVIDER_LABELS[key]!;
  if (key.startsWith("custom_")) return key.slice("custom_".length).replace(/[_-]+/g, " ");
  return key;
}

export function providerInitial(key: string, config?: SocialProviderConfig): string {
  return providerLabel(key, config).trim().charAt(0).toUpperCase() || "?";
}

export function isCustomProviderKey(key: string): boolean {
  return /^custom_[a-z0-9][a-z0-9_-]*$/.test(key);
}

export function oauthCallbackUrl(apiUrl: string, provider: string): string {
  return `${apiUrl.replace(/\/+$/, "")}/v1/oauth_callback/${provider}`;
}

/* ------------------------------------------------------------------------------------------------
 * Webhook events
 * ---------------------------------------------------------------------------------------------- */
