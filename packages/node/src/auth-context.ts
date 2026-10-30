import { createClaimsHasCheck } from "@orbitid/backend";
import type { AuthObject, SessionClaims } from "@orbitid/shared";

/** Permission/role check accepted by `has()`. Same shape as `@orbitid/backend`'s `AuthObject.has`. */
export type HasCheck = Parameters<AuthObject["has"]>[0];

/**
 * The signed-in caller, attached to requests by the framework adapters.
 * `claims` is the raw session JWT payload; `has()` reads `org_role`, `org_permissions`, `roles`,
 * `role_permissions` and `fva`.
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  orgId: string | null;
  orgRole: string | null;
  orgSlug: string | null;
  /** Permissions from the active organization membership (`org_permissions`). */
  orgPermissions: string[];
  /** Instance-wide role keys (`app:...`) assigned by an operator; never scoped to an organization. */
  roles: string[];
  /** Permissions granted by `roles` (`role_permissions`). */
  rolePermissions: string[];
  /** Historical impersonation context; no new session carries one. */
  actor: SessionClaims["act"] | null;
  claims: SessionClaims;
  has: (check: HasCheck) => boolean;
}

export function authContextFromClaims(claims: SessionClaims): AuthContext {
  return {
    userId: claims.sub,
    sessionId: claims.sid,
    orgId: claims.org_id ?? null,
    orgRole: claims.org_role ?? null,
    orgSlug: claims.org_slug ?? null,
    orgPermissions: Array.isArray(claims.org_permissions) ? claims.org_permissions : [],
    roles: Array.isArray(claims.roles) ? claims.roles.filter((role): role is string => typeof role === "string") : [],
    rolePermissions: Array.isArray(claims.role_permissions) ? claims.role_permissions.filter((permission): permission is string => typeof permission === "string") : [],
    actor: claims.act ?? null,
    claims,
    has: createClaimsHasCheck(claims),
  };
}
