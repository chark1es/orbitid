/**
 * Frontend API fallback for the few org operations `@orbitid/js` does not expose as resource
 * methods yet (accepting a user invitation, API-key create/revoke). Requests are cookie
 * authenticated, like the SDK's own (`credentials: "include"`).
 */
import {
  decodePublishableKey,
  isPublishableKey,
  type ApiKeyJSON,
  type OrganizationMembershipJSON,
} from "@orbitid/shared";
import type { OrbitIDInstance } from "../../../provider";

export interface FapiErrorItem {
  code: string;
  message: string;
}

export class FapiError extends Error {
  readonly status: number;
  readonly errors: FapiErrorItem[];

  constructor(status: number, errors: FapiErrorItem[]) {
    super(errors[0]?.message || `Request failed with status ${status}`);
    this.name = "FapiError";
    this.status = status;
    this.errors = errors;
  }
}

interface SdkOptions {
  fetch?: typeof globalThis.fetch;
  domain?: string;
  proxyUrl?: string;
}

function sdkOptions(instance: OrbitIDInstance): SdkOptions {
  const options: unknown = instance.options;
  return options && typeof options === "object" ? (options as SdkOptions) : {};
}

/** Frontend API origin from the publishable key (or the SDK's domain/proxyUrl option). */
export function fapiBaseUrl(instance: OrbitIDInstance): string {
  const key = instance.publishableKey;
  if (key && isPublishableKey(key)) {
    try {
      const { frontendApi } = decodePublishableKey(key);
      if (frontendApi) {
        const origin = /^https?:\/\//.test(frontendApi) ? frontendApi : `https://${frontendApi}`;
        return origin.replace(/\/+$/, "");
      }
    } catch {
      // Fall through to the options/window lookup.
    }
  }
  const options = sdkOptions(instance);
  if (options.proxyUrl) return options.proxyUrl.replace(/\/+$/, "");
  if (options.domain) {
    const origin = /^https?:\/\//.test(options.domain)
      ? options.domain
      : `https://${options.domain}`;
    return origin.replace(/\/+$/, "");
  }
  return typeof window !== "undefined" ? window.location.origin : "";
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
}

function readErrors(payload: unknown): FapiErrorItem[] {
  if (!payload || typeof payload !== "object" || !("errors" in payload)) return [];
  const errors = payload.errors;
  if (!Array.isArray(errors)) return [];
  return errors.flatMap((item: unknown): FapiErrorItem[] => {
    if (!item || typeof item !== "object") return [];
    const record = item as Record<string, unknown>;
    const code = typeof record.code === "string" ? record.code : "unknown_error";
    const message =
      typeof record.message === "string"
        ? record.message
        : typeof record.long_message === "string"
          ? record.long_message
          : code;
    return [{ code, message }];
  });
}

/** `{ response, total_count? }` → the resource (arrays keep their envelope count). */
function unwrap<T>(payload: unknown): { data: T; totalCount: number } {
  if (Array.isArray(payload)) return { data: payload as T, totalCount: payload.length };
  if (!payload || typeof payload !== "object") {
    return { data: payload as T, totalCount: 0 };
  }
  const envelope = payload as Record<string, unknown>;
  const data = (envelope.response ?? envelope.data ?? envelope) as T;
  const totalCount =
    typeof envelope.total_count === "number"
      ? envelope.total_count
      : Array.isArray(data)
        ? data.length
        : 1;
  return { data, totalCount };
}

export async function fapiRequest<T>(
  instance: OrbitIDInstance,
  path: string,
  options: RequestOptions = {},
): Promise<{ data: T; totalCount: number }> {
  const fetchImpl = sdkOptions(instance).fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new FapiError(0, [{ code: "network_error", message: "fetch is not available" }]);
  }
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const response = await fetchImpl(`${fapiBaseUrl(instance)}/v1/client${path}`, {
    method: options.method ?? "GET",
    credentials: "include",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
  });
  const text = await response.text();
  let payload: unknown = null;
  if (text) {
    try {
      payload = JSON.parse(text) as unknown;
    } catch {
      payload = null;
    }
  }
  if (!response.ok) {
    const errors = readErrors(payload);
    throw new FapiError(
      response.status,
      errors.length > 0 ? errors : [{ code: "unknown_error", message: response.statusText }],
    );
  }
  return unwrap<T>(payload);
}

/** `POST /me/organization_invitations/:id/accept` (SDK builds without `UserOrganizationInvitation`). */
export async function acceptUserInvitation(
  instance: OrbitIDInstance,
  invitationId: string,
): Promise<OrganizationMembershipJSON | null> {
  const result = await fapiRequest<OrganizationMembershipJSON | null>(
    instance,
    `/me/organization_invitations/${encodeURIComponent(invitationId)}/accept`,
    { method: "POST" },
  );
  return result.data ?? null;
}

/**
 * Accepts an invitation through the SDK resource when it exposes `accept()` (newer
 * `@orbitid/js`), otherwise through the Frontend API.
 */
export async function acceptOrganizationInvitation(
  instance: OrbitIDInstance,
  invitation: { id: string },
): Promise<void> {
  const candidate = invitation as { accept?: unknown };
  if (typeof candidate.accept === "function") {
    await candidate.accept.call(invitation);
    return;
  }
  await acceptUserInvitation(instance, invitation.id);
}

export type ApiKeySubject = { type: "user" } | { type: "organization"; organizationId: string };

const apiKeysPath = (subject: ApiKeySubject): string =>
  subject.type === "user"
    ? "/me/api_keys"
    : `/organizations/${encodeURIComponent(subject.organizationId)}/api_keys`;

export interface ListApiKeysOptions {
  limit?: number;
  offset?: number;
  signal?: AbortSignal;
}

export async function listApiKeys(
  instance: OrbitIDInstance,
  subject: ApiKeySubject,
  options: ListApiKeysOptions = {},
): Promise<{ data: ApiKeyJSON[]; totalCount: number }> {
  const query = new URLSearchParams();
  if (options.limit !== undefined) query.set("limit", String(options.limit));
  if (options.offset !== undefined) query.set("offset", String(options.offset));
  const suffix = query.toString() ? `?${query}` : "";
  return fapiRequest<ApiKeyJSON[]>(instance, `${apiKeysPath(subject)}${suffix}`, {
    signal: options.signal,
  });
}

export interface CreateApiKeyParams {
  name: string;
  description?: string;
  /** Epoch ms; `null` = never expires. */
  expiration?: number | null;
  scopes?: string[];
}

export async function createApiKey(
  instance: OrbitIDInstance,
  subject: ApiKeySubject,
  params: CreateApiKeyParams,
): Promise<ApiKeyJSON> {
  const result = await fapiRequest<ApiKeyJSON>(instance, apiKeysPath(subject), {
    method: "POST",
    body: {
      name: params.name,
      ...(params.description ? { description: params.description } : {}),
      expiration: params.expiration ?? null,
      ...(params.scopes && params.scopes.length > 0 ? { scopes: params.scopes } : {}),
    },
  });
  return result.data;
}

/** `POST /…/api_keys/:id/revoke` (the SDK's endpoint; DELETE is not part of the FAPI). */
export async function revokeApiKey(
  instance: OrbitIDInstance,
  subject: ApiKeySubject,
  apiKeyId: string,
): Promise<ApiKeyJSON | null> {
  const result = await fapiRequest<ApiKeyJSON>(
    instance,
    `${apiKeysPath(subject)}/${encodeURIComponent(apiKeyId)}/revoke`,
    { method: "POST" },
  );
  return result.data ?? null;
}
