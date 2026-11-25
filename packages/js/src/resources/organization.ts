import type {
  Metadata,
  OrganizationDomainJSON,
  OrganizationInvitationJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
  OrganizationBillingJSON,
  OrganizationMembershipRequestJSON,
  RoleJSON,
} from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { fetchData, fetchList, fetchPaginated } from "./base";
import { paginationQuery, type PaginatedResponse, type PaginationParams } from "../util/pagination";
import { ApiKey, type CreateApiKeyParams } from "./api-key";
import { OrganizationDomain } from "./organization-domain";
import { OrganizationInvitation } from "./organization-invitation";
import { OrganizationMembershipRequest } from "./organization-membership-request";
import { mapOrganizationPublicUserData, type OrganizationPublicUserData } from "./organization-shared";
import { Role } from "./permission";

/** An organization's billing settings, from {@link Organization.getBilling}. */
export interface OrganizationBilling {
  organizationId: string;
  /** The operator-configured external billing portal, or `null`. */
  portalUrl: string | null;
}

export interface UpdateOrganizationParams {
  name?: string;
  slug?: string;
  publicMetadata?: Metadata;
}

export class Organization {
  readonly object = "organization" as const;
  id: string;
  name: string;
  slug: string;
  imageUrl: string;
  hasImage: boolean;
  membersCount?: number;
  pendingInvitationsCount?: number;
  maxAllowedMemberships: number;
  adminDeleteEnabled: boolean;
  publicMetadata: Metadata;
  createdBy: string | null;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: OrganizationJSON,
  ) {
    this.id = json.id;
    this.name = json.name;
    this.slug = json.slug;
    this.imageUrl = json.image_url;
    this.hasImage = json.has_image;
    this.membersCount = json.members_count;
    this.pendingInvitationsCount = json.pending_invitations_count;
    this.maxAllowedMemberships = json.max_allowed_memberships;
    this.adminDeleteEnabled = json.admin_delete_enabled;
    this.publicMetadata = json.public_metadata ?? {};
    this.createdBy = json.created_by;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: OrganizationJSON): Organization {
    return new Organization(fapi, json);
  }

  get apiKeys(): { list: (params?: PaginationParams) => Promise<PaginatedResponse<ApiKey>>; create: (params: CreateApiKeyParams) => Promise<ApiKey> } {
    return {
      list: (params = {}) => ApiKey.list(this.fapi, { ...params, organizationId: this.id }),
      create: (params) => ApiKey.create(this.fapi, { ...params, organizationId: this.id }),
    };
  }

  private applyJSON(json: OrganizationJSON): this {
    this.name = json.name;
    this.slug = json.slug;
    this.imageUrl = json.image_url;
    this.hasImage = json.has_image;
    this.membersCount = json.members_count ?? this.membersCount;
    this.pendingInvitationsCount = json.pending_invitations_count ?? this.pendingInvitationsCount;
    this.publicMetadata = json.public_metadata ?? this.publicMetadata;
    this.updatedAt = json.updated_at;
    return this;
  }

  async update(params: UpdateOrganizationParams): Promise<this> {
    const body: Record<string, unknown> = {};
    if (params.name !== undefined) body.name = params.name;
    if (params.slug !== undefined) body.slug = params.slug;
    if (params.publicMetadata !== undefined) body.public_metadata = params.publicMetadata;
    const json = await fetchData<OrganizationJSON>(this.fapi, "PATCH", `/v1/client/organizations/${this.id}`, { body });
    return this.applyJSON(json);
  }

  async destroy(): Promise<void> {
    await this.fapi.del(`/v1/client/organizations/${this.id}`);
  }

  async setLogo(params: { file: Blob; uploaderUserId?: string }): Promise<this> {
    const formData = new FormData();
    formData.append("file", params.file);
    if (params.uploaderUserId) formData.append("uploader_user_id", params.uploaderUserId);
    const json = await fetchData<OrganizationJSON>(this.fapi, "PUT", `/v1/client/organizations/${this.id}/logo`, { formData });
    return this.applyJSON(json);
  }

  async removeLogo(): Promise<this> {
    const json = await fetchData<OrganizationJSON>(this.fapi, "DELETE", `/v1/client/organizations/${this.id}/logo`);
    return this.applyJSON(json);
  }

  async getMemberships(
    params: PaginationParams & { role?: string } = {},
  ): Promise<PaginatedResponse<OrganizationMembership>> {
    return fetchPaginated(
      this.fapi,
      `/v1/client/organizations/${this.id}/memberships`,
      { query: { ...paginationQuery(params), role: params.role, paginated: true } },
      (item) => OrganizationMembership.fromJSON(this.fapi, item as OrganizationMembershipJSON),
    );
  }

  async addMember(params: { userId: string; role: string }): Promise<OrganizationMembership> {
    const json = await fetchData<OrganizationMembershipJSON>(this.fapi, "POST", `/v1/client/organizations/${this.id}/memberships`, {
      body: { user_id: params.userId, role: params.role },
    });
    return OrganizationMembership.fromJSON(this.fapi, json);
  }

  async inviteMember(params: { emailAddress: string; role: string; redirectUrl?: string }): Promise<OrganizationInvitation> {
    const json = await fetchData<OrganizationInvitationJSON>(this.fapi, "POST", `/v1/client/organizations/${this.id}/invitations`, {
      body: { email_address: params.emailAddress, role: params.role, redirect_url: params.redirectUrl },
    });
    return OrganizationInvitation.fromJSON(this.fapi, json, this.id);
  }

  async inviteMembers(params: { emailAddresses: string[]; role: string; redirectUrl?: string }): Promise<OrganizationInvitation[]> {
    const json = await fetchData<OrganizationInvitationJSON[]>(this.fapi, "POST", `/v1/client/organizations/${this.id}/invitations`, {
      body: { email_addresses: params.emailAddresses, role: params.role, redirect_url: params.redirectUrl },
    });
    return (json ?? []).map((invitation) => OrganizationInvitation.fromJSON(this.fapi, invitation, this.id));
  }

  async getInvitations(params: { status?: string; limit?: number; offset?: number } = {}): Promise<OrganizationInvitation[]> {
    return fetchList(
      this.fapi,
      `/v1/client/organizations/${this.id}/invitations`,
      { query: { status: params.status, limit: params.limit, offset: params.offset } },
      (item) => OrganizationInvitation.fromJSON(this.fapi, item as OrganizationInvitationJSON, this.id),
    );
  }

  async getDomains(): Promise<OrganizationDomain[]> {
    return fetchList(this.fapi, `/v1/client/organizations/${this.id}/domains`, {}, (item) =>
      OrganizationDomain.fromJSON(this.fapi, item as OrganizationDomainJSON, this.id),
    );
  }

  async createDomain(params: { name: string; enrollmentMode?: string }): Promise<OrganizationDomain> {
    const json = await fetchData<OrganizationDomainJSON>(this.fapi, "POST", `/v1/client/organizations/${this.id}/domains`, {
      body: { name: params.name, enrollment_mode: params.enrollmentMode },
    });
    return OrganizationDomain.fromJSON(this.fapi, json, this.id);
  }

  async getMembershipRequests(): Promise<OrganizationMembershipRequest[]> {
    return fetchList(this.fapi, `/v1/client/organizations/${this.id}/membership_requests`, {}, (item) =>
      OrganizationMembershipRequest.fromJSON(this.fapi, item as OrganizationMembershipRequestJSON, this.id),
    );
  }

  async requestMembership(): Promise<OrganizationMembershipRequest> {
    const json = await fetchData<OrganizationMembershipRequestJSON>(this.fapi, "POST", `/v1/client/organizations/${this.id}/membership_requests`, {
      body: {},
    });
    return OrganizationMembershipRequest.fromJSON(this.fapi, json, this.id);
  }

  async getRoles(): Promise<Role[]> {
    return fetchList(this.fapi, `/v1/client/organizations/${this.id}/roles`, {}, (item) => Role.fromJSON(item as RoleJSON));
  }

  /** The organization's billing portal. Requires the `org:sys_billing:manage` permission. */
  async getBilling(): Promise<OrganizationBilling> {
    const json = await fetchData<OrganizationBillingJSON>(this.fapi, "GET", `/v1/client/organizations/${this.id}/billing`);
    return { organizationId: json.organization_id, portalUrl: json.portal_url ?? null };
  }
}

export class OrganizationMembership {
  readonly object = "organization_membership" as const;
  id: string;
  role: string;
  roleName: string;
  permissions: string[];
  publicMetadata: Metadata;
  organization: Organization;
  publicUserData: OrganizationPublicUserData;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: OrganizationMembershipJSON,
    private readonly organizationId?: string,
  ) {
    this.id = json.id;
    this.role = json.role;
    this.roleName = json.role_name;
    this.permissions = json.permissions ?? [];
    this.publicMetadata = json.public_metadata ?? {};
    this.organization = Organization.fromJSON(fapi, json.organization);
    this.publicUserData = mapOrganizationPublicUserData(json.public_user_data);
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: OrganizationMembershipJSON, organizationId?: string): OrganizationMembership {
    return new OrganizationMembership(fapi, json, organizationId);
  }

  get userId(): string {
    return this.publicUserData.userId;
  }

  async update(params: { role: string }): Promise<this> {
    const orgId = this.organizationId ?? this.organization.id;
    const json = await fetchData<OrganizationMembershipJSON>(
      this.fapi,
      "PATCH",
      `/v1/client/organizations/${orgId}/memberships/${this.userId}`,
      { body: { role: params.role } },
    );
    this.role = json.role;
    this.roleName = json.role_name;
    this.permissions = json.permissions ?? [];
    this.updatedAt = json.updated_at;
    return this;
  }

  async destroy(): Promise<void> {
    const orgId = this.organizationId ?? this.organization.id;
    await this.fapi.del(`/v1/client/organizations/${orgId}/memberships/${this.userId}`);
  }
}
