import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";
import { OrbitIDProvider } from "../provider/OrbitIDProvider";
import type {
  ClientResource,
  EnvironmentResource,
  OrbitIDInstance,
  OrbitIDProviderProps,
  OrbitIDState,
  OrganizationMembershipResource,
  OrganizationResource,
  RedirectCallbackParams,
  SessionClaims,
  SessionResource,
  SetActiveParams,
  SignInResource,
  SignOutParams,
  SignUpResource,
  UserResource,
} from "../provider/types";

export const PK = "pk_test_ZXhhbXBsZS5jb20";

/** JWT with a readable payload — `decodeJwt` only needs the middle segment. */
export function makeJwt(claims: Record<string, unknown>): string {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value)).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
  return `${encode({ alg: "RS256", typ: "JWT" })}.${encode(claims)}.signature`;
}

export const sessionClaims = (overrides: Partial<SessionClaims> = {}): SessionClaims => ({
  iss: "https://auth.example.com",
  sub: "user_1",
  sid: "sess_1",
  iat: 0,
  nbf: 0,
  exp: 0,
  ...overrides,
});

export const fakeSession = (overrides: Partial<SessionResource> = {}): SessionResource =>
  ({
    id: "sess_1",
    status: "active",
    publicUserData: { user_id: "user_1", identifier: "ada@example.com" },
    getToken: async () => makeJwt(sessionClaims()),
    ...overrides,
  }) as unknown as SessionResource;

export const fakeUser = (
  overrides: Partial<UserResource> = {},
  memberships: OrganizationMembershipResource[] = [],
): UserResource =>
  ({
    id: "user_1",
    firstName: "Ada",
    lastName: "Lovelace",
    fullName: "Ada Lovelace",
    primaryEmailAddress: { id: "idn_e1", emailAddress: "ada@example.com" },
    emailAddresses: [{ id: "idn_e1", emailAddress: "ada@example.com" }],
    phoneNumbers: [],
    externalAccounts: [],
    passkeys: [],
    publicMetadata: {},
    getOrganizationMemberships: async ({ limit = 100, offset = 0 } = {}) => ({
      data: memberships.slice(offset, offset + limit),
      totalCount: memberships.length,
    }),
    getOrganizationInvitations: async () => [],
    getOrganizationSuggestions: async () => [],
    ...overrides,
  }) as unknown as UserResource;

export const fakeMembership = (
  overrides: Partial<OrganizationMembershipResource> = {},
): OrganizationMembershipResource =>
  ({
    id: "orgmem_1",
    role: "org:admin",
    roleName: "Admin",
    permissions: ["org:sys_memberships:manage"],
    organization: fakeOrganization(),
    publicUserData: { user_id: "user_1", identifier: "ada@example.com" },
    update: async function update(this: OrganizationMembershipResource) {
      return this;
    },
    destroy: async () => {},
    ...overrides,
  }) as unknown as OrganizationMembershipResource;

export const fakeOrganization = (
  init: {
    id?: string;
    name?: string;
    slug?: string;
    memberships?: OrganizationMembershipResource[];
    domains?: unknown[];
    invitations?: unknown[];
    membershipRequests?: unknown[];
  } = {},
): OrganizationResource =>
  ({
    id: init.id ?? "org_1",
    name: init.name ?? "Acme",
    slug: init.slug ?? "acme",
    imageUrl: "",
    hasImage: false,
    getMemberships: async ({ limit = 10, offset = 0 } = {}) => {
      const rows = init.memberships ?? [];
      return { data: rows.slice(offset, offset + limit), totalCount: rows.length };
    },
    getInvitations: async () => (init.invitations ?? []) as never[],
    getDomains: async () => (init.domains ?? []) as never[],
    getMembershipRequests: async () => (init.membershipRequests ?? []) as never[],
    getRoles: async () => [],
    update: async function update(this: OrganizationResource) {
      return this;
    },
    destroy: async () => {},
    setLogo: async function setLogo(this: OrganizationResource) {
      return this;
    },
    removeLogo: async function removeLogo(this: OrganizationResource) {
      return this;
    },
    addMember: async () => fakeMembership(),
    inviteMember: async () => ({}) as never,
    inviteMembers: async () => [],
    createDomain: async () => ({}) as never,
    requestMembership: async () => ({}) as never,
  }) as unknown as OrganizationResource;

export const fakeSignIn = (overrides: Partial<SignInResource> = {}): SignInResource =>
  ({
    id: "sia_1",
    status: "needs_identifier",
    create: async function create(this: SignInResource) {
      return this;
    },
    reload: async function reload(this: SignInResource) {
      return this;
    },
    prepareFirstFactor: async function prepare(this: SignInResource) {
      return this;
    },
    attemptFirstFactor: async function attempt(this: SignInResource) {
      return this;
    },
    prepareSecondFactor: async function prepare(this: SignInResource) {
      return this;
    },
    attemptSecondFactor: async function attempt(this: SignInResource) {
      return this;
    },
    resetPassword: async function reset(this: SignInResource) {
      return this;
    },
    authenticateWithRedirect: async function redirect(this: SignInResource) {
      return this;
    },
    ...overrides,
  }) as unknown as SignInResource;

export const fakeSignUp = (overrides: Partial<SignUpResource> = {}): SignUpResource =>
  ({
    id: "sua_1",
    status: "missing_requirements",
    missingFields: ["email_address"],
    create: async function create(this: SignUpResource) {
      return this;
    },
    update: async function update(this: SignUpResource) {
      return this;
    },
    reload: async function reload(this: SignUpResource) {
      return this;
    },
    prepareVerification: async function prepare(this: SignUpResource) {
      return this;
    },
    attemptVerification: async function attempt(this: SignUpResource) {
      return this;
    },
    prepareEmailAddressVerification: async function prepare(this: SignUpResource) {
      return this;
    },
    attemptEmailAddressVerification: async function attempt(this: SignUpResource) {
      return this;
    },
    preparePhoneNumberVerification: async function prepare(this: SignUpResource) {
      return this;
    },
    attemptPhoneNumberVerification: async function attempt(this: SignUpResource) {
      return this;
    },
    authenticateWithRedirect: async function redirect(this: SignUpResource) {
      return this;
    },
    ...overrides,
  }) as unknown as SignUpResource;

export const fakeEnvironment = (): EnvironmentResource => ({
  authConfig: {
    identificationRequirements: [["email_address"]],
    firstFactors: ["password", "email_code"],
    secondFactors: ["totp"],
    singleSessionMode: true,
    signUpMode: "public",
    legalConsentRequired: false,
  },
  userSettings: {
    attributes: {
      emailAddress: {
        enabled: true,
        required: true,
        usedForFirstFactor: true,
        usedForSecondFactor: false,
        verifications: ["email_code"],
        verifyAtSignUp: true,
      },
    },
    social: {},
    passwordSettings: {
      minLength: 8,
      maxLength: 72,
      requireLowercase: false,
      requireUppercase: false,
      requireNumbers: false,
      requireSpecialChar: false,
    },
    usernameSettings: { minLength: 4, maxLength: 64 },
    signUp: { mode: "public", progressive: true },
    actions: { deleteSelf: true, createOrganization: true },
    passkeySettings: { allowAutofill: false, showSignInButton: false },
  },
  organizationSettings: {
    enabled: true,
    maxAllowedMemberships: 5,
    creationEnabled: true,
    domainsEnabled: true,
    membershipRequestsEnabled: true,
    slugEnabled: true,
    forceOrganizationSelection: false,
    creatorRole: "org:admin",
    defaultRole: "org:member",
  },
  displayConfig: {
    applicationName: "OrbitID App",
    logoImageUrl: null,
    homeUrl: "/",
    supportEmail: null,
    termsUrl: null,
    privacyUrl: null,
    primaryColor: "#6366f1",
    theme: "system",
    branded: false,
    captchaEnabled: false,
    captchaProvider: "none",
    captchaSiteKey: "",
  },
});

export interface FakeInit {
  loaded?: boolean;
  client?: ClientResource | null;
  session?: SessionResource | null;
  user?: UserResource | null;
  organization?: OrganizationResource | null;
  environment?: EnvironmentResource | null;
}

export type FakeInstance = FakeOrbitID & OrbitIDInstance;

export class FakeOrbitID {
  loaded = false;
  publishableKey = PK;
  client: ClientResource | null = null;
  session: SessionResource | null = null;
  user: UserResource | null = null;
  organization: OrganizationResource | null = null;
  environment: EnvironmentResource | null = fakeEnvironment();
  signIn: SignInResource | undefined = fakeSignIn();
  signUp: SignUpResource | undefined = fakeSignUp();

  loadCalls = 0;
  loadError: Error | null = null;
  signOutCalls: SignOutParams[] = [];
  setActiveCalls: SetActiveParams[] = [];
  createOrganizationCalls: Array<{ name: string; slug?: string }> = [];
  navigations: Array<{ to: string; options?: { replace?: boolean } }> = [];
  redirectCallbackCalls: RedirectCallbackParams[] = [];
  buildSignInUrlCalls: Array<{ redirectUrl?: string } | undefined> = [];

  private readonly listeners = new Set<(state: OrbitIDState) => void>();

  constructor(init: FakeInit = {}) {
    this.loaded = init.loaded ?? false;
    this.session = init.session ?? null;
    this.client =
      init.client ??
      (init.session
        ? { id: "client_1", sessions: [init.session], lastActiveSessionId: init.session.id }
        : null);
    this.user = init.user ?? null;
    this.organization = init.organization ?? null;
    if (init.environment) this.environment = init.environment;
  }

  get state(): OrbitIDState {
    return {
      client: this.client,
      session: this.session,
      user: this.user,
      organization: this.organization,
    };
  }

  addListener(callback: (state: OrbitIDState) => void): () => void {
    this.listeners.add(callback);
    return () => {
      this.listeners.delete(callback);
    };
  }

  listenerCount(): number {
    return this.listeners.size;
  }

  emit(): void {
    const state = this.state;
    this.listeners.forEach((listener) => listener(state));
  }

  async load(): Promise<void> {
    this.loadCalls += 1;
    if (this.loadError) throw this.loadError;
    this.loaded = true;
    this.emit();
  }

  async setActive(params?: SetActiveParams): Promise<unknown> {
    this.setActiveCalls.push(params ?? {});
    return {};
  }

  async signOut(params?: SignOutParams): Promise<unknown> {
    this.signOutCalls.push(params ?? {});
    this.session = null;
    this.user = null;
    this.emit();
    return this;
  }

  async createOrganization(params: { name: string; slug?: string }): Promise<OrganizationResource> {
    this.createOrganizationCalls.push(params);
    return fakeOrganization({ id: "org_new", name: params.name, slug: params.slug ?? "new" });
  }

  async getOrganization(organizationId: string): Promise<OrganizationResource> {
    return fakeOrganization({ id: organizationId });
  }

  navigate(to: string, options?: { replace?: boolean }): void {
    this.navigations.push({ to, options });
  }

  buildSignInUrl(params?: { redirectUrl?: string }): string {
    this.buildSignInUrlCalls.push(params);
    return params?.redirectUrl
      ? `/sign-in?redirect_url=${encodeURIComponent(params.redirectUrl)}`
      : "/sign-in";
  }

  buildSignUpUrl(params?: { redirectUrl?: string }): string {
    return params?.redirectUrl ? `/sign-up?redirect_url=${encodeURIComponent(params.redirectUrl)}` : "/sign-up";
  }

  buildUserProfileUrl(): string {
    return "/user-profile";
  }

  buildOrganizationProfileUrl(): string {
    return "/organization-profile";
  }

  buildCreateOrganizationUrl(): string {
    return "/create-organization";
  }

  async handleRedirectCallback(params?: RedirectCallbackParams): Promise<unknown> {
    this.redirectCallbackCalls.push(params ?? {});
    return {};
  }

  /** Test helper: sign in / switch session. */
  setAuth(session: SessionResource | null, user: UserResource | null): void {
    this.session = session;
    this.user = user;
    this.client = {
      id: "client_1",
      sessions: session ? [session] : [],
      lastActiveSessionId: session?.id ?? null,
    };
    this.emit();
  }

  setOrganization(organization: OrganizationResource | null): void {
    this.organization = organization;
    this.emit();
  }
}

export function createFakeOrbitID(init: FakeInit = {}): FakeInstance {
  return new FakeOrbitID(init) as unknown as FakeInstance;
}

export interface RenderWithProviderOptions {
  instance?: FakeInstance;
  providerProps?: Partial<OrbitIDProviderProps>;
}

export function renderWithProvider(
  ui: ReactNode,
  options: RenderWithProviderOptions = {},
): RenderResult & { instance: FakeInstance } {
  const instance = options.instance ?? createFakeOrbitID({ loaded: true });
  const result = render(
    <OrbitIDProvider publishableKey={PK} orbit={instance} {...options.providerProps}>
      {ui}
    </OrbitIDProvider>,
  );
  return { ...result, instance };
}
