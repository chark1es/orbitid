import type {
  Metadata,
  OrganizationDomainJSON,
  OrganizationInvitationJSON,
  OrganizationJSON,
  OrganizationMembershipJSON,
  OrganizationMembershipRequestJSON,
  OrganizationSuggestionJSON,
  PermissionJSON,
  RoleJSON,
} from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { fetchData, fetchList, fetchPaginated } from "./base";
import { paginationQuery, type PaginatedResponse, type PaginationParams } from "../util/pagination";
import { ApiKey, type CreateApiKeyParams } from "./api-key";
import { Verification } from "./verification";

export class Permission {
  readonly object = "permission" as const;
  id: string;
  key: string;
  name: string;
  description: string;
  type: "system" | "user";
  createdAt: number;
  updatedAt: number;

  constructor(json: PermissionJSON) {
    this.id = json.id;
    this.key = json.key;
    this.name = json.name;
    this.description = json.description;
    this.type = json.type;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(json: PermissionJSON): Permission {
    return new Permission(json);
  }
}

export class Role {
  readonly object = "role" as const;
  id: string;
  key: string;
  name: string;
  description: string;
  isCreatorEligible: boolean;
  permissions: Permission[];
  createdAt: number;
  updatedAt: number;

  constructor(json: RoleJSON) {
    this.id = json.id;
    this.key = json.key;
    this.name = json.name;
    this.description = json.description;
    this.isCreatorEligible = json.is_creator_eligible ?? false;
    this.permissions = (json.permissions ?? []).map(Permission.fromJSON);
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(json: RoleJSON): Role {
    return new Role(json);
  }
}

export interface OrganizationPublicUserData {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string;
  hasImage: boolean;
  identifier: string;
}

export interface PublicOrganizationData {
  id: string;
  name: string;
  slug: string;
  imageUrl: string;
  hasImage: boolean;
}

function mapOrganizationPublicUserData(data: OrganizationMembershipJSON["public_user_data"]): OrganizationPublicUserData {
  return {
    userId: data.user_id,
    firstName: data.first_name,
    lastName: data.last_name,
    imageUrl: data.image_url,
    hasImage: data.has_image,
    identifier: data.identifier,
  };
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

export class OrganizationInvitation {
  readonly object = "organization_invitation" as const;
  id: string;
  emailAddress: string;
  organizationId: string;
  role: string;
  roleName: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  publicMetadata: Metadata;
  url: string | null;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: OrganizationInvitationJSON,
    organizationId?: string,
  ) {
    this.id = json.id;
    this.emailAddress = json.email_address;
    this.organizationId = json.organization_id ?? organizationId ?? "";
    this.role = json.role;
    this.roleName = json.role_name;
    this.status = json.status;
    this.publicMetadata = json.public_metadata ?? {};
    this.url = json.url ?? null;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: OrganizationInvitationJSON, organizationId?: string): OrganizationInvitation {
    return new OrganizationInvitation(fapi, json, organizationId);
  }

  async revoke(): Promise<this> {
    const json = await fetchData<OrganizationInvitationJSON>(
      this.fapi,
      "POST",
      `/v1/client/organizations/${this.organizationId}/invitations/${this.id}/revoke`,
    );
    this.status = json.status;
    this.updatedAt = json.updated_at;
    return this;
  }
}

export class OrganizationDomain {
  readonly object = "organization_domain" as const;
  id: string;
  organizationId: string;
  name: string;
  enrollmentMode: "manual_invitation" | "automatic_invitation" | "automatic_suggestion";
  verification: Verification | null;
  affiliationEmailAddress: string | null;
  totalPendingInvitations: number;
  totalPendingSuggestions: number;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: OrganizationDomainJSON,
    organizationId?: string,
  ) {
    this.id = json.id;
    this.organizationId = json.organization_id ?? organizationId ?? "";
    this.name = json.name;
    this.enrollmentMode = json.enrollment_mode;
    this.verification = Verification.fromJSON(json.verification);
    this.affiliationEmailAddress = json.affiliation_email_address ?? null;
    this.totalPendingInvitations = json.total_pending_invitations ?? 0;
    this.totalPendingSuggestions = json.total_pending_suggestions ?? 0;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: OrganizationDomainJSON, organizationId?: string): OrganizationDomain {
    return new OrganizationDomain(fapi, json, organizationId);
  }

  get isVerified(): boolean {
    return this.verification?.status === "verified";
  }

  private applyJSON(json: OrganizationDomainJSON): this {
    this.enrollmentMode = json.enrollment_mode;
    this.verification = Verification.fromJSON(json.verification) ?? this.verification;
    this.affiliationEmailAddress = json.affiliation_email_address ?? this.affiliationEmailAddress;
    this.updatedAt = json.updated_at;
    return this;
  }

  async prepareAffiliationVerification(params: { affiliationEmailAddress: string }): Promise<this> {
    const json = await fetchData<OrganizationDomainJSON>(
      this.fapi,
      "POST",
      `/v1/client/organizations/${this.organizationId}/domains/${this.id}/prepare_affiliation_verification`,
      { body: { affiliation_email_address: params.affiliationEmailAddress } },
    );
    return this.applyJSON(json);
  }

  async attemptAffiliationVerification(params: { code: string }): Promise<this> {
    const json = await fetchData<OrganizationDomainJSON>(
      this.fapi,
      "POST",
      `/v1/client/organizations/${this.organizationId}/domains/${this.id}/attempt_affiliation_verification`,
      { body: { code: params.code } },
    );
    return this.applyJSON(json);
  }

  async updateEnrollmentMode(params: { enrollmentMode: string; deletePending?: boolean }): Promise<this> {
    const json = await fetchData<OrganizationDomainJSON>(
      this.fapi,
      "POST",
      `/v1/client/organizations/${this.organizationId}/domains/${this.id}/update_enrollment_mode`,
      { body: { enrollment_mode: params.enrollmentMode, delete_pending: params.deletePending } },
    );
    return this.applyJSON(json);
  }

  async delete(): Promise<void> {
    await this.fapi.del(`/v1/client/organizations/${this.organizationId}/domains/${this.id}`);
  }
}

export class OrganizationMembershipRequest {
  readonly object = "organization_membership_request" as const;
  id: string;
  organizationId: string;
  status: "pending" | "accepted" | "rejected";
  publicUserData: OrganizationPublicUserData;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: OrganizationMembershipRequestJSON,
    organizationId?: string,
  ) {
    this.id = json.id;
    this.organizationId = json.organization_id ?? organizationId ?? "";
    this.status = json.status;
    this.publicUserData = mapOrganizationPublicUserData(json.public_user_data);
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: OrganizationMembershipRequestJSON, organizationId?: string): OrganizationMembershipRequest {
    return new OrganizationMembershipRequest(fapi, json, organizationId);
  }

  async accept(): Promise<this> {
    await this.fapi.post(`/v1/client/organizations/${this.organizationId}/membership_requests/${this.id}/accept`);
    this.status = "accepted";
    return this;
  }

  async reject(): Promise<this> {
    await this.fapi.post(`/v1/client/organizations/${this.organizationId}/membership_requests/${this.id}/reject`);
    this.status = "rejected";
    return this;
  }
}

export class OrganizationSuggestion {
  readonly object = "organization_suggestion" as const;
  id: string;
  publicOrganizationData: PublicOrganizationData;
  status: "pending" | "accepted";
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: OrganizationSuggestionJSON,
  ) {
    this.id = json.id;
    this.publicOrganizationData = {
      id: json.public_organization_data.id,
      name: json.public_organization_data.name,
      slug: json.public_organization_data.slug,
      imageUrl: json.public_organization_data.image_url,
      hasImage: json.public_organization_data.has_image,
    };
    this.status = json.status;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: OrganizationSuggestionJSON): OrganizationSuggestion {
    return new OrganizationSuggestion(fapi, json);
  }

  async accept(): Promise<this> {
    await this.fapi.post(`/v1/client/me/organization_suggestions/${this.id}/accept`);
    this.status = "accepted";
    return this;
  }
}

/** Wire shape of `GET /me/organization_invitations` (shared does not declare it: it always carries the org). */
export interface UserOrganizationInvitationWireJSON {
  object: "organization_invitation";
  id: string;
  email_address: string;
  organization_id: string;
  role: string;
  role_name: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  public_metadata: Metadata;
  organization?: OrganizationJSON;
  /** Denormalized organization label; absent on servers that only send `organization`. */
  organization_name?: string;
  organization_image_url?: string;
  created_at: number;
  updated_at: number;
}

export class UserOrganizationInvitation {
  readonly object = "organization_invitation" as const;
  id: string;
  emailAddress: string;
  organizationId: string;
  role: string;
  roleName: string;
  status: "pending" | "accepted" | "revoked" | "expired";
  publicMetadata: Metadata;
  organization: Organization | null;
  organizationName: string | null;
  organizationImageUrl: string | null;
  createdAt: number;
  updatedAt: number;

  constructor(
    private readonly fapi: FapiClient,
    json: UserOrganizationInvitationWireJSON,
  ) {
    this.id = json.id;
    this.emailAddress = json.email_address;
    this.organizationId = json.organization_id ?? json.organization?.id ?? "";
    this.role = json.role;
    this.roleName = json.role_name;
    this.status = json.status;
    this.publicMetadata = json.public_metadata ?? {};
    this.organization = json.organization ? Organization.fromJSON(fapi, json.organization) : null;
    this.organizationName = json.organization_name ?? json.organization?.name ?? null;
    this.organizationImageUrl = json.organization_image_url ?? json.organization?.image_url ?? null;
    this.createdAt = json.created_at;
    this.updatedAt = json.updated_at;
  }

  static fromJSON(fapi: FapiClient, json: UserOrganizationInvitationWireJSON): UserOrganizationInvitation {
    return new UserOrganizationInvitation(fapi, json);
  }

  async accept(): Promise<this> {
    await this.fapi.post(`/v1/client/me/organization_invitations/${this.id}/accept`);
    this.status = "accepted";
    return this;
  }
}
