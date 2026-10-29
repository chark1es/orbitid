import { withPublicUserDataAliases } from "../lib/resources";
import type {
  Actor,
  AuthState,
  HasParams,
  OrbitIDInitialState,
  OrbitIDInstance,
  OrbitIDSnapshot,
  OrganizationResource,
  SessionClaims,
  SessionResource,
  SignOutParams,
  UserResource,
} from "./types";

export interface HasContext {
  isSignedIn: boolean;
  orgRole: string | null;
  orgPermissions: string[] | null;
  features: string[];
  factorVerificationAge: [number, number] | null;
}

/** Reverification presets, in minutes since the factor was last verified. */
const REVERIFICATION_PRESETS = {
  strict_mfa: { level: "multi_factor", afterMinutes: 10 },
  strict: { level: "first_factor", afterMinutes: 10 },
  moderate: { level: "first_factor", afterMinutes: 60 },
  lax: { level: "first_factor", afterMinutes: 1440 },
} as const;

function checkReverification(
  config: NonNullable<HasParams["reverification"]>,
  factorVerificationAge: [number, number] | null,
): boolean {
  if (!factorVerificationAge) return false;
  const [firstFactorAge, secondFactorAge] = factorVerificationAge;
  const resolved = typeof config === "string" ? REVERIFICATION_PRESETS[config] : config;
  if (!resolved) return false;
  const firstOk = firstFactorAge >= 0 && firstFactorAge <= resolved.afterMinutes;
  const secondOk = secondFactorAge >= 0 && secondFactorAge <= resolved.afterMinutes;
  switch (resolved.level) {
    case "first_factor":
      return firstOk;
    case "second_factor":
      return secondOk;
    case "multi_factor":
      return firstOk && secondOk;
    default:
      return false;
  }
}

/**
 * `has()`:
 * `has({ role })`, `has({ permission })`, `has({ feature })`, `has({ reverification })`,
 * `has({ condition })` — exactly one key, signed-out → `false`.
 */
export function checkHas(params: HasParams, context: HasContext): boolean {
  const keys = (Object.keys(params) as Array<keyof HasParams>).filter((key) => params[key] !== undefined);
  if (keys.length === 0) return false;
  if (keys.length > 1) {
    throw new Error(`[OrbitID] has() accepts exactly one of ${keys.join(", ")}`);
  }
  if (!context.isSignedIn) return false;
  switch (keys[0]) {
    case "condition":
      return Boolean(params.condition);
    case "reverification":
      return params.reverification
        ? checkReverification(params.reverification, context.factorVerificationAge)
        : false;
    case "role":
      // Custom roles are matched verbatim (`org:admin`, `org:acme:billing`).
      return Boolean(params.role) && context.orgRole === params.role;
    case "permission":
      return Boolean(params.permission) && (context.orgPermissions ?? []).includes(params.permission!);
    case "feature":
      return Boolean(params.feature) && context.features.includes(params.feature!);
    default:
      return false;
  }
}

/** Features from the JWT (`features` / legacy `fea`) or user public metadata. */
export function readFeatures(
  claims: SessionClaims | null,
  userPublicMetadata: Record<string, unknown> | undefined,
): string[] {
  const raw = claims?.features ?? claims?.fea ?? userPublicMetadata?.features;
  if (Array.isArray(raw)) return raw.filter((item): item is string => typeof item === "string");
  if (raw && typeof raw === "object") {
    return Object.entries(raw)
      .filter(([, value]) => Boolean(value))
      .map(([key]) => key);
  }
  return [];
}

const isActiveStatus = (status: string) => status === "active" || status === "pending";

/** `publicUserData` mirrors the wire shape (`user_id`) with camelCase aliases added by the provider. */
function sessionUserId(session: SessionResource | null): string | null {
  return session?.publicUserData?.userId ?? session?.publicUserData?.user_id ?? session?.user?.id ?? null;
}

/**
 * Claims React can build without asking the SDK for a token (used when `getToken` is
 * unavailable, e.g. SSR or offline). The `org_role`/`org_permissions`/`fva` claims are
 * only accurate when decoded from a real token.
 */
export function deriveSessionClaims(
  session: SessionResource | null,
  organization: OrganizationResource | null,
): SessionClaims | null {
  const userId = sessionUserId(session);
  if (!session || !userId) return null;
  return {
    iss: "",
    sub: userId,
    sid: session.id,
    iat: 0,
    nbf: 0,
    exp: 0,
    org_id: organization?.id ?? session.lastActiveOrganizationId ?? undefined,
    org_slug: organization?.slug,
    act: session.actor ?? undefined,
    fva: session.factorVerificationAge ?? undefined,
    sts: session.status === "pending" ? "pending" : "active",
  };
}

export interface AuthStateInput {
  loaded: boolean;
  session: SessionResource | null;
  user: UserResource | null;
  organization: OrganizationResource | null;
  claims: SessionClaims | null;
  initialState?: OrbitIDInitialState;
  instance: OrbitIDInstance | null;
  afterSignOutUrl?: string;
  /** Default `true`. */
  treatPendingAsSignedOut?: boolean;
}

/** Project instance/SSR state into the `useAuth()` shape. */
export function createAuthState(input: AuthStateInput): AuthState {
  const { loaded, session, user, organization, claims, initialState, instance } = input;
  const treatPendingAsSignedOut = input.treatPendingAsSignedOut ?? true;

  const userId = sessionUserId(session) ?? initialState?.userId ?? claims?.sub ?? null;
  const sessionId = session?.id ?? initialState?.sessionId ?? claims?.sid ?? null;
  const sessionStatus: "active" | "pending" | null = session
    ? session.status === "pending"
      ? "pending"
      : isActiveStatus(session.status)
        ? "active"
        : null
    : null;

  const signedIn = session ? isActiveStatus(session.status) : Boolean(userId);
  const isSignedIn = loaded ? signedIn && !(treatPendingAsSignedOut && sessionStatus === "pending") : undefined;

  const orgId =
    claims?.org_id ?? initialState?.orgId ?? organization?.id ?? session?.lastActiveOrganizationId ?? null;
  const orgRole = claims?.org_role ?? initialState?.orgRole ?? null;
  const orgSlug = claims?.org_slug ?? initialState?.orgSlug ?? organization?.slug ?? null;
  const orgPermissions = claims?.org_permissions ?? initialState?.orgPermissions ?? null;
  const actor: Actor | null = claims?.act ?? session?.actor ?? null;

  const hasContext: HasContext = {
    isSignedIn: Boolean(isSignedIn),
    orgRole,
    orgPermissions,
    features: readFeatures(claims, user?.publicMetadata),
    factorVerificationAge: claims?.fva ?? session?.factorVerificationAge ?? null,
  };

  return {
    isLoaded: loaded,
    isSignedIn,
    userId,
    sessionId,
    actor,
    orgId,
    orgRole,
    orgSlug,
    orgPermissions,
    sessionClaims: claims,
    sessionStatus,
    has: (params: HasParams) => checkHas(params, hasContext),
    getToken: (options) => (session ? session.getToken(options) : Promise.resolve(null)),
    signOut: (options?: SignOutParams) => {
      if (!instance) return Promise.resolve();
      return Promise.resolve(
        instance.signOut({ redirectUrl: input.afterSignOutUrl, ...options }),
      ).then(() => undefined);
    },
  };
}

/** Instance state, or the SSR `initialState` projection when the instance has not loaded. */
export function buildSnapshot(
  instance: OrbitIDInstance | null,
  initialState: OrbitIDInitialState | undefined,
): OrbitIDSnapshot {
  if (instance?.loaded) {
    // camelCase aliases on the wire-shaped `publicUserData` (idempotent).
    if (instance.session) withPublicUserDataAliases(instance.session);
    return {
      loaded: true,
      client: instance.client,
      session: instance.session,
      user: instance.user,
      organization: instance.organization,
      environment: instance.environment,
    };
  }
  if (initialState) {
    return {
      loaded: true,
      client: initialState.client ?? null,
      session: initialState.session ?? null,
      user: initialState.user ?? null,
      organization: initialState.organization ?? null,
      environment: null,
    };
  }
  return {
    loaded: false,
    client: instance?.client ?? null,
    session: instance?.session ?? null,
    user: instance?.user ?? null,
    organization: instance?.organization ?? null,
    environment: instance?.environment ?? null,
  };
}
