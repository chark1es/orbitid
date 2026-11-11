import {
  DEFAULT_OIDC_ACCESS_TOKEN_LIFETIME_SECONDS,
  DEFAULT_OAUTH_APPLICATION_SCOPES,
  DEFAULT_OAUTH_GROUPS_CLAIM,
  type OAuthApplicationJSON,
} from "@orbitid/shared";

export type GroupsClaimMode = OAuthApplicationJSON["groups_claim"];

export interface AppForm {
  id?: string;
  name: string;
  redirectUris: string[];
  postLogoutRedirectUris: string[];
  scopes: string;
  publicClient: boolean;
  pkceRequired: boolean;
  consentScreenEnabled: boolean;
  accessTokenLifetimeSeconds: number;
  refreshTokenLifetimeSeconds: number;
  idTokenLifetimeSeconds: number;
  groupsClaim: GroupsClaimMode;
}

export const EMPTY_FORM: AppForm = {
  name: "",
  redirectUris: [""],
  postLogoutRedirectUris: [""],
  scopes: DEFAULT_OAUTH_APPLICATION_SCOPES,
  // Most self-hosted integrations (Tinyauth, Authentik, Grafana, oauth2-proxy…) are confidential clients.
  publicClient: false,
  pkceRequired: false,
  consentScreenEnabled: true,
  accessTokenLifetimeSeconds: DEFAULT_OIDC_ACCESS_TOKEN_LIFETIME_SECONDS,
  refreshTokenLifetimeSeconds: 2_592_000,
  idTokenLifetimeSeconds: 3600,
  groupsClaim: DEFAULT_OAUTH_GROUPS_CLAIM,
};

export function numberFrom(value: string): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Space-separated scope lists in seeded apps may repeat a scope; keep the first position of each. */
export function uniqueScopes(scopes: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const scope of scopes.split(/\s+/)) {
    if (!scope || seen.has(scope)) continue;
    seen.add(scope);
    result.push(scope);
  }
  return result;
}

export const LIFETIME_LIMITS = {
  access: { min: 60, max: 86_400 },
  refresh: { min: 60, max: 31_536_000 },
  id: { min: 60, max: 86_400 },
} as const;

export const GROUPS_CLAIM_OPTIONS: { value: GroupsClaimMode; label: string; description: string }[] = [
  { value: "all", label: "Slugs and role keys", description: "Organization slugs, organization roles and instance roles. Works for Grafana, Tinyauth and Authentik mappings." },
  { value: "organizations", label: "Organization slugs only", description: "One entry per organization, for example acme." },
  { value: "roles", label: "Role keys only", description: "Organization and instance role keys, for example org:admin or admin." },
  { value: "none", label: "No groups claim", description: "Omit the claim entirely." },
];
