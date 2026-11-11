import type { ReactNode } from "react";
import type { ReverificationConfig, SessionClaims } from "@orbitid/shared";
import type { Appearance } from "../../appearance/types";
import type { LocalizationResource } from "../../localization/types";
import type { Actor } from "./common";
import type {
  PaginationQuery,
  PaginatedResult,
  UserResource,
  GetTokenOptions,
  SessionResource,
  ClientResource,
} from "./user";
import type { OrganizationResource, CreateApiKeyParams, ApiKeyResource } from "./organization";
import type { EnvironmentResource } from "./environment";
import type { SignInResource, SignUpResource } from "./auth-flow";

// ---------------------------------------------------------------------------
// Instance
// ---------------------------------------------------------------------------

export interface OrbitIDState {
  client: ClientResource | null;
  session: SessionResource | null;
  user: UserResource | null;
  organization: OrganizationResource | null;
}

export interface SetActiveParams {
  session?: string | SessionResource | null;
  organization?: string | OrganizationResource | null;
  beforeEmit?: (state: OrbitIDState) => void | Promise<void>;
  redirectUrl?: string;
}

export interface SignOutParams {
  sessionId?: string;
  redirectUrl?: string;
}

export interface CreateOrganizationParams {
  name: string;
  slug?: string;
}

export interface BuildAuthUrlOptions {
  redirectUrl?: string;
}

export interface RedirectCallbackParams {
  signInForceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
  signInFallbackRedirectUrl?: string;
  signUpFallbackRedirectUrl?: string;
  continueSignInUrl?: string;
  continueSignUpUrl?: string;
  firstFactorUrl?: string;
  secondFactorUrl?: string;
  resetPasswordUrl?: string;
}

/**
 * What `@orbitid/react` needs from `@orbitid/js` (`OrbitID`). Structural on purpose: React
 * and the browser SDK are published together but built independently, so the provider narrows
 * the SDK instance once (see `provider/instance.ts`) and everything downstream depends on this.
 */
export interface OrbitIDInstance {
  loaded: boolean;
  /** Sign-in method completed last, for the "Last used" badge. Never an identifier. */
  lastUsedStrategy?: string | null;
  publishableKey?: string;
  client: ClientResource | null;
  session: SessionResource | null;
  user: UserResource | null;
  organization: OrganizationResource | null;
  environment: EnvironmentResource | null;
  signIn: SignInResource | undefined;
  signUp: SignUpResource | undefined;
  addListener(callback: (state: OrbitIDState) => void): () => void;
  load(options?: { signInUrl?: string; signUpUrl?: string }): Promise<void>;
  setActive(params?: SetActiveParams): Promise<unknown>;
  signOut(params?: SignOutParams): Promise<unknown>;
  createOrganization(params: CreateOrganizationParams): Promise<OrganizationResource>;
  getOrganization(organizationId: string): Promise<OrganizationResource>;
  navigate?(to: string, options?: { replace?: boolean }): void;
  buildSignInUrl?(params?: BuildAuthUrlOptions): string;
  buildSignUpUrl?(params?: BuildAuthUrlOptions): string;
  buildUserProfileUrl?(params?: BuildAuthUrlOptions): string;
  buildOrganizationProfileUrl?(params?: BuildAuthUrlOptions): string;
  buildCreateOrganizationUrl?(): string;
  handleRedirectCallback?(params?: RedirectCallbackParams): Promise<unknown>;
  apiKeys?: {
    list(params?: PaginationQuery): Promise<PaginatedResult<ApiKeyResource>>;
    create(params: CreateApiKeyParams): Promise<ApiKeyResource>;
    revoke(id: string): Promise<void>;
  };
  [key: string]: unknown;
}

export interface OrbitIDOptions {
  domain?: string;
  proxyUrl?: string;
  frontendApi?: string;
  fetch?: typeof globalThis.fetch;
  signInUrl?: string;
  signUpUrl?: string;
  userProfileUrl?: string;
  organizationProfileUrl?: string;
  createOrganizationUrl?: string;
  afterSignOutUrl?: string;
  routerPush?: (to: string) => void | Promise<unknown>;
  routerReplace?: (to: string) => void | Promise<unknown>;
  [key: string]: unknown;
}

/** SSR hydration payload (Next.js `initialState`). */
export interface OrbitIDInitialState {
  sessionClaims?: SessionClaims | null;
  session?: SessionResource | null;
  user?: UserResource | null;
  organization?: OrganizationResource | null;
  client?: ClientResource | null;
  userId?: string | null;
  sessionId?: string | null;
  orgId?: string | null;
  orgRole?: string | null;
  orgSlug?: string | null;
  orgPermissions?: string[] | null;
  roles?: string[];
  rolePermissions?: string[];
}

export interface HasParams {
  role?: string;
  permission?: string;
  feature?: string;
  condition?: boolean;
  reverification?: ReverificationConfig;
}

export interface AuthState {
  isLoaded: boolean;
  /** `undefined` until the instance has loaded. */
  isSignedIn: boolean | undefined;
  userId: string | null;
  sessionId: string | null;
  actor: Actor | null;
  orgId: string | null;
  orgRole: string | null;
  orgSlug: string | null;
  orgPermissions: string[] | null;
  /** Instance roles assigned by an operator, read from session claims. */
  roles: string[];
  rolePermissions: string[];
  sessionClaims: SessionClaims | null;
  sessionStatus: "active" | "pending" | null;
  has(params: HasParams): boolean;
  getToken(options?: GetTokenOptions): Promise<string | null>;
  signOut(options?: SignOutParams): Promise<void>;
}

export interface OrbitIDProviderProps {
  /** Required unless a pre-built `orbit` instance is supplied. */
  publishableKey: string;
  orbit?: OrbitIDInstance;
  initialState?: OrbitIDInitialState;
  appearance?: Appearance;
  /** Dictionary override; `false` keeps `enUS`. */
  localization?: LocalizationResource | false;
  routerPush?: (to: string) => void | Promise<unknown>;
  routerReplace?: (to: string) => void | Promise<unknown>;
  signInUrl?: string;
  signUpUrl?: string;
  userProfileUrl?: string;
  organizationProfileUrl?: string;
  createOrganizationUrl?: string;
  signInFallbackRedirectUrl?: string;
  signUpFallbackRedirectUrl?: string;
  signInForceRedirectUrl?: string;
  signUpForceRedirectUrl?: string;
  afterSignOutUrl?: string;
  allowedRedirectOrigins?: Array<string | RegExp>;
  children?: ReactNode;
}

/** Provider options exposed to components through `OptionsContext`. */
export type OrbitIDOptionsContextValue = Omit<OrbitIDProviderProps, "children" | "orbit"> & {
  /** Present once the instance exists (absent during SSR without `orbit`). */
  instance: OrbitIDInstance | null;
};

export type OrbitIDStatus = "loading" | "ready" | "error";

export interface OrbitIDStatusContextValue {
  status: OrbitIDStatus;
  error: Error | null;
  /** Re-run `load()` after a failure. */
  retry(): void;
}

/** Normalized, always-loaded view of the instance (live state or `initialState`). */
export interface OrbitIDSnapshot extends OrbitIDState {
  environment: EnvironmentResource | null;
  loaded: boolean;
}
