import type { ApiKeyJSON } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { fetchData, unwrap } from "./base";
import { toPaginatedResponse, type PaginatedResponse, type PaginationParams } from "../util/pagination";

export interface CreateApiKeyParams {
  name: string;
  description?: string;
  scopes?: string[];
  expiration?: number | null;
  claims?: Record<string, unknown> | null;
  /** Create under an organization (`/organizations/:id/api_keys`) instead of the current user. */
  organizationId?: string;
}

export interface ListApiKeysParams extends PaginationParams {
  organizationId?: string;
}

function apiKeysPath(organizationId?: string): string {
  return organizationId ? `/v1/client/organizations/${organizationId}/api_keys` : "/v1/client/me/api_keys";
}

export class ApiKey {
  readonly object = "api_key" as const;
  id: string;
  name: string;
  description: string | null;
  subject: string;
  prefix: string;
  /** Plaintext secret — returned only once, at creation. */
  secret?: string;
  scopes: string[];
  claims: Record<string, unknown> | null;
  revoked: boolean;
  expiration: number | null;
  lastUsedAt: number | null;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: ApiKeyJSON,
    private readonly organizationId?: string,
  ) {
    this.id = json.id;
    this.name = json.name;
    this.description = json.description;
    this.subject = json.subject;
    this.prefix = json.prefix;
    this.secret = json.secret;
    this.scopes = json.scopes ?? [];
    this.claims = json.claims ?? null;
    this.revoked = json.revoked ?? false;
    this.expiration = json.expiration;
    this.lastUsedAt = json.last_used_at;
    this.createdBy = json.created_by;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: ApiKeyJSON, organizationId?: string): ApiKey {
    return new ApiKey(fapi, json, organizationId);
  }

  static async list(fapi: FapiClient, params: ListApiKeysParams = {}): Promise<PaginatedResponse<ApiKey>> {
    const raw = await fapi.get<unknown>(apiKeysPath(params.organizationId), {
      query: { limit: params.limit, offset: params.offset },
    });
    return toPaginatedResponse(unwrap<unknown>(raw).data, (item) => ApiKey.fromJSON(fapi, item as ApiKeyJSON, params.organizationId));
  }

  static async create(fapi: FapiClient, params: CreateApiKeyParams): Promise<ApiKey> {
    const json = await fetchData<ApiKeyJSON>(fapi, "POST", apiKeysPath(params.organizationId), {
      body: {
        name: params.name,
        description: params.description,
        scopes: params.scopes,
        expiration: params.expiration,
        claims: params.claims,
      },
    });
    return ApiKey.fromJSON(fapi, json, params.organizationId);
  }

  static async revoke(fapi: FapiClient, id: string, params: { organizationId?: string } = {}): Promise<void> {
    await fapi.post(`${apiKeysPath(params.organizationId)}/${id}/revoke`);
  }

  async revoke(): Promise<void> {
    await ApiKey.revoke(this.fapi, this.id, { organizationId: this.organizationId });
    this.revoked = true;
  }
}
