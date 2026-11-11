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
import { isOrbitAPIResponseError } from "./util/errors";
import { inBrowser } from "./util/browser";
import { readLastUsedStrategy } from "./util/last-used-strategy";
import { clearAuthCookies, setClientUatCookie, setSessionCookie, type CookieOptions } from "./util/cookies";
import type { PaginatedResponse, PaginationParams } from "./util/pagination";
import { OrbitIDNavigation } from "./orbit/navigation-base";
import { TokenRefresh } from "./orbit/refresh";
import { AuthCookies } from "./orbit/auth-cookies";
import { isCurrentSession } from "./orbit/session-state";
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
  /** The key this instance was built with: the Frontend API URL is encoded in it. */
  readonly publishableKey: string;
  readonly fapi: FapiClient;
  private readonly tokenCache: TokenCache;
  protected readonly options: OrbitIDOptions;
  private readonly cookieOptions: CookieOptions;
  private readonly listeners = new Set<OrbitIDListener>();
  private readonly organizationCache = new Map<string, Organization>();
  private readonly organizationFetches = new Map<string, Promise<Organization>>();
  private crossTab: CrossTabSync | null = null;
  private readonly tokenRefresh: TokenRefresh;
  private readonly authCookies: AuthCookies;
  private loadPromise: Promise<void> | null = null;
  private refreshPromise: Promise<Client | null> | null = null;
  /** True while a rejected session is being confirmed, so the client response's cookie sync cannot re-enter. */
  private reconciling = false;
  /** Set while the confirmation client fetch runs: its response must not trigger another cookie sync. */
  private skipCookieSync = false;
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
    this.publishableKey = publishableKey;
    this.options = options;
    this.cookieOptions = { domain: options.cookie?.domain, secure: options.cookie?.secure };
    // Build the transport first so the token cache can reject tokens from another issuer.
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
    this.tokenCache = new TokenCache({
      issuer: this.fapi.baseUrl,
      onToken: (info) => this.authCookies.handleToken(info),
    });
    this.tokenRefresh = new TokenRefresh({
      isReady: () => this._loaded && !this.disposed,
      isDisposed: () => this.disposed,
      intervalMs: () => this.options.tokenRefreshIntervalMs,
      tokenExpiry: (sessionId) => this.tokenCache.get(sessionId)?.expiresAt ?? null,
      tokenLifetimeMs: (sessionId) => this.tokenCache.lifetimeMs(sessionId),
      cacheIsFresh: (sessionId) => {
        // Another tab may have written a fresh `__session` cookie while this tab was asleep or waiting
        // for the lock. Adopting it is what keeps N tabs at one mint per cycle without BroadcastChannel.
        this.authCookies.adoptSharedToken(sessionId);
        return this.tokenCache.isFresh(sessionId);
      },
      session: () => this._session,
      isCurrentLiveSession: (session) => isCurrentSession(this._session, session, true),
      acquireLock: () => !this.crossTab || this.crossTab.tryAcquireRefreshLock(),
      releaseLock: () => this.crossTab?.releaseRefreshLock(),
      fetchToken: (session) => session.getToken({ skipCache: true }),
      acceptToken: (session, token) => {
        if (!isCurrentSession(this._session, session, true)) return;
        setSessionCookie(token, this.cookieOptions);
        this.authCookies.writeClientUat();
      },
      reconcileRejected: (session) => this.reconcileRejectedSession(session),
    });
    this.authCookies = new AuthCookies({
      isDisposed: () => this.disposed,
      isInBrowser: () => inBrowser,
      session: () => this._session,
      isCurrentLiveSession: (session) => isCurrentSession(this._session, session, true),
      tokenCache: () => this.tokenCache,
      cookieOptions: () => this.cookieOptions,
      crossTab: () => this.crossTab,
      setCrossTab: (sync) => { this.crossTab = sync; },
      refreshClient: () => this.refreshClient(),
      reconcileRejected: (session) => this.reconcileRejectedSession(session),
      scheduleRefresh: () => this.tokenRefresh.schedule(),
      emit: () => this.emit(),
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
  /** The sign-in method completed most recently, or `null`. Never contains an identifier or other PII. */
  get lastUsedStrategy(): string | null {
    return readLastUsedStrategy();
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
    const previousId = this._session?.id ?? null;
    this._client = Client.fromJSON(this.fapi, raw, this.tokenCache);
    // `lastActiveSessionId` is server-side per client, so a sign-in in another tab would otherwise move this
    // tab to the newly activated account on its next refresh. Keep the session this tab is already using while
    // it is still usable; an explicit `setActive` (or a fresh sign-in, when there is no previous session) still
    // follows the client's pointer.
    const previous = previousId ? this._client.sessions.find((session) => session.id === previousId) : undefined;
    const keep = previous && (previous.status === "active" || previous.status === "pending") ? previous : null;
    this._session = keep ?? this._client.session;
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
    // A response fetched to confirm a rejected session must not start another token mint: that mint is
    // what was just rejected, and syncing here would loop client→sync→confirm→client forever.
    if (!this.skipCookieSync) void this.authCookies.sync();
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
      await Promise.all([this.ensureOrganization(), this.authCookies.sync()]);
      if (this.disposed) return;
      this.loading = false;
      this._loaded = true;
      this.startTokenRefresh();
      this.authCookies.startCrossTab();
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

  /** Refreshes the session JWT now; the loop's tolerance rules live in `orbit/refresh.ts`. */
  private refreshSessionToken(): Promise<void> {
    return this.tokenRefresh.refreshNow();
  }

  private startTokenRefresh(): void {
    this.tokenRefresh.start();
  }

  stopTokenRefresh(): void {
    this.tokenRefresh.stop();
  }

  /**
   * Confirms a rejected token against the authoritative client state. Only a client response that no longer
   * carries an active session clears cookies and local state. Returns true when the session is gone (nothing
   * left to retry), false when the state is still signed in or the confirmation failed transiently.
   */
  private async reconcileRejectedSession(session: Session): Promise<boolean> {
    // A client response applies the session and then syncs cookies, whose own 401 path lands here again.
    // Without both guards the two paths would confirm each other forever.
    if (this.reconciling) return false;
    this.reconciling = true;
    this.skipCookieSync = true;
    try {
      try {
        await this.refreshClient();
      } catch {
        // The confirmation itself failed (offline, 5xx): keep everything and retry on the normal schedule.
        return false;
      }
      if (this.disposed) return true;
      // A pending-MFA session is still live: a rejected mint is not a sign-out, exactly like an active one.
      if (this._session?.status === "active" || this._session?.status === "pending") return false;
      // The server confirmed the session is gone: cancel any in-flight token request for it before clearing.
      this.tokenCache.removeSession(session.id);
      this._session = null;
      this._user = null;
      this._organization = null;
      clearAuthCookies(this.cookieOptions);
      this.crossTab?.broadcast({ type: "signout" });
      this.stopTokenRefresh();
      this.emit();
      return true;
    } finally {
      this.reconciling = false;
      this.skipCookieSync = false;
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
      this.stopTokenRefresh();
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
    await this.authCookies.sync();
    // A newly activated session has its own token deadline; restart the schedule and clear the failure backoff.
    // `start()` also re-binds the resume listeners after a previous sign-out stopped the loop.
    this.tokenRefresh.reset();
    this.tokenRefresh.start();

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
      this.stopTokenRefresh();
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
