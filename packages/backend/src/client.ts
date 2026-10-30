import { BackendHttp, type BackendHttpOptions } from "./http";
import { createUsersApi } from "./api/users";
import { createEmailAddressesApi, createPhoneNumbersApi } from "./api/contact";
import { createClientsApi, createSessionsApi } from "./api/sessions";
import { createInvitationsApi, createOrganizationsApi } from "./api/organizations";
import {
  createAllowlistApi,
  createBlocklistApi,
  createJwtTemplatesApi,
  createSignInTokensApi,
  createWaitlistApi,
} from "./api/access";
import {
  createApiKeysApi,
  createAuditLogsApi,
  createEnterpriseConnectionsApi,
  createInstanceApi,
  createM2MApi,
  createOAuthApplicationsApi,
  createStatsApi,
  createTestingTokensApi,
  createWebhooksApi,
} from "./api/platform";

export type { UpdateMetadataParams } from "./api/shared";
export type {
  CreateUserParams,
  UpdateUserParams,
  UserListParams,
} from "./api/users";
export type { SessionListParams } from "./api/sessions";
export type {
  CreateInvitationParams,
  CreateOrganizationInvitationParams,
  CreateOrganizationParams,
  OrganizationListParams,
} from "./api/organizations";

export interface CreateOrbitIdClientOptions extends BackendHttpOptions {}

export interface OrbitIdClient {
  readonly apiUrl: string;
  users: ReturnType<typeof createUsersApi>;
  emailAddresses: ReturnType<typeof createEmailAddressesApi>;
  phoneNumbers: ReturnType<typeof createPhoneNumbersApi>;
  sessions: ReturnType<typeof createSessionsApi>;
  clients: ReturnType<typeof createClientsApi>;
  organizations: ReturnType<typeof createOrganizationsApi>;
  invitations: ReturnType<typeof createInvitationsApi>;
  waitlistEntries: ReturnType<typeof createWaitlistApi>;
  allowlistIdentifiers: ReturnType<typeof createAllowlistApi>;
  blocklistIdentifiers: ReturnType<typeof createBlocklistApi>;
  jwtTemplates: ReturnType<typeof createJwtTemplatesApi>;
  signInTokens: ReturnType<typeof createSignInTokensApi>;
  webhooks: ReturnType<typeof createWebhooksApi>;
  apiKeys: ReturnType<typeof createApiKeysApi>;
  m2m: ReturnType<typeof createM2MApi>;
  oauthApplications: ReturnType<typeof createOAuthApplicationsApi>;
  enterpriseConnections: ReturnType<typeof createEnterpriseConnectionsApi>;
  instance: ReturnType<typeof createInstanceApi>;
  testingTokens: ReturnType<typeof createTestingTokensApi>;
  auditLogs: ReturnType<typeof createAuditLogsApi>;
  stats: ReturnType<typeof createStatsApi>;
}

export function createOrbitIdClient(options: CreateOrbitIdClientOptions): OrbitIdClient {
  const http = new BackendHttp(options);
  return {
    apiUrl: http.apiUrl,
    users: createUsersApi(http),
    emailAddresses: createEmailAddressesApi(http),
    phoneNumbers: createPhoneNumbersApi(http),
    sessions: createSessionsApi(http),
    clients: createClientsApi(http),
    organizations: createOrganizationsApi(http),
    invitations: createInvitationsApi(http),
    waitlistEntries: createWaitlistApi(http),
    allowlistIdentifiers: createAllowlistApi(http),
    blocklistIdentifiers: createBlocklistApi(http),
    jwtTemplates: createJwtTemplatesApi(http),
    signInTokens: createSignInTokensApi(http),
    webhooks: createWebhooksApi(http),
    apiKeys: createApiKeysApi(http),
    m2m: createM2MApi(http),
    oauthApplications: createOAuthApplicationsApi(http),
    enterpriseConnections: createEnterpriseConnectionsApi(http),
    instance: createInstanceApi(http),
    testingTokens: createTestingTokensApi(http),
    auditLogs: createAuditLogsApi(http),
    stats: createStatsApi(http),
  };
}
