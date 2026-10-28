import { BackendHttp, type BackendHttpOptions } from "./http";
import type {
  ActorToken,
  AllowlistIdentifier,
  ApiKey,
  AuditLog,
  BlocklistIdentifier,
  Client,
  DeletedObject,
  EmailAddress,
  EnterpriseConnection,
  Invitation,
  JwtTemplate,
  ListParams,
  M2MMachine,
  M2MToken,
  M2MTokenVerification,
  OAuthApplication,
  Organization,
  OrganizationDomain,
  OrganizationInvitation,
  OrganizationMembership,
  OrganizationMembershipRequest,
  PaginatedResult,
  Permission,
  PhoneNumber,
  Role,
  Session,
  SessionToken,
  SignInToken,
  Stats,
  TestingToken,
  User,
  VerifyPasswordResult,
  VerifyTOTPResult,
  WaitlistEntry,
  WebhookDelivery,
  WebhookEndpoint,
} from "./types";
import type { Metadata } from "@orbitid/shared";

export interface CreateOrbitIdClientOptions extends BackendHttpOptions {}

export interface UserListParams extends ListParams {
  emailAddress?: string[];
  phoneNumber?: string[];
  username?: string[];
  externalId?: string[];
  userId?: string[];
}

export interface CreateUserParams {
  emailAddress?: string[];
  phoneNumber?: string[];
  username?: string;
  password?: string;
  passwordDigest?: string;
  firstName?: string;
  lastName?: string;
  externalId?: string;
  publicMetadata?: Metadata;
  privateMetadata?: Metadata;
  unsafeMetadata?: Metadata;
  skipPasswordChecks?: boolean;
  skipPasswordRequirement?: boolean;
  createdAt?: string;
}

export interface UpdateUserParams {
  firstName?: string | null;
  lastName?: string | null;
  username?: string | null;
  password?: string;
  primaryEmailAddressId?: string | null;
  primaryPhoneNumberId?: string | null;
  externalId?: string | null;
  publicMetadata?: Metadata;
  privateMetadata?: Metadata;
  unsafeMetadata?: Metadata;
  skipPasswordChecks?: boolean;
}

export interface UpdateMetadataParams {
  publicMetadata?: Metadata;
  privateMetadata?: Metadata;
  unsafeMetadata?: Metadata;
}

export interface SessionListParams extends ListParams {
  clientId?: string;
  userId?: string;
  status?: string;
}

export interface OrganizationListParams extends ListParams {
  includeMembersCount?: boolean;
  userIds?: string[];
  organizationIds?: string[];
}

export interface CreateOrganizationParams {
  name: string;
  slug?: string;
  createdBy?: string;
  maxAllowedMemberships?: number;
  publicMetadata?: Metadata;
  privateMetadata?: Metadata;
}

export interface CreateOrganizationInvitationParams {
  organizationId: string;
  emailAddress: string;
  role: string;
  inviterUserId?: string;
  redirectUrl?: string;
  publicMetadata?: Metadata;
  privateMetadata?: Metadata;
  expiresAt?: number;
}

export interface CreateInvitationParams {
  emailAddress: string;
  redirectUrl?: string;
  publicMetadata?: Metadata;
  notify?: boolean;
  ignoreExisting?: boolean;
  expiresInDays?: number;
}

type ListQuery = Record<string, string | number | boolean | undefined | null | Array<string | number>>;

async function list<T>(http: BackendHttp, path: string, query: ListQuery = {}): Promise<PaginatedResult<T>> {
  const raw = await http.get<{ data?: T[]; totalCount?: number } | T[]>(path, { query });
  if (Array.isArray(raw)) return { data: raw, totalCount: raw.length };
  const data = Array.isArray(raw?.data) ? raw.data : [];
  return { data, totalCount: raw?.totalCount ?? data.length };
}

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
  actorTokens: ReturnType<typeof createActorTokensApi>;
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
    actorTokens: createActorTokensApi(http),
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

function createUsersApi(http: BackendHttp) {
  return {
    getUserList(params: UserListParams = {}) {
      return list<User>(http, "/v1/users", {
        limit: params.limit,
        offset: params.offset,
        order_by: params.orderBy,
        query: params.query,
        paginated: true,
        email_address: params.emailAddress,
        phone_number: params.phoneNumber,
        username: params.username,
        external_id: params.externalId,
        user_id: params.userId,
      });
    },
    getUser(userId: string) {
      return http.get<User>(`/v1/users/${userId}`);
    },
    createUser(params: CreateUserParams) {
      return http.post<User>("/v1/users", { body: params });
    },
    updateUser(userId: string, params: UpdateUserParams) {
      return http.patch<User>(`/v1/users/${userId}`, { body: params });
    },
    deleteUser(userId: string) {
      return http.delete<DeletedObject>(`/v1/users/${userId}`);
    },
    banUser(userId: string) {
      return http.post<User>(`/v1/users/${userId}/ban`);
    },
    unbanUser(userId: string) {
      return http.post<User>(`/v1/users/${userId}/unban`);
    },
    lockUser(userId: string) {
      return http.post<User>(`/v1/users/${userId}/lock`);
    },
    unlockUser(userId: string) {
      return http.post<User>(`/v1/users/${userId}/unlock`);
    },
    updateUserMetadata(userId: string, params: UpdateMetadataParams) {
      return http.patch<User>(`/v1/users/${userId}/metadata`, { body: params });
    },
    verifyPassword(params: { userId: string; password: string }) {
      return http.post<VerifyPasswordResult>(`/v1/users/${params.userId}/verify_password`, { body: { password: params.password } });
    },
    verifyTOTP(params: { userId: string; code: string }) {
      return http.post<VerifyTOTPResult>(`/v1/users/${params.userId}/verify_totp`, { body: { code: params.code } });
    },
    disableUserMFA(userId: string) {
      return http.delete<User>(`/v1/users/${userId}/mfa`);
    },
    uploadUserProfileImage(userId: string, file: Blob) {
      const formData = new FormData();
      formData.append("file", file);
      return http.post<User>(`/v1/users/${userId}/profile_image`, { formData });
    },
    deleteUserProfileImage(userId: string) {
      return http.delete<User>(`/v1/users/${userId}/profile_image`);
    },
    getUserOrganizationMembershipList(params: { userId: string } & ListParams) {
      return list<OrganizationMembership>(http, `/v1/users/${params.userId}/organization_memberships`, {
        limit: params.limit,
        offset: params.offset,
      });
    },
    getUserOauthAccessToken(params: { userId: string; provider: string }) {
      return http.get<{ token: string | null; provider: string }>(`/v1/users/${params.userId}/oauth_access_tokens/${params.provider}`);
    },
    getCount(params: Omit<UserListParams, "limit" | "offset" | "orderBy"> = {}) {
      return http.get<{ totalCount: number }>("/v1/users/count", {
        query: {
          query: params.query,
          email_address: params.emailAddress,
          phone_number: params.phoneNumber,
          username: params.username,
          external_id: params.externalId,
          user_id: params.userId,
        },
      });
    },
  };
}

function createEmailAddressesApi(http: BackendHttp) {
  return {
    createEmailAddress(params: { userId: string; emailAddress: string; verified?: boolean; primary?: boolean }) {
      return http.post<EmailAddress>("/v1/email_addresses", { body: params });
    },
    getEmailAddress(emailAddressId: string) {
      return http.get<EmailAddress>(`/v1/email_addresses/${emailAddressId}`);
    },
    updateEmailAddress(emailAddressId: string, params: { verified?: boolean; primary?: boolean }) {
      return http.patch<EmailAddress>(`/v1/email_addresses/${emailAddressId}`, { body: params });
    },
    deleteEmailAddress(emailAddressId: string) {
      return http.delete<DeletedObject>(`/v1/email_addresses/${emailAddressId}`);
    },
  };
}

function createPhoneNumbersApi(http: BackendHttp) {
  return {
    createPhoneNumber(params: { userId: string; phoneNumber: string; verified?: boolean; primary?: boolean; reservedForSecondFactor?: boolean }) {
      return http.post<PhoneNumber>("/v1/phone_numbers", { body: params });
    },
    getPhoneNumber(phoneNumberId: string) {
      return http.get<PhoneNumber>(`/v1/phone_numbers/${phoneNumberId}`);
    },
    updatePhoneNumber(phoneNumberId: string, params: { verified?: boolean; primary?: boolean; reservedForSecondFactor?: boolean }) {
      return http.patch<PhoneNumber>(`/v1/phone_numbers/${phoneNumberId}`, { body: params });
    },
    deletePhoneNumber(phoneNumberId: string) {
      return http.delete<DeletedObject>(`/v1/phone_numbers/${phoneNumberId}`);
    },
  };
}

function createSessionsApi(http: BackendHttp) {
  return {
    getSessionList(params: SessionListParams = {}) {
      return list<Session>(http, "/v1/sessions", {
        client_id: params.clientId,
        user_id: params.userId,
        status: params.status,
        limit: params.limit,
        offset: params.offset,
      });
    },
    getSession(sessionId: string) {
      return http.get<Session>(`/v1/sessions/${sessionId}`);
    },
    revokeSession(sessionId: string) {
      return http.post<Session>(`/v1/sessions/${sessionId}/revoke`);
    },
    getToken(sessionId: string, params: { template?: string } = {}) {
      const path = params.template ? `/v1/sessions/${sessionId}/tokens/${encodeURIComponent(params.template)}` : `/v1/sessions/${sessionId}/tokens`;
      return http.post<SessionToken>(path);
    },
  };
}

function createClientsApi(http: BackendHttp) {
  return {
    getClient(clientId: string) {
      return http.get<Client>(`/v1/clients/${clientId}`);
    },
    verifyClient(params: { token: string }) {
      return http.post<Client>("/v1/clients/verify", { body: params });
    },
  };
}

function createOrganizationsApi(http: BackendHttp) {
  return {
    getOrganizationList(params: OrganizationListParams = {}) {
      return list<Organization>(http, "/v1/organizations", {
        limit: params.limit,
        offset: params.offset,
        order_by: params.orderBy,
        query: params.query,
        include_members_count: params.includeMembersCount,
        user_id: params.userIds,
        organization_ids: params.organizationIds,
      });
    },
    createOrganization(params: CreateOrganizationParams) {
      return http.post<Organization>("/v1/organizations", { body: params });
    },
    getOrganization(organizationId: string) {
      return http.get<Organization>(`/v1/organizations/${organizationId}`);
    },
    updateOrganization(organizationId: string, params: { name?: string; slug?: string; maxAllowedMemberships?: number; publicMetadata?: Metadata; privateMetadata?: Metadata; adminDeleteEnabled?: boolean }) {
      return http.patch<Organization>(`/v1/organizations/${organizationId}`, { body: params });
    },
    deleteOrganization(organizationId: string) {
      return http.delete<DeletedObject>(`/v1/organizations/${organizationId}`);
    },
    updateOrganizationMetadata(organizationId: string, params: UpdateMetadataParams) {
      return http.patch<Organization>(`/v1/organizations/${organizationId}/metadata`, { body: params });
    },
    getOrganizationMembershipList(params: { organizationId: string } & ListParams & { role?: string }) {
      return list<OrganizationMembership>(http, `/v1/organizations/${params.organizationId}/memberships`, {
        limit: params.limit,
        offset: params.offset,
        order_by: params.orderBy,
        role: params.role,
      });
    },
    createOrganizationMembership(params: { organizationId: string; userId: string; role: string }) {
      return http.post<OrganizationMembership>(`/v1/organizations/${params.organizationId}/memberships`, {
        body: { user_id: params.userId, role: params.role },
      });
    },
    updateOrganizationMembership(params: { organizationId: string; userId: string; role: string }) {
      return http.patch<OrganizationMembership>(`/v1/organizations/${params.organizationId}/memberships/${params.userId}`, { body: { role: params.role } });
    },
    deleteOrganizationMembership(params: { organizationId: string; userId: string }) {
      return http.delete<DeletedObject>(`/v1/organizations/${params.organizationId}/memberships/${params.userId}`);
    },
    getOrganizationInvitationList(params: { organizationId: string; status?: string } & ListParams) {
      return list<OrganizationInvitation>(http, `/v1/organizations/${params.organizationId}/invitations`, {
        limit: params.limit,
        offset: params.offset,
        status: params.status,
      });
    },
    createOrganizationInvitation(params: CreateOrganizationInvitationParams) {
      const { organizationId, ...body } = params;
      return http.post<OrganizationInvitation>(`/v1/organizations/${organizationId}/invitations`, { body });
    },
    createOrganizationInvitationBulk(organizationId: string, params: Omit<CreateOrganizationInvitationParams, "organizationId">[]) {
      if (!params.length) return Promise.resolve([] as OrganizationInvitation[]);
      const roles = new Set(params.map((invitation) => invitation.role));
      if (roles.size > 1) throw new Error("Bulk organization invitations require a single role");
      const first = params[0]!;
      return http.post<OrganizationInvitation[]>(`/v1/organizations/${organizationId}/invitations/bulk`, {
        body: {
          email_addresses: params.map((invitation) => invitation.emailAddress),
          role: first.role,
          inviter_user_id: first.inviterUserId,
          redirect_url: first.redirectUrl,
          expires_at: first.expiresAt,
          public_metadata: first.publicMetadata,
          private_metadata: first.privateMetadata,
        },
      });
    },
    revokeOrganizationInvitation(params: { organizationId: string; invitationId: string; requestingUserId?: string }) {
      return http.post<OrganizationInvitation>(`/v1/organizations/${params.organizationId}/invitations/${params.invitationId}/revoke`, {
        body: { requesting_user_id: params.requestingUserId },
      });
    },
    getOrganizationDomainList(params: { organizationId: string } & ListParams) {
      return list<OrganizationDomain>(http, `/v1/organizations/${params.organizationId}/domains`, {
        limit: params.limit,
        offset: params.offset,
      });
    },
    createOrganizationDomain(params: { organizationId: string; name: string; enrollmentMode?: string }) {
      return http.post<OrganizationDomain>(`/v1/organizations/${params.organizationId}/domains`, {
        body: { name: params.name, enrollment_mode: params.enrollmentMode },
      });
    },
    updateOrganizationDomain(params: { organizationId: string; domainId: string; enrollmentMode?: string; deletePending?: boolean }) {
      return http.patch<OrganizationDomain>(`/v1/organizations/${params.organizationId}/domains/${params.domainId}`, {
        body: { enrollment_mode: params.enrollmentMode, delete_pending: params.deletePending },
      });
    },
    deleteOrganizationDomain(params: { organizationId: string; domainId: string }) {
      return http.delete<DeletedObject>(`/v1/organizations/${params.organizationId}/domains/${params.domainId}`);
    },
    getOrganizationMembershipRequestList(params: { organizationId: string; status?: string } & ListParams) {
      return list<OrganizationMembershipRequest>(http, `/v1/organizations/${params.organizationId}/membership_requests`, {
        limit: params.limit,
        offset: params.offset,
        status: params.status,
      });
    },
    getOrganizationRoleList(params: { organizationId: string } & ListParams) {
      return list<Role>(http, `/v1/organizations/${params.organizationId}/roles`, {
        limit: params.limit,
        offset: params.offset,
        order_by: params.orderBy,
        query: params.query,
      });
    },
    createOrganizationRole(params: { organizationId?: string; name: string; key: string; description?: string; permissions?: string[]; isCreatorEligible?: boolean }) {
      return http.post<Role>("/v1/roles", {
        body: { key: params.key, name: params.name, description: params.description, permissions: params.permissions, is_creator_eligible: params.isCreatorEligible },
      });
    },
    updateOrganizationRole(params: { organizationId?: string; roleId: string; name?: string; description?: string; permissions?: string[]; isCreatorEligible?: boolean }) {
      return http.patch<Role>(`/v1/roles/${params.roleId}`, {
        body: { name: params.name, description: params.description, permissions: params.permissions, is_creator_eligible: params.isCreatorEligible },
      });
    },
    deleteOrganizationRole(params: { organizationId?: string; roleId: string }) {
      return http.delete<DeletedObject>(`/v1/roles/${params.roleId}`);
    },
    getPermissionList(params: { organizationId?: string; type?: string } & ListParams = {}) {
      return list<Permission>(http, "/v1/permissions", {
        limit: params.limit,
        offset: params.offset,
        order_by: params.orderBy,
        query: params.query,
        type: params.type,
      });
    },
    createPermission(params: { organizationId?: string; name: string; key: string; description?: string }) {
      return http.post<Permission>("/v1/permissions", {
        body: { name: params.name, key: params.key, description: params.description },
      });
    },
    updatePermission(params: { organizationId?: string; permissionId: string; name?: string; description?: string }) {
      return http.patch<Permission>(`/v1/permissions/${params.permissionId}`, {
        body: { name: params.name, description: params.description },
      });
    },
    deletePermission(params: { organizationId?: string; permissionId: string }) {
      return http.delete<DeletedObject>(`/v1/permissions/${params.permissionId}`);
    },
  };
}

function createInvitationsApi(http: BackendHttp) {
  return {
    createInvitation(params: CreateInvitationParams) {
      return http.post<Invitation>("/v1/invitations", { body: params });
    },
    createInvitationBulk(params: CreateInvitationParams[]) {
      if (!params.length) return Promise.resolve([] as Invitation[]);
      const first = params[0]!;
      return http.post<Invitation[]>("/v1/invitations/bulk", {
        body: {
          email_addresses: params.map((invitation) => invitation.emailAddress),
          redirect_url: first.redirectUrl,
          public_metadata: first.publicMetadata,
          notify: first.notify,
          ignore_existing: first.ignoreExisting,
          expires_in_days: first.expiresInDays,
        },
      });
    },
    getInvitationList(params: { status?: string } & ListParams = {}) {
      return list<Invitation>(http, "/v1/invitations", { status: params.status, limit: params.limit, offset: params.offset });
    },
    revokeInvitation(invitationId: string) {
      return http.post<Invitation>(`/v1/invitations/${invitationId}/revoke`);
    },
  };
}

function createWaitlistApi(http: BackendHttp) {
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

function createAllowlistApi(http: BackendHttp) {
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

function createBlocklistApi(http: BackendHttp) {
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

function createJwtTemplatesApi(http: BackendHttp) {
  return {
    getJwtTemplateList(params: ListParams = {}) {
      return list<JwtTemplate>(http, "/v1/jwt_templates", { limit: params.limit, offset: params.offset });
    },
    getJwtTemplate(templateId: string) {
      return http.get<JwtTemplate>(`/v1/jwt_templates/${templateId}`);
    },
    createJwtTemplate(params: { name: string; claims: Record<string, unknown>; lifetime?: number; allowedClockSkew?: number; signingAlgorithm?: string }) {
      return http.post<JwtTemplate>("/v1/jwt_templates", { body: params });
    },
    updateJwtTemplate(templateId: string, params: { name?: string; claims?: Record<string, unknown>; lifetime?: number; allowedClockSkew?: number }) {
      return http.patch<JwtTemplate>(`/v1/jwt_templates/${templateId}`, { body: params });
    },
    deleteJwtTemplate(templateId: string) {
      return http.delete<DeletedObject>(`/v1/jwt_templates/${templateId}`);
    },
  };
}

function createActorTokensApi(http: BackendHttp) {
  return {
    createActorToken(params: { userId: string; actor: Record<string, unknown>; expiresInSeconds?: number }) {
      return http.post<ActorToken>("/v1/actor_tokens", { body: params });
    },
    revokeActorToken(actorTokenId: string) {
      return http.post<ActorToken>(`/v1/actor_tokens/${actorTokenId}/revoke`);
    },
  };
}

function createSignInTokensApi(http: BackendHttp) {
  return {
    createSignInToken(params: { userId: string; expiresInSeconds?: number }) {
      return http.post<SignInToken>("/v1/sign_in_tokens", { body: params });
    },
    revokeSignInToken(signInTokenId: string) {
      return http.post<SignInToken>(`/v1/sign_in_tokens/${signInTokenId}/revoke`);
    },
  };
}

function createWebhooksApi(http: BackendHttp) {
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
    getWebhookDeliveryList(params: { endpointId?: string } & ListParams = {}) {
      return list<WebhookDelivery>(http, "/v1/webhooks/deliveries", {
        endpoint_id: params.endpointId,
        limit: params.limit,
        offset: params.offset,
      });
    },
    getWebhookDelivery(deliveryId: string) {
      return http.get<WebhookDelivery>(`/v1/webhooks/deliveries/${deliveryId}`);
    },
    retryWebhookDelivery(deliveryId: string) {
      return http.post<WebhookDelivery>(`/v1/webhooks/deliveries/${deliveryId}/retry`);
    },
    sendTestWebhook(params: { endpointId: string; eventType?: string }) {
      return http.post<WebhookDelivery>("/v1/webhooks/test", { body: params });
    },
  };
}

function createApiKeysApi(http: BackendHttp) {
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

function createM2MApi(http: BackendHttp) {
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

function createOAuthApplicationsApi(http: BackendHttp) {
  return {
    getOAuthApplicationList(params: ListParams = {}) {
      return list<OAuthApplication>(http, "/v1/oauth_applications", { limit: params.limit, offset: params.offset });
    },
    getOAuthApplication(applicationId: string) {
      return http.get<OAuthApplication>(`/v1/oauth_applications/${applicationId}`);
    },
    createOAuthApplication(params: { name: string; redirectUris: string[]; scopes?: string; public?: boolean; consentScreenEnabled?: boolean; pkceRequired?: boolean }) {
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
  };
}

function createEnterpriseConnectionsApi(http: BackendHttp) {
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

function createInstanceApi(http: BackendHttp) {
  return {
    getInstance() {
      return http.get<Stats>("/v1/instance");
    },
    updateInstance(params: Record<string, unknown>) {
      return http.patch<Stats>("/v1/instance", { body: params });
    },
  };
}

function createTestingTokensApi(http: BackendHttp) {
  return {
    createTestingToken() {
      return http.post<TestingToken>("/v1/testing_tokens");
    },
  };
}

function createAuditLogsApi(http: BackendHttp) {
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

function createStatsApi(http: BackendHttp) {
  return {
    getStats(params: { from?: number; to?: number } = {}) {
      return http.get<Stats>("/v1/stats", { query: { from: params.from, to: params.to } });
    },
  };
}
