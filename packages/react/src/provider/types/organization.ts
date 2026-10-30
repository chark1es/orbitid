import type { Metadata } from "@orbitid/shared";
import type {
  VerificationResource,
  VerificationWire,
  MembershipPublicUserData,
  PaginationQuery,
  PaginatedResult,
  ProfileImageParams,
} from "./user";

export interface OrganizationResource {
  id: string;
  name: string;
  slug: string;
  imageUrl?: string;
  hasImage?: boolean;
  membersCount?: number;
  pendingInvitationsCount?: number;
  maxAllowedMemberships?: number;
  adminDeleteEnabled?: boolean;
  publicMetadata?: Metadata;
  createdBy?: string | null;
  createdAt?: number;
  updatedAt?: number;
  update(params: { name?: string; slug?: string; publicMetadata?: Metadata }): Promise<OrganizationResource>;
  destroy(): Promise<void>;
  setLogo(params: ProfileImageParams): Promise<OrganizationResource>;
  removeLogo(): Promise<OrganizationResource>;
  getMemberships(params?: PaginationQuery): Promise<PaginatedResult<OrganizationMembershipResource>>;
  addMember(params: { userId: string; role: string }): Promise<OrganizationMembershipResource>;
  inviteMember(params: {
    emailAddress: string;
    role: string;
    redirectUrl?: string;
  }): Promise<OrganizationInvitationResource>;
  inviteMembers(params: {
    emailAddresses: string[];
    role: string;
    redirectUrl?: string;
  }): Promise<OrganizationInvitationResource[]>;
  getInvitations(params?: PaginationQuery): Promise<OrganizationInvitationResource[]>;
  createDomain(params: { name: string; enrollmentMode?: string }): Promise<OrganizationDomainResource>;
  getDomains(): Promise<OrganizationDomainResource[]>;
  getMembershipRequests(): Promise<OrganizationMembershipRequestResource[]>;
  requestMembership(): Promise<OrganizationMembershipRequestResource>;
  getRoles(params?: PaginationQuery): Promise<RoleResource[]>;
  /** `GET|POST /v1/client/organizations/:id/api_keys` (absent in older SDK builds). */
  apiKeys?: {
    list(params?: PaginationQuery): Promise<PaginatedResult<ApiKeyResource>>;
    create(params: CreateApiKeyParams): Promise<ApiKeyResource>;
  };
  [key: string]: unknown;
}

export interface OrganizationMembershipResource {
  id: string;
  role: string;
  roleName?: string;
  permissions?: string[];
  publicMetadata?: Metadata;
  organization: OrganizationResource;
  publicUserData: MembershipPublicUserData;
  userId?: string;
  createdAt?: number;
  updatedAt?: number;
  update(params: { role: string }): Promise<OrganizationMembershipResource>;
  destroy(): Promise<void>;
  [key: string]: unknown;
}

export interface OrganizationInvitationResource {
  id: string;
  emailAddress: string;
  organizationId?: string;
  role: string;
  roleName?: string;
  status: "pending" | "accepted" | "revoked" | "expired" | string;
  publicMetadata?: Metadata;
  url?: string | null;
  createdAt?: number;
  updatedAt?: number;
  revoke(): Promise<OrganizationInvitationResource>;
  [key: string]: unknown;
}

export interface UserOrganizationInvitationResource extends OrganizationInvitationResource {
  organization?: OrganizationResource | null;
  /** Denormalized organization label on `GET /me/organization_invitations`; absent on older servers. */
  organizationName?: string | null;
  organizationImageUrl?: string | null;
  accept(): Promise<UserOrganizationInvitationResource>;
}

export interface OrganizationDomainResource {
  id: string;
  organizationId?: string;
  name: string;
  enrollmentMode: "manual_invitation" | "automatic_invitation" | "automatic_suggestion" | string;
  verification?: VerificationResource | VerificationWire | null;
  affiliationEmailAddress?: string | null;
  totalPendingInvitations?: number;
  totalPendingSuggestions?: number;
  isVerified?: boolean;
  createdAt?: number;
  updatedAt?: number;
  prepareAffiliationVerification(params: {
    affiliationEmailAddress: string;
  }): Promise<OrganizationDomainResource>;
  attemptAffiliationVerification(params: { code: string }): Promise<OrganizationDomainResource>;
  updateEnrollmentMode(params: {
    enrollmentMode: string;
    deletePending?: boolean;
  }): Promise<OrganizationDomainResource>;
  delete(): Promise<void>;
  [key: string]: unknown;
}

export interface OrganizationMembershipRequestResource {
  id: string;
  organizationId?: string;
  status: "pending" | "accepted" | "rejected" | string;
  publicUserData: MembershipPublicUserData;
  createdAt?: number;
  updatedAt?: number;
  accept(): Promise<OrganizationMembershipRequestResource>;
  reject(): Promise<OrganizationMembershipRequestResource>;
  [key: string]: unknown;
}

export interface OrganizationSuggestionResource {
  id: string;
  status: "pending" | "accepted" | string;
  publicOrganizationData: {
    id: string;
    name: string;
    slug: string;
    image_url?: string;
    imageUrl?: string;
    has_image?: boolean;
    hasImage?: boolean;
  };
  createdAt?: number;
  updatedAt?: number;
  accept(): Promise<OrganizationSuggestionResource>;
  [key: string]: unknown;
}

export interface PermissionResource {
  id?: string;
  key: string;
  name?: string;
  description?: string;
  type?: "system" | "user" | string;
  [key: string]: unknown;
}

export interface RoleResource {
  id?: string;
  key: string;
  name?: string;
  description?: string;
  permissions?: PermissionResource[];
  isCreatorEligible?: boolean;
  [key: string]: unknown;
}

export interface CreateApiKeyParams {
  name: string;
  description?: string;
  scopes?: string[];
  expiration?: number | null;
  claims?: Record<string, unknown> | null;
  organizationId?: string;
}

export interface ApiKeyResource {
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
  [key: string]: unknown;
}
