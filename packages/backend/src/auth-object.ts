import type { AuthObject, ReverificationConfig, ReverificationLevel, SessionClaims } from "@orbitid/shared";

interface ReverificationAges {
  firstFactor: number;
  secondFactor: number;
}

const REVERIFICATION_PRESETS: Record<string, { firstFactor: number; secondFactor: number }> = {
  strict_mfa: { firstFactor: 10, secondFactor: 10 },
  strict: { firstFactor: 10, secondFactor: -1 },
  moderate: { firstFactor: 60, secondFactor: 60 },
  lax: { firstFactor: 1440, secondFactor: 1440 },
};

function reverificationLevels(config: ReverificationConfig): { level: ReverificationLevel; afterMinutes: number }[] {
  if (typeof config === "string") {
    const preset = REVERIFICATION_PRESETS[config];
    if (!preset) return [];
    const levels: { level: ReverificationLevel; afterMinutes: number }[] = [{ level: "first_factor", afterMinutes: preset.firstFactor }];
    if (preset.secondFactor >= 0) levels.push({ level: "second_factor", afterMinutes: preset.secondFactor });
    return levels;
  }
  if (config.level === "multi_factor") {
    return [
      { level: "first_factor", afterMinutes: config.afterMinutes },
      { level: "second_factor", afterMinutes: config.afterMinutes },
    ];
  }
  return [{ level: config.level, afterMinutes: config.afterMinutes }];
}

export function checkReverification(ages: ReverificationAges | null | undefined, config: ReverificationConfig): boolean {
  if (!ages) return false;
  const levels = reverificationLevels(config);
  if (!levels.length) return false;
  return levels.every(({ level, afterMinutes }) => {
    const age = level === "second_factor" ? ages.secondFactor : ages.firstFactor;
    return typeof age === "number" && age >= 0 && age <= afterMinutes;
  });
}

function includesPermission(granted: string[], requested: string): boolean {
  return granted.some((permission) => {
    if (permission === requested) return true;
    if (permission.endsWith(":*")) return requested.startsWith(permission.slice(0, -1));
    return false;
  });
}

/** `has()` backed by a session token's `org_role`, `org_permissions` and `fva` claims. */
export function createClaimsHasCheck(claims: SessionClaims | null): AuthObject["has"] {
  const orgRole = typeof claims?.org_role === "string" ? claims.org_role : null;
  const orgPermissions = Array.isArray(claims?.org_permissions) ? (claims.org_permissions as string[]) : [];
  const fva = Array.isArray(claims?.fva) && claims.fva.length === 2 ? (claims.fva as [number, number]) : null;

  return (check) => {
    if (!claims) return false;
    if (check.reverification !== undefined) {
      const ages = fva ? { firstFactor: fva[0], secondFactor: fva[1] } : null;
      if (!checkReverification(ages, check.reverification)) return false;
    }
    if (check.role !== undefined) {
      const roles = Array.isArray(check.role) ? check.role : [check.role];
      if (!orgRole || !roles.includes(orgRole)) return false;
    }
    if (check.permission !== undefined && check.feature === undefined) {
      const permissions = Array.isArray(check.permission) ? check.permission : [check.permission];
      if (!permissions.every((permission) => includesPermission(orgPermissions, permission))) return false;
    }
    if (check.feature !== undefined) {
      const feature = check.feature.startsWith("org:") ? check.feature : `org:${check.feature}`;
      if (check.permission !== undefined) {
        if (!includesPermission(orgPermissions, `${feature}:${check.permission}`)) return false;
      } else if (!orgPermissions.some((permission) => permission === feature || permission.startsWith(`${feature}:`))) {
        return false;
      }
    }
    return true;
  };
}

export interface BuildAuthObjectOptions {
  signInUrl?: string;
  returnBackUrl?: string;
}

function buildSignInRedirect(signInUrl: string, returnBackUrl?: string): Response {
  const url = new URL(signInUrl, "http://localhost");
  if (returnBackUrl) url.searchParams.set("redirect_url", returnBackUrl);
  const location = signInUrl.startsWith("http") ? url.toString() : `${url.pathname}${url.search}`;
  return new Response(null, { status: 307, headers: { Location: location } });
}

export function buildAuthObject(
  claims: SessionClaims | null,
  getToken: AuthObject["getToken"],
  options: BuildAuthObjectOptions = {},
): AuthObject {
  const signInUrl = options.signInUrl ?? "/sign-in";
  return {
    userId: claims?.sub ?? null,
    sessionId: claims?.sid ?? null,
    orgId: claims?.org_id ?? null,
    orgRole: claims?.org_role ?? null,
    orgSlug: claims?.org_slug ?? null,
    orgPermissions: claims?.org_permissions ?? null,
    actor: claims?.act ?? null,
    sessionClaims: claims,
    sessionStatus: claims?.sts ?? (claims ? "active" : null),
    getToken,
    has: createClaimsHasCheck(claims),
    isAuthenticated: !!claims?.sub,
    redirectToSignIn: (redirectOptions) => buildSignInRedirect(signInUrl, redirectOptions?.returnBackUrl ?? options.returnBackUrl),
  };
}
