import type { BackendHttp } from "../http";
import type {
  AllowlistIdentifier,
  BlocklistIdentifier,
  DeletedObject,
  JwtTemplate,
  ListParams,
  SignInToken,
  WaitlistEntry,
} from "../types";
import { list } from "./shared";

export function createWaitlistApi(http: BackendHttp) {
  return {
    getWaitlistEntryList(params: { status?: string } & ListParams = {}) {
      return list<WaitlistEntry>(http, "/v1/waitlist_entries", { status: params.status, limit: params.limit, offset: params.offset });
    },
    createWaitlistEntry(params: { emailAddress: string }) {
      return http.post<WaitlistEntry>("/v1/waitlist_entries", { body: params });
    },
    inviteWaitlistEntry(waitlistEntryId: string) {
      return http.post<WaitlistEntry>(`/v1/waitlist_entries/${waitlistEntryId}/invite`);
    },
    rejectWaitlistEntry(waitlistEntryId: string) {
      return http.post<WaitlistEntry>(`/v1/waitlist_entries/${waitlistEntryId}/reject`);
    },
    deleteWaitlistEntry(waitlistEntryId: string) {
      return http.delete<DeletedObject>(`/v1/waitlist_entries/${waitlistEntryId}`);
    },
  };
}

export function createAllowlistApi(http: BackendHttp) {
  return {
    getAllowlistIdentifierList(params: ListParams = {}) {
      return list<AllowlistIdentifier>(http, "/v1/allowlist_identifiers", { limit: params.limit, offset: params.offset });
    },
    createAllowlistIdentifier(params: { identifier: string; notify?: boolean }) {
      return http.post<AllowlistIdentifier>("/v1/allowlist_identifiers", { body: params });
    },
    deleteAllowlistIdentifier(identifierId: string) {
      return http.delete<DeletedObject>(`/v1/allowlist_identifiers/${identifierId}`);
    },
  };
}

export function createBlocklistApi(http: BackendHttp) {
  return {
    getBlocklistIdentifierList(params: ListParams = {}) {
      return list<BlocklistIdentifier>(http, "/v1/blocklist_identifiers", { limit: params.limit, offset: params.offset });
    },
    createBlocklistIdentifier(params: { identifier: string }) {
      return http.post<BlocklistIdentifier>("/v1/blocklist_identifiers", { body: params });
    },
    deleteBlocklistIdentifier(identifierId: string) {
      return http.delete<DeletedObject>(`/v1/blocklist_identifiers/${identifierId}`);
    },
  };
}

export function createJwtTemplatesApi(http: BackendHttp) {
  return {
    getJwtTemplateList(params: ListParams = {}) {
      return list<JwtTemplate>(http, "/v1/jwt_templates", { limit: params.limit, offset: params.offset });
    },
    getJwtTemplate(templateId: string) {
      return http.get<JwtTemplate>(`/v1/jwt_templates/${templateId}`);
    },
    /** `customSigningKey` makes the template sign with a key of its own (`signingAlgorithm`), not the instance key. */
    createJwtTemplate(params: { name: string; claims: Record<string, unknown>; lifetime?: number; allowedClockSkew?: number; customSigningKey?: boolean; signingAlgorithm?: string }) {
      return http.post<JwtTemplate>("/v1/jwt_templates", { body: params });
    },
    /** Updating `signingAlgorithm` under a custom key regenerates that key; turning `customSigningKey` off returns to the instance key. */
    updateJwtTemplate(templateId: string, params: { name?: string; claims?: Record<string, unknown>; lifetime?: number; allowedClockSkew?: number; customSigningKey?: boolean; signingAlgorithm?: string }) {
      return http.patch<JwtTemplate>(`/v1/jwt_templates/${templateId}`, { body: params });
    },
    deleteJwtTemplate(templateId: string) {
      return http.delete<DeletedObject>(`/v1/jwt_templates/${templateId}`);
    },
  };
}

export function createSignInTokensApi(http: BackendHttp) {
  return {
    createSignInToken(params: { userId: string; expiresInSeconds?: number }) {
      return http.post<SignInToken>("/v1/sign_in_tokens", { body: params });
    },
    revokeSignInToken(signInTokenId: string) {
      return http.post<SignInToken>(`/v1/sign_in_tokens/${signInTokenId}/revoke`);
    },
  };
}
