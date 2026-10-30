/**
 * Session JWT claims (RS256/ES256, signed with the instance key, public keys at `/.well-known/jwks.json`).
 * Default `__session` token. Keys are short on purpose (cookie size).
 */
export interface SessionClaims {
  /** issuer = frontend API URL */
  iss: string;
  /** subject = user id */
  sub: string;
  /** session id */
  sid: string;
  iat: number;
  nbf: number;
  exp: number;
  /** authorized party (origin of the app that requested the token) */
  azp?: string;
  /** active organization */
  org_id?: string;
  org_slug?: string;
  org_role?: string; // "org:admin"
  org_permissions?: string[];
  /**
   * Instance-wide custom role keys assigned to the user by an operator (never by the user, the client or
   * metadata), e.g. `app:support`. Organization roles live in `org_role`; these are independent of one.
   */
  roles?: string[];
  /** Permissions granted by the instance roles in `roles` (the union, sorted). */
  role_permissions?: string[];
  /**
   * Impersonation context. Only sessions created before impersonation was removed carry this; it is kept
   * so historical activity and audit rows still deserialize.
   */
  act?: { sub: string; sid?: string; [k: string]: unknown };
  /** [firstFactorAgeMinutes, secondFactorAgeMinutes], -1 = not performed */
  fva?: [number, number];
  /** session status: "active" | "pending" */
  sts?: "active" | "pending";
  /** True for a guest (anonymous) account that has not attached an identifier yet. */
  anonymous?: boolean;
  /** custom claims from instance session.customClaims or JWT template */
  [key: string]: unknown;
}

export interface AuthObject {
  userId: string | null;
  sessionId: string | null;
  orgId: string | null;
  orgRole: string | null;
  orgSlug: string | null;
  orgPermissions: string[] | null;
  /** Instance-wide role keys (`app:...`) assigned by an operator; empty when there are none. */
  roles: string[];
  /** Permissions granted by those instance roles. Independent of `orgPermissions`. */
  rolePermissions: string[];
  actor: SessionClaims["act"] | null;
  sessionClaims: SessionClaims | null;
  sessionStatus: "active" | "pending" | null;
  getToken: (opts?: { template?: string }) => Promise<string | null>;
  has: (check: { role?: string; permission?: string; feature?: string; reverification?: ReverificationConfig }) => boolean;
  isAuthenticated: boolean;
  redirectToSignIn: (opts?: { returnBackUrl?: string }) => unknown;
}
export type ReverificationLevel = "first_factor" | "second_factor" | "multi_factor";
export type ReverificationConfig = { level: ReverificationLevel; afterMinutes: number } | "strict_mfa" | "strict" | "moderate" | "lax";
