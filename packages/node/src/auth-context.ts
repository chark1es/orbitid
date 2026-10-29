import { createClaimsHasCheck } from "@orbitid/backend";
import type { AuthObject, SessionClaims } from "@orbitid/shared";

/** Permission/role check accepted by `has()`. Same shape as `@orbitid/backend`'s `AuthObject.has`. */
export type HasCheck = Parameters<AuthObject["has"]>[0];

/**
 * The signed-in caller, attached to requests by the framework adapters.
 * `claims` is the raw session JWT payload; `has()` reads `org_role`, `org_permissions` and `fva`.
 */
export interface AuthContext {
  userId: string;
  sessionId: string;
  orgId: string | null;
  orgRole: string | null;
  orgSlug: string | null;
  orgPermissions: string[];
  /** Impersonation context when an actor token created the session. */
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
    actor: claims.act ?? null,
    claims,
    has: createClaimsHasCheck(claims),
  };
}
