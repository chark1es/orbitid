import type { BackendHttp } from "../http";
import type {
  DeletedObject,
  Invitation,
  ListParams,
  Organization,
  OrganizationDomain,
  OrganizationInvitation,
  OrganizationMembership,
  OrganizationMembershipRequest,
  Permission,
  Role,
} from "../types";
import type { Metadata } from "@orbitid/shared";
import { list, type UpdateMetadataParams } from "./shared";

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
  /** External billing portal: an absolute https URL. */
  billingPortalUrl?: string | null;
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

export function createOrganizationsApi(http: BackendHttp) {
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
    /** `billingPortalUrl` must be an absolute https URL; `null` clears it. */
    updateOrganization(organizationId: string, params: { name?: string; slug?: string; maxAllowedMemberships?: number; publicMetadata?: Metadata; privateMetadata?: Metadata; adminDeleteEnabled?: boolean; billingPortalUrl?: string | null }) {
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
    prepareOrganizationDomainAffiliationVerification(params: { organizationId: string; domainId: string; affiliationEmailAddress: string }) {
      return http.post<OrganizationDomain>(`/v1/organizations/${params.organizationId}/domains/${params.domainId}/prepare_affiliation_verification`, {
        body: { affiliation_email_address: params.affiliationEmailAddress },
      });
    },
    attemptOrganizationDomainAffiliationVerification(params: { organizationId: string; domainId: string; code: string }) {
      return http.post<OrganizationDomain>(`/v1/organizations/${params.organizationId}/domains/${params.domainId}/attempt_affiliation_verification`, {
        body: { code: params.code },
      });
    },
    getOrganizationMembershipRequestList(params: { organizationId: string; status?: string } & ListParams) {
      return list<OrganizationMembershipRequest>(http, `/v1/organizations/${params.organizationId}/membership_requests`, {
        limit: params.limit,
        offset: params.offset,
        status: params.status,
      });
    },
    /** Records a user's request to join an organization (the server returns an existing pending request instead of duplicating it). */
    createOrganizationMembershipRequest(params: { organizationId: string; userId: string; status?: "pending" | "accepted" | "rejected" }) {
      const { organizationId, ...body } = params;
      return http.post<OrganizationMembershipRequest>(`/v1/organizations/${organizationId}/membership_requests`, { body });
    },
    /** Accepts a pending request, creating a membership with the organization's default role. */
    acceptOrganizationMembershipRequest(params: { organizationId: string; requestId: string }) {
      return http.post<OrganizationMembership>(`/v1/organizations/${params.organizationId}/membership_requests/${params.requestId}/accept`);
    },
    rejectOrganizationMembershipRequest(params: { organizationId: string; requestId: string }) {
      return http.post<OrganizationMembershipRequest>(`/v1/organizations/${params.organizationId}/membership_requests/${params.requestId}/reject`);
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

export function createInvitationsApi(http: BackendHttp) {
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
