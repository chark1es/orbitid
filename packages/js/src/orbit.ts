import type { ClientJSON, EnvironmentJSON, OrganizationJSON } from "@orbitid/shared";
import { FapiClient, SDK_VERSION } from "./fapi";
import { TokenCache } from "./token-cache";
import { CrossTabSync, type SyncMessage } from "./cross-tab-sync";
import { Client } from "./resources/client";
import { Environment } from "./resources/environment";
import { SignIn, type EmailLinkFlowOptions, type EmailLinkFlow } from "./resources/sign-in";
import { SignUp } from "./resources/sign-up";
import { User } from "./resources/user";
import { Organization } from "./resources/organization";
import { Session } from "./resources/session";
import { ApiKey, type CreateApiKeyParams } from "./resources/api-key";
import { unwrap } from "./resources/base";
import { inBrowser } from "./util/browser";
import { clearAuthCookies, setClientUatCookie, setSessionCookie, type CookieOptions } from "./util/cookies";
import type { PaginatedResponse, PaginationParams } from "./util/pagination";
import { OrbitIDNavigation } from "./orbit/navigation-base";
import { handleRedirectCallback as runRedirectCallback } from "./orbit/redirect-callback";
import type {
  HandleRedirectCallbackParams,
  HandleRedirectCallbackResult,
  OrbitIDListener,
  OrbitIDOptions,
  OrbitIDState,
  SetActiveParams,
  SetActiveResult,
} from "./orbit/types";

export type {
  HandleRedirectCallbackParams,
  HandleRedirectCallbackResult,
  OrbitIDListener,
  OrbitIDNavigateOptions,
  OrbitIDOptions,
  OrbitIDState,
  RouterFn,
  SetActiveParams,
  SetActiveResult,
} from "./orbit/types";

/**
 * Framework-agnostic OrbitID client.
 * All state updates flow through the `{ response, client }` envelope: every response carrying `client`
 * rebuilds resources and notifies listeners, so React consumers always observe fresh references.
 */
export class OrbitID extends OrbitIDNavigation {
  static readonly version = SDK_VERSION;
  readonly version = SDK_VERSION;
  readonly fapi: FapiClient;
  private readonly tokenCache: TokenCache;
  protected readonly options: OrbitIDOptions;
  private readonly cookieOptions: CookieOptions;
  private readonly listeners = new Set<OrbitIDListener>();
  private readonly organizationCache = new Map<string, Organization>();
  private readonly organizationFetches = new Map<string, Promise<Organization>>();
  private crossTab: CrossTabSync | null = null;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private loadPromise: Promise<void> | null = null;
  private refreshPromise: Promise<Client | null> | null = null;

  private _client: Client | null = null;
  private _session: Session | null = null;
  private _user: User | null = null;
  private _organization: Organization | null = null;
  private _environment: Environment | null = null;
  private _loaded = false;
  private loading = false;
  private disposed = false;

  constructor(publishableKey: string, options: OrbitIDOptions = {}) {
    super();
    this.options = options;
    this.cookieOptions = { domain: options.cookie?.domain, secure: options.cookie?.secure };
    this.tokenCache = new TokenCache({
      onToken: (info) => this.handleToken(info),
    });
    this.fapi = new FapiClient({
      publishableKey,
      domain: options.domain,
      proxyUrl: options.proxyUrl,
      frontendApi: options.frontendApi,
      fetch: options.fetch,
      retry: options.retry,
      onClient: (client) => this.handleClient(client),
      navigate: (url, navigateOptions) => this.navigate(url, navigateOptions),
    });
  }

  get loaded(): boolean {
    return this._loaded;
  }
  get client(): Client | null {
    return this._client;
  }
  get session(): Session | null {
    return this._session;
  }
  get user(): User | null {
    return this._user;
  }
  get organization(): Organization | null {
    return this._organization;
  }
  get environment(): Environment | null {
    return this._environment;
  }
  get isSignedIn(): boolean {
    return !!this._session && this._session.status === "active";
  }
  get afterSignOutUrl(): string | undefined {
    return this.options.afterSignOutUrl;
  }
  get state(): OrbitIDState {
    return { client: this._client, session: this._session, user: this._user, organization: this._organization };
  }

  /** In-progress (or previously created) sign-in; always a usable resource so `create()` works. */
  get signIn(): SignIn {
    return this._client?.signIn ?? new SignIn(this.fapi, null);
  }
  get signUp(): SignUp {
    return this._client?.signUp ?? new SignUp(this.fapi, null);
  }

  /** Self-service API keys for the signed-in user. */
  get apiKeys(): {
    list: (params?: PaginationParams) => Promise<PaginatedResponse<ApiKey>>;
    create: (params: CreateApiKeyParams) => Promise<ApiKey>;
    revoke: (id: string) => Promise<void>;
  } {
    return {
      list: (params = {}) => ApiKey.list(this.fapi, params),
      create: (params) => ApiKey.create(this.fapi, params),
      revoke: (id) => ApiKey.revoke(this.fapi, id),
    };
  }

  addListener(listener: OrbitIDListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Alias for `addListener`. */
  on = this.addListener;

  private emit(): void {
    if (this.disposed || !this.listeners.size) return;
    const state = this.state;
    for (const listener of [...this.listeners]) {
      try {
        listener(state);
      } catch {
        /* a throwing listener must not break the SDK */
      }
    }
  }

  private applyClient(raw: ClientJSON): void {
    this._client = Client.fromJSON(this.fapi, raw, this.tokenCache);
    this._session = this._client.session;
    this._user = this._session?.user ?? null;
    const organizationId = this._session?.lastActiveOrganizationId ?? null;
    // Signing out (or switching to a session with no organization) must not leave the previous
    // organization's members and metadata reachable through this instance.
    if (!organizationId) this.organizationCache.clear();
    this._organization = organizationId ? (this.organizationCache.get(organizationId) ?? null) : null;
  }

  private handleClient(raw: ClientJSON): void {
    // A response that lands after `dispose()` must not repopulate a torn-down instance.
    if (this.disposed) return;
    this.applyClient(raw);
    if (this.loading || !this._loaded) return;
    if (this._session?.lastActiveOrganizationId && !this._organization) void this.ensureOrganization();
    void this.syncAuthCookies();
    this.emit();
  }

  /** Loads `GET /v1/client` + `/v1/client/environment`, starts the refresh timer and writes cookies. */
  async load(_options?: { signInUrl?: string; signUpUrl?: string }): Promise<void> {
    if (this.disposed) throw new Error("This OrbitID instance has been disposed");
    if (this._loaded) return;
    if (this.loadPromise) return this.loadPromise;
    this.loading = true;
    this.loadPromise = (async () => {
      const [clientRaw, environmentRaw] = await Promise.all([
        this.fapi.get<unknown>("/v1/client"),
        this.fapi.get<unknown>("/v1/client/environment"),
      ]);
      // `dispose()` may have run while these requests were in flight: do not resurrect state or timers.
      if (this.disposed) return;
      this._environment = Environment.fromJSON(unwrap<EnvironmentJSON>(environmentRaw).data);
      this.applyClient(unwrap<ClientJSON>(clientRaw).data);
      // The organization fetch and the first token mint only depend on the client, not on each other: run them
      // together so a signed-in visit does not pay for two sequential round trips before first paint.
      await Promise.all([this.ensureOrganization(), this.syncAuthCookies()]);
      if (this.disposed) return;
      this.loading = false;
      this._loaded = true;
      this.startTokenRefresh();
      this.startCrossTabSync();
      this.emit();
    })().catch((error: unknown) => {
      this.loading = false;
      this.loadPromise = null;
      this._loaded = false;
      throw error;
    });
    return this.loadPromise;
  }

  /** Re-fetches the client (after redirects, cross-tab sign-out, etc.). Concurrent callers share one request. */
  async refreshClient(): Promise<Client | null> {
    // A disposed instance must not issue requests: `signOut()` calls this in its `finally`, and a torn-down
    // client that still hits `/v1/client` re-creates state the caller just dropped.
    if (this.disposed) return this._client;
    // A sign-out broadcast, a `setActive` and a redirect callback can all fire together; one request answers all.
    if (this.refreshPromise) return this.refreshPromise;
    this.refreshPromise = (async () => {
      const raw = await this.fapi.get<unknown>("/v1/client");
      if (this.disposed) return this._client;
      this.applyClient(unwrap<ClientJSON>(raw).data);
      await this.ensureOrganization();
      return this._client;
    })().finally(() => {
      this.refreshPromise = null;
    });
    return this.refreshPromise;
  }

  private async ensureOrganization(): Promise<void> {
    const organizationId = this._session?.lastActiveOrganizationId;
    if (!organizationId || this.organizationCache.has(organizationId)) {
      this._organization = organizationId ? (this.organizationCache.get(organizationId) ?? null) : null;
      return;
    }
    try {
      const organization = await this.getOrganization(organizationId);
      if (this._session?.lastActiveOrganizationId === organizationId) this._organization = organization;
    } catch {
      this._organization = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Tokens & cookies
  // ---------------------------------------------------------------------------

  private handleToken(info: { sessionId: string; template: string | null; token: string; expiresAt: number }): void {
    // A token fetch can resolve after `dispose()`; it must not write cookies or broadcast from a dead instance.
    if (this.disposed) return;
    if (this._session?.id !== info.sessionId) return;
    if (!info.template) setSessionCookie(info.token, this.cookieOptions);
    this.writeClientUat();
    // Template tokens are least-privilege credentials for another service; a tab that wants one can mint
    // its own. Only the default session token — the one every tab of this app already holds — is shared.
    if (!info.template) {
      this.crossTab?.broadcast({ type: "token", sessionId: info.sessionId, template: null, token: info.token });
    }
  }

  private writeClientUat(): void {
    const seconds = this._session?.lastActiveAt ? Math.floor(this._session.lastActiveAt / 1000) : Math.floor(Date.now() / 1000);
    setClientUatCookie(this._session ? seconds : 0, this.cookieOptions);
  }

  private async syncAuthCookies(): Promise<void> {
    if (this.disposed) return;
    if (!this._session || this._session.status !== "active") {
      clearAuthCookies(this.cookieOptions);
      return;
    }
    // `__client_uat` first: middleware uses it to decide whether a handshake can refresh a missing
    // `__session`, so a token request that fails must not leave the browser looking signed out.
    this.writeClientUat();
    const session = this._session;
    try {
      const token = await session.getToken();
      // The user may have signed out, switched session, or torn the instance down while the request was in flight.
      if (!this.disposed && this.isCurrentActiveSession(session)) setSessionCookie(token, this.cookieOptions);
    } catch {
      /* leave the existing `__session` untouched: the next refresh retries */
    }
  }

  /** True while `session` is still the active session of this instance. */
  private isCurrentActiveSession(session: Session): boolean {
    return this._session === session && session.status === "active";
  }

  private startTokenRefresh(): void {
    if (this.refreshTimer || typeof setInterval === "undefined") return;
    const interval = this.options.tokenRefreshIntervalMs ?? 50_000;
    this.refreshTimer = setInterval(() => {
      void this.refreshSessionToken();
    }, interval);
  }

  private async refreshSessionToken(): Promise<void> {
    const session = this._session;
    if (!session || session.status !== "active") return;
    try {
      const token = await session.getToken({ skipCache: true });
      // A response that lands after sign-out or a session switch must not bring the old session back.
      if (!this.isCurrentActiveSession(session)) return;
      setSessionCookie(token, this.cookieOptions);
      this.writeClientUat();
    } catch {
      /* offline: the next tick retries */
    }
  }

  stopTokenRefresh(): void {
    if (this.refreshTimer) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private startCrossTabSync(): void {
    if (this.crossTab || this.disposed || !inBrowser) return;
    this.crossTab = new CrossTabSync((message) => {
      if (this.disposed) return;
      this.handleSyncMessage(message);
    });
  }

  private handleSyncMessage(message: SyncMessage): void {
    switch (message.type) {
      case "token":
        if (!this.tokenCache.setFromSync(message.sessionId, message.template, message.token)) return;
        if (!message.template && this._session?.id === message.sessionId) setSessionCookie(message.token, this.cookieOptions);
        return;
      case "signout":
        this.tokenCache.clear();
        clearAuthCookies(this.cookieOptions);
        void this.refreshClient().catch(() => undefined);
        return;
      case "refresh-client":
        void this.refreshClient().catch(() => undefined);
        return;
    }
  }

  // ---------------------------------------------------------------------------
  // Session lifecycle
  // ---------------------------------------------------------------------------

  async setActive(params: SetActiveParams = {}): Promise<SetActiveResult> {
    const { session, organization, beforeEmit, redirectUrl } = params;
    if (session === null) {
      this._session = null;
      this._user = null;
      this._organization = null;
      clearAuthCookies(this.cookieOptions);
      this.emit();
      if (redirectUrl) this.navigate(redirectUrl, { replace: true });
      return { session: null };
    }

    const target =
      typeof session === "object"
        ? session
        : typeof session === "string"
          ? (this._client?.sessions.find((candidate) => candidate.id === session) ?? null)
          : this._session;
    if (!target) throw new Error("setActive requires a session");

    const organizationId =
      organization === undefined ? undefined : organization === null ? null : typeof organization === "string" ? organization : organization.id;

    await target.touch(organizationId === undefined ? {} : { activeOrganizationId: organizationId });
    if (organization && typeof organization === "object") this.organizationCache.set(organization.id, organization);

    this._session = this._client?.sessions.find((candidate) => candidate.id === target.id) ?? target;
    this._user = this._session.user ?? this._user;
    await this.ensureOrganization();
    if (!this._organization && organization && typeof organization === "object") this._organization = organization;
    await this.syncAuthCookies();

    await beforeEmit?.(this.state);
    this.emit();
    this.crossTab?.broadcast({ type: "refresh-client" });
    if (redirectUrl) this.navigate(redirectUrl, { replace: true });
    return { session: this._session };
  }

  async signOut(params: { sessionId?: string; redirectUrl?: string } = {}): Promise<this> {
    const sessionId = params.sessionId ?? this._session?.id;
    try {
      if (sessionId) await this.fapi.post(`/v1/client/sessions/${sessionId}/remove`);
      else await this.fapi.del("/v1/client");
    } finally {
      if (sessionId) this.tokenCache.removeSession(sessionId);
      else this.tokenCache.clear();
      this._session = null;
      this._user = null;
      this._organization = null;
      clearAuthCookies(this.cookieOptions);
      this.crossTab?.broadcast({ type: "signout" });
      try {
        await this.refreshClient();
      } catch {
        /* offline sign-out still clears local state */
      }
      this.emit();
    }
    const target = params.redirectUrl ?? this.options.afterSignOutUrl;
    if (target) this.navigate(target, { replace: true });
    return this;
  }

  // ---------------------------------------------------------------------------
  // Organizations
  // ---------------------------------------------------------------------------

  async createOrganization(params: { name: string; slug?: string }): Promise<Organization> {
    const raw = await this.fapi.post<unknown>("/v1/client/organizations", { body: { name: params.name, slug: params.slug } });
    const organization = Organization.fromJSON(this.fapi, unwrap<OrganizationJSON>(raw).data);
    this.organizationCache.set(organization.id, organization);
    return organization;
  }

  async getOrganization(organizationId: string): Promise<Organization> {
    const cached = this.organizationCache.get(organizationId);
    if (cached) return cached;
    const pending = this.organizationFetches.get(organizationId);
    if (pending) return pending;
    const request = (async () => {
      const raw = await this.fapi.get<unknown>(`/v1/client/organizations/${organizationId}`);
      const organization = Organization.fromJSON(this.fapi, unwrap<OrganizationJSON>(raw).data);
      // A fetch that lands after `dispose()` must not repopulate the cache the teardown just cleared.
      if (!this.disposed) this.organizationCache.set(organization.id, organization);
      return organization;
    })().finally(() => this.organizationFetches.delete(organizationId));
    this.organizationFetches.set(organizationId, request);
    return request;
  }

  async handleRedirectCallback(params: HandleRedirectCallbackParams = {}): Promise<HandleRedirectCallbackResult> {
    return runRedirectCallback(
      {
        options: this.options,
        client: () => this._client,
        signUp: () => this.signUp,
        refreshClient: () => this.refreshClient(),
        setActive: (activeParams) => this.setActive(activeParams),
        navigate: (to, navOptions) => this.navigate(to, navOptions),
      },
      params,
    );
  }

  /** Stops the refresh timer and cross-tab channel (for tests and client-side teardown). */
  dispose(): void {
    this.disposed = true;
    this.stopTokenRefresh();
    this.crossTab?.close();
    this.crossTab = null;
    this.loadPromise = null;
    this.refreshPromise = null;
    this.organizationFetches.clear();
    this.organizationCache.clear();
    this.tokenCache.clear();
    this.listeners.clear();
  }

  /** Returns the email-link flow helper for the pending sign-in. */
  createSignInEmailLinkFlow(options?: EmailLinkFlowOptions): EmailLinkFlow {
    return this.signIn.createEmailLinkFlow(options);
  }
}
