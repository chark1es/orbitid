import type { BackendHttp } from "../http";
import type {
  ApiKey,
  AuditLog,
  DeletedObject,
  EnterpriseConnection,
  ListParams,
  M2MMachine,
  M2MToken,
  M2MTokenVerification,
  OAuthApplication,
  OAuthApplicationAccessGrant,
  SigningKey,
  Stats,
  TestingToken,
  WebhookDelivery,
  WebhookEndpoint,
} from "../types";
import { list } from "./shared";

export function createWebhooksApi(http: BackendHttp) {
  return {
    getWebhookEndpointList(params: ListParams = {}) {
      return list<WebhookEndpoint>(http, "/v1/webhooks/endpoints", { limit: params.limit, offset: params.offset });
    },
    createWebhookEndpoint(params: { url: string; description?: string; eventTypes: string[]; disabled?: boolean }) {
      return http.post<WebhookEndpoint>("/v1/webhooks/endpoints", { body: params });
    },
    getWebhookEndpoint(endpointId: string) {
      return http.get<WebhookEndpoint>(`/v1/webhooks/endpoints/${endpointId}`);
    },
    updateWebhookEndpoint(endpointId: string, params: { url?: string; description?: string; eventTypes?: string[]; disabled?: boolean }) {
      return http.patch<WebhookEndpoint>(`/v1/webhooks/endpoints/${endpointId}`, { body: params });
    },
    deleteWebhookEndpoint(endpointId: string) {
      return http.delete<DeletedObject>(`/v1/webhooks/endpoints/${endpointId}`);
    },
    /** The signing secret of an endpoint (`whsec_…`), for verifying deliveries. */
    getWebhookEndpointSecret(endpointId: string) {
      return http.get<{ object: "webhook_endpoint_secret"; id: string; secret: string }>(`/v1/webhooks/endpoints/${endpointId}/secret`);
    },
    rotateWebhookEndpointSecret(endpointId: string) {
      return http.patch<WebhookEndpoint>(`/v1/webhooks/endpoints/${endpointId}`, { body: { rotate_secret: true } });
    },
    getWebhookDeliveryList(params: { endpointId: string; status?: "pending" | "success" | "failed" } & ListParams) {
      return list<WebhookDelivery>(http, `/v1/webhooks/endpoints/${params.endpointId}/deliveries`, {
        status: params.status,
        limit: params.limit,
        offset: params.offset,
      });
    },
    retryWebhookDelivery(deliveryId: string) {
      return http.post<WebhookDelivery>(`/v1/webhooks/deliveries/${deliveryId}/retry`);
    },
    /** Sends a sample event to one endpoint right away and returns the delivery record. */
    sendTestWebhook(endpointId: string) {
      return http.post<WebhookDelivery>(`/v1/webhooks/endpoints/${endpointId}/test`);
    },
  };
}

export function createApiKeysApi(http: BackendHttp) {
  return {
    createApiKey(params: { name: string; subject: string; description?: string; scopes?: string[]; claims?: Record<string, unknown>; secondsUntilExpiration?: number | null }) {
      return http.post<ApiKey>("/v1/api_keys", { body: params });
    },
    getApiKeyList(params: { subject?: string } & ListParams = {}) {
      return list<ApiKey>(http, "/v1/api_keys", { subject: params.subject, limit: params.limit, offset: params.offset });
    },
    getApiKey(apiKeyId: string) {
      return http.get<ApiKey>(`/v1/api_keys/${apiKeyId}`);
    },
    revokeApiKey(apiKeyId: string) {
      return http.delete<DeletedObject>(`/v1/api_keys/${apiKeyId}`);
    },
    verifyApiKey(params: { secret: string }) {
      return http.post<ApiKey>("/v1/api_keys/verify", { body: params });
    },
  };
}

export function createM2MApi(http: BackendHttp) {
  const machines = {
    createMachine(params: { name: string; scopedMachines?: string[]; defaultTokenTtl?: number }) {
      return http.post<M2MMachine>("/v1/m2m/machines", { body: params });
    },
    getMachineList(params: ListParams = {}) {
      return list<M2MMachine>(http, "/v1/m2m/machines", { limit: params.limit, offset: params.offset });
    },
    getMachine(machineId: string) {
      return http.get<M2MMachine>(`/v1/m2m/machines/${machineId}`);
    },
    updateMachine(machineId: string, params: { name?: string; scopedMachines?: string[]; defaultTokenTtl?: number }) {
      return http.patch<M2MMachine>(`/v1/m2m/machines/${machineId}`, { body: params });
    },
    deleteMachine(machineId: string) {
      return http.delete<DeletedObject>(`/v1/m2m/machines/${machineId}`);
    },
  };
  const tokens = {
    createToken(params: { machineId: string; machineSecret?: string; claims?: Record<string, unknown>; secondsUntilExpiration?: number; tokenFormat?: "opaque" | "jwt" }) {
      return http.post<M2MToken>("/v1/m2m/tokens", { body: params });
    },
    verifyToken(params: { token: string }) {
      return http.post<M2MTokenVerification>("/v1/m2m/tokens/verify", { body: params });
    },
    revokeToken(tokenId: string) {
      return http.post<M2MToken>(`/v1/m2m/tokens/${tokenId}/revoke`);
    },
  };
  return {
    machines,
    tokens,
    verify: tokens.verifyToken,
  };
}

export function createOAuthApplicationsApi(http: BackendHttp) {
  return {
    /**
     * `organizationId` filters by owner: an organization id lists that organization's applications, `null` lists the
     * instance-wide ones, and leaving it out lists every application.
     */
    getOAuthApplicationList(params: ListParams & { organizationId?: string | null } = {}) {
      return list<OAuthApplication>(http, "/v1/oauth_applications", {
        limit: params.limit,
        offset: params.offset,
        organization_id: params.organizationId === null ? "null" : params.organizationId,
      });
    },
    getOAuthApplication(applicationId: string) {
      return http.get<OAuthApplication>(`/v1/oauth_applications/${applicationId}`);
    },
    /** `organizationId` makes the application organization-owned: only its members and granted users may use it. */
    createOAuthApplication(params: { name: string; redirectUris: string[]; scopes?: string; public?: boolean; consentScreenEnabled?: boolean; pkceRequired?: boolean; organizationId?: string }) {
      return http.post<OAuthApplication>("/v1/oauth_applications", { body: params });
    },
    updateOAuthApplication(applicationId: string, params: Record<string, unknown>) {
      return http.patch<OAuthApplication>(`/v1/oauth_applications/${applicationId}`, { body: params });
    },
    deleteOAuthApplication(applicationId: string) {
      return http.delete<DeletedObject>(`/v1/oauth_applications/${applicationId}`);
    },
    rotateOAuthApplicationSecret(applicationId: string) {
      return http.post<OAuthApplication>(`/v1/oauth_applications/${applicationId}/rotate_secret`);
    },
    /** Users granted access to an organization-owned application without being members of its organization. */
    getOAuthApplicationAccessGrantList(applicationId: string, params: ListParams = {}) {
      return list<OAuthApplicationAccessGrant>(http, `/v1/oauth_applications/${applicationId}/access_grants`, { limit: params.limit, offset: params.offset });
    },
    /** Grants one user access to one organization-owned application. Idempotent. */
    createOAuthApplicationAccessGrant(applicationId: string, params: { userId: string }) {
      return http.post<OAuthApplicationAccessGrant>(`/v1/oauth_applications/${applicationId}/access_grants`, { body: params });
    },
    /** Removes the grant and revokes the user's tokens for the application unless they are a member of its organization. */
    deleteOAuthApplicationAccessGrant(applicationId: string, userId: string) {
      return http.delete<{ object: "oauth_application_access_grant"; applicationId: string; userId: string; deleted: boolean }>(
        `/v1/oauth_applications/${applicationId}/access_grants/${userId}`,
      );
    },
    /** The organization-owned applications one user was granted access to. */
    getUserOAuthApplicationAccessGrantList(userId: string, params: ListParams = {}) {
      return list<OAuthApplicationAccessGrant>(http, `/v1/users/${userId}/oauth_application_access_grants`, { limit: params.limit, offset: params.offset });
    },
  };
}

export function createEnterpriseConnectionsApi(http: BackendHttp) {
  return {
    getEnterpriseConnectionList(params: ListParams = {}) {
      return list<EnterpriseConnection>(http, "/v1/enterprise_connections", { limit: params.limit, offset: params.offset });
    },
    getEnterpriseConnection(connectionId: string) {
      return http.get<EnterpriseConnection>(`/v1/enterprise_connections/${connectionId}`);
    },
    createEnterpriseConnection(params: Record<string, unknown>) {
      return http.post<EnterpriseConnection>("/v1/enterprise_connections", { body: params });
    },
    updateEnterpriseConnection(connectionId: string, params: Record<string, unknown>) {
      return http.patch<EnterpriseConnection>(`/v1/enterprise_connections/${connectionId}`, { body: params });
    },
    deleteEnterpriseConnection(connectionId: string) {
      return http.delete<DeletedObject>(`/v1/enterprise_connections/${connectionId}`);
    },
  };
}

export function createInstanceApi(http: BackendHttp) {
  return {
    getInstance() {
      return http.get<Stats>("/v1/instance");
    },
    updateInstance(params: Record<string, unknown>) {
      return http.patch<Stats>("/v1/instance", { body: params });
    },
    /** Starts signing new session tokens with a fresh key; old keys stay in the JWKS until their tokens expire. */
    rotateSigningKey() {
      return http.post<SigningKey>("/v1/instance/signing_keys/rotate");
    },
  };
}

export function createTestingTokensApi(http: BackendHttp) {
  return {
    createTestingToken() {
      return http.post<TestingToken>("/v1/testing_tokens");
    },
  };
}

export function createAuditLogsApi(http: BackendHttp) {
  return {
    getAuditLogList(
      params: {
        actor?: string;
        action?: string;
        after?: number;
        before?: number;
      } & ListParams = {},
    ) {
      return list<AuditLog>(http, "/v1/audit_logs", {
        limit: params.limit,
        offset: params.offset,
        order_by: params.orderBy,
        actor: params.actor,
        action: params.action,
        after: params.after,
        before: params.before,
      });
    },
  };
}

export function createStatsApi(http: BackendHttp) {
  return {
    getStats(params: { from?: number; to?: number } = {}) {
      return http.get<Stats>("/v1/stats", { query: { from: params.from, to: params.to } });
    },
  };
}
