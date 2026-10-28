import type { SessionJSON, SessionStatus, VerificationJSON } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { fetchData, unwrap } from "./base";
import { TokenCache } from "../token-cache";
import { decodeJwtPayload } from "../util/jwt";
import { User } from "./user";
import { createHasCheck, type HasCheckParams } from "../util/reverification";

export interface GetTokenOptions {
  template?: string;
  skipCache?: boolean;
}

export class SessionVerification {
  status: VerificationJSON["status"];
  strategy: string;
  attempts: number | null;
  expireAt: number | null;
  nonce: string | null;

  constructor(
    private readonly fapi: FapiClient,
    private readonly sessionId: string,
    json: VerificationJSON,
  ) {
    this.status = json.status;
    this.strategy = json.strategy;
    this.attempts = json.attempts ?? null;
    this.expireAt = json.expire_at ?? null;
    this.nonce = json.nonce ?? null;
  }

  static fromJSON(fapi: FapiClient, sessionId: string, json: VerificationJSON): SessionVerification {
    return new SessionVerification(fapi, sessionId, json);
  }

  private update(json: VerificationJSON): this {
    this.status = json.status;
    this.strategy = json.strategy;
    this.attempts = json.attempts ?? null;
    this.expireAt = json.expire_at ?? null;
    this.nonce = json.nonce ?? null;
    return this;
  }

  async prepareFirstFactor(params: { strategy: string }): Promise<this> {
    const json = await fetchData<VerificationJSON>(this.fapi, "POST", `/v1/client/sessions/${this.sessionId}/verify/prepare_first_factor`, {
      body: { strategy: params.strategy },
    });
    return this.update(json);
  }

  async attemptFirstFactor(params: { strategy: string; code?: string; password?: string; signature?: string }): Promise<this> {
    const json = await fetchData<VerificationJSON>(this.fapi, "POST", `/v1/client/sessions/${this.sessionId}/verify/attempt_first_factor`, {
      body: { strategy: params.strategy, code: params.code, password: params.password, signature: params.signature },
    });
    return this.update(json);
  }

  async prepareSecondFactor(params: { strategy: string; phoneNumberId?: string }): Promise<this> {
    const json = await fetchData<VerificationJSON>(this.fapi, "POST", `/v1/client/sessions/${this.sessionId}/verify/prepare_second_factor`, {
      body: { strategy: params.strategy, phone_number_id: params.phoneNumberId },
    });
    return this.update(json);
  }

  async attemptSecondFactor(params: { strategy: string; code: string }): Promise<this> {
    const json = await fetchData<VerificationJSON>(this.fapi, "POST", `/v1/client/sessions/${this.sessionId}/verify/attempt_second_factor`, {
      body: { strategy: params.strategy, code: params.code },
    });
    return this.update(json);
  }
}

export interface SessionPublicUserData {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string;
  hasImage: boolean;
  identifier: string;
}

export interface SessionActivity {
  id: string;
  isMobile: boolean;
  ipAddress: string;
  city: string | null;
  country: string | null;
  browserName: string;
  browserVersion: string;
  deviceType: string;
}

function mapPublicUserData(data: SessionJSON["public_user_data"]): SessionPublicUserData | null {
  if (!data) return null;
  return {
    userId: data.user_id,
    firstName: data.first_name,
    lastName: data.last_name,
    imageUrl: data.image_url,
    hasImage: data.has_image,
    identifier: data.identifier,
  };
}

function mapActivity(data: SessionJSON["latest_activity"]): SessionActivity | null {
  if (!data) return null;
  return {
    id: data.id,
    isMobile: data.is_mobile,
    ipAddress: data.ip_address,
    city: data.city,
    country: data.country,
    browserName: data.browser_name,
    browserVersion: data.browser_version,
    deviceType: data.device_type,
  };
}

export class Session {
  readonly object = "session" as const;
  id: string;
  status: SessionStatus;
  expireAt: number;
  abandonAt: number;
  lastActiveAt: number;
  lastActiveOrganizationId: string | null;
  actor: SessionJSON["actor"];
  user: User | null;
  publicUserData: SessionPublicUserData | null;
  factorVerificationAge: [number, number] | null;
  lastActiveToken: { object: "token"; jwt: string } | null;
  latestActivity: SessionActivity | null;
  createdAt: number;
  updatedAt: number;
  verification: VerificationJSON | null;
  private readonly tokenCache: TokenCache;

  constructor(
    private readonly fapi: FapiClient,
    json: SessionJSON,
    tokenCache?: TokenCache,
  ) {
    this.tokenCache = tokenCache ?? new TokenCache();
    this.id = json.id;
    this.status = json.status;
    this.expireAt = json.expire_at;
    this.abandonAt = json.abandon_at;
    this.lastActiveAt = json.last_active_at;
    this.lastActiveOrganizationId = json.last_active_organization_id;
    this.actor = json.actor;
    this.user = json.user ? User.fromJSON(fapi, json.user, this.tokenCache) : null;
    this.publicUserData = mapPublicUserData(json.public_user_data);
    this.factorVerificationAge = json.factor_verification_age;
    this.lastActiveToken = json.last_active_token;
    this.latestActivity = mapActivity(json.latest_activity);
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
    this.verification = null;
  }

  static fromJSON(fapi: FapiClient, json: SessionJSON, tokenCache?: TokenCache): Session {
    return new Session(fapi, json, tokenCache);
  }

  get isActive(): boolean {
    return this.status === "active" && this.expireAt > Date.now();
  }

  get isExpired(): boolean {
    return this.expireAt <= Date.now();
  }

  private update(json: SessionJSON): this {
    this.status = json.status;
    this.expireAt = json.expire_at;
    this.abandonAt = json.abandon_at;
    this.lastActiveAt = json.last_active_at;
    this.lastActiveOrganizationId = json.last_active_organization_id;
    this.actor = json.actor;
    if (json.user) this.user = User.fromJSON(this.fapi, json.user, this.tokenCache);
    this.publicUserData = mapPublicUserData(json.public_user_data) ?? this.publicUserData;
    this.factorVerificationAge = json.factor_verification_age ?? this.factorVerificationAge;
    this.lastActiveToken = json.last_active_token ?? this.lastActiveToken;
    this.latestActivity = mapActivity(json.latest_activity) ?? this.latestActivity;
    this.updatedAt = json.updated_at;
    return this;
  }

  /** Returns the session JWT (cached, refreshed 10 s before expiry, deduplicated across concurrent callers). */
  async getToken(options: GetTokenOptions = {}): Promise<string> {
    const template = options.template ?? null;
    return this.tokenCache.getToken(
      this.id,
      template,
      async () => {
        const path = template
          ? `/v1/client/sessions/${this.id}/tokens/${encodeURIComponent(template)}`
          : `/v1/client/sessions/${this.id}/tokens`;
        const raw = await this.fapi.post<unknown>(path, { body: {} });
        const data = unwrap<{ jwt?: string; token?: string } | string>(raw).data;
        const token = typeof data === "string" ? data : (data.jwt ?? data.token);
        if (!token) throw new Error("OrbitID did not return a session token");
        return token;
      },
      { skipCache: options.skipCache },
    );
  }

  async touch(params: { activeOrganizationId?: string | null } = {}): Promise<this> {
    const json = await fetchData<SessionJSON>(this.fapi, "POST", `/v1/client/sessions/${this.id}/touch`, {
      body: { active_organization_id: params.activeOrganizationId },
    });
    return this.update(json);
  }

  async end(): Promise<this> {
    const data = await fetchData<SessionJSON | undefined>(this.fapi, "POST", `/v1/client/sessions/${this.id}/end`);
    this.tokenCache.removeSession(this.id);
    return data?.object === "session" ? this.update(data) : this.markEnded("ended");
  }

  async remove(): Promise<this> {
    const data = await fetchData<SessionJSON | undefined>(this.fapi, "POST", `/v1/client/sessions/${this.id}/remove`);
    this.tokenCache.removeSession(this.id);
    return data?.object === "session" ? this.update(data) : this.markEnded("removed");
  }

  private markEnded(status: SessionStatus): this {
    this.status = status;
    this.updatedAt = Date.now();
    return this;
  }

  /** Revokes another device's session (`/me/sessions/:id/revoke`). */
  async revoke(): Promise<this> {
    await this.fapi.post(`/v1/client/me/sessions/${this.id}/revoke`);
    this.tokenCache.removeSession(this.id);
    this.status = "revoked";
    return this;
  }

  async startVerification(): Promise<SessionVerification> {
    const raw = await this.fapi.post<unknown>(`/v1/client/sessions/${this.id}/verify`, { body: {} });
    const data = unwrap<VerificationJSON & { verification?: VerificationJSON }>(raw).data;
    const verification = data.verification ?? data;
    return SessionVerification.fromJSON(this.fapi, this.id, verification);
  }

  /** `has({ role, permission, feature, reverification })` — reads role/permissions from the last session JWT. */
  checkAuthorization(check: HasCheckParams): boolean {
    const claims = this.lastActiveToken?.jwt ? decodeJwtPayload(this.lastActiveToken.jwt) : null;
    const has = createHasCheck({
      orgRole: typeof claims?.org_role === "string" ? claims.org_role : null,
      orgPermissions: Array.isArray(claims?.org_permissions) ? (claims.org_permissions as string[]) : null,
      fva: this.factorVerificationAge,
    });
    return has(check);
  }

  has(check: HasCheckParams): boolean {
    return this.checkAuthorization(check);
  }
}
