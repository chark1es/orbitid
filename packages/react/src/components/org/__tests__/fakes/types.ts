import { type ApiKeyJSON } from "@orbitid/shared";
import type { OrbitIDInstance, RoleResource } from "../../../../provider";

// Backend fixtures
// ---------------------------------------------------------------------------------------------

export interface FakeUser {
  id: string;
  firstName: string;
  lastName: string;
  identifier: string;
}

export interface FakeOrg {
  id: string;
  name: string;
  slug: string;
  /** `created_by` of the organization; defaults to the fake signed-in user. */
  createdBy?: string | null;
  hasImage?: boolean;
  maxAllowedMemberships?: number;
  adminDeleteEnabled?: boolean;
  /** Operator-configured billing portal served by `GET /organizations/:id/billing`. */
  billingPortalUrl?: string | null;
}

export interface FakeMember {
  userId: string;
  firstName?: string;
  lastName?: string;
  identifier: string;
  role: string;
  permissions?: string[];
  createdAt?: number;
}

export interface FakeInvitation {
  id: string;
  emailAddress: string;
  organizationId: string;
  role: string;
  createdAt?: number;
  /** Denormalized label the server adds to `GET /me/organization_invitations`. */
  organizationName?: string;
  organizationImageUrl?: string;
}

export interface FakeDomain {
  id: string;
  name: string;
  enrollmentMode: string;
  verified: boolean;
  totalPendingInvitations?: number;
  totalPendingSuggestions?: number;
}

export interface FakeSuggestion {
  id: string;
  organizationId: string;
}

export interface ApiErrorPayload {
  errors: { code: string; message: string }[];
}

export interface BackendCalls {
  navigate: string[];
  setActive: (string | null)[];
  roleUpdates: { userId: string; role: string }[];
  memberRemovals: string[];
  invites: { emailAddresses: string[]; role: string }[];
  destroyedOrganizations: string[];
  leftOrganizations: string[];
  fetch: { method: string; path: string; body: unknown }[];
}

export interface FakeBackend {
  /** When set, `GET /organizations/:id/billing` waits for it (to observe the loading state). */
  billingGate?: Promise<void>;
  self: FakeUser;
  orgs: FakeOrg[];
  members: Record<string, FakeMember[]>;
  invitations: Record<string, FakeInvitation[]>;
  userInvitations: FakeInvitation[];
  domains: Record<string, FakeDomain[]>;
  membershipRequests: Record<string, FakeMember[]>;
  suggestions: FakeSuggestion[];
  apiKeys: ApiKeyJSON[];
  activeOrgId: string | null;
  organizationSettings: Record<string, unknown>;
  roles: RoleResource[];
  membershipRequestsEnabled?: boolean;
  /** Force a specific mutation to fail (e.g. `updateRole`). */
  failMutation?: {
    updateRole?: ApiErrorPayload;
    inviteMembers?: ApiErrorPayload;
    verifyCode?: boolean;
    leaveOrganization?: ApiErrorPayload;
  };
  calls: BackendCalls;
  /** Defaults applied to the auto-generated organization. */
  orgDefaults?: Partial<FakeOrg>;
  /** Last code the fake "sent" for each domain id. */
  verificationCodes: Record<string, string>;
}

export interface FakeInstance {
  instance: OrbitIDInstance;
  backend: FakeBackend;
  notify: () => void;
  unmountListeners: () => void;
}
