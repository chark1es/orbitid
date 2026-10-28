/** Organization routes: Frontend API (`/v1/client/me/*`, `/v1/client/organizations/*`) and Backend API (`/v1/organizations/*`). */
import { arr, deletedObject, obj, ref } from "../schema";
import { backendListParams, idPath, op, paginatedParam, pathParam, queryParam, type DocumentedOperation } from "../operation";
import * as body from "../requests";
import { fapiOk, ok } from "./common";

const orgId = pathParam("id", "Organization id (`org_…`).");
const userId = pathParam("userId", "User id (`user_…`) of the membership.");
const invId = pathParam("invId", "Organization invitation id (`orginv_…`).");
const did = pathParam("did", "Organization domain id (`orgdom_…`).");
const rid = pathParam("rid", "Membership request id (`orgreq_…`).");

const paginatedList = (item: ReturnType<typeof ref>) => ({
  success: {
    status: 200 as const,
    schema: obj(
      { response: arr(item), data: arr(item), total_count: { type: "integer" } },
      { description: "`{ response: [...] }`, or `{ data, total_count }` when `?paginated=true`." },
    ),
  },
});

export const organizationPaths: DocumentedOperation[] = [
  // ───────────── the user's own memberships and invitations ─────────────
  op("get", "/v1/client/me/organization_memberships", "Organizations", "listMyOrganizationMemberships", "List my organization memberships", {
    security: "frontend",
    description: "Sorted with the active organization first. Supports `?paginated=true` for `{ data, total_count }`.",
    parameters: [paginatedParam],
    ...paginatedList(ref("OrganizationMembership")),
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/organization_memberships", "Organizations", "joinOrganization", "Join an organization", {
    security: "frontend",
    description: "Only works for organizations with a pending suggestion for this user.",
    body: { schema: body.membershipJoin },
    ...fapiOk(ref("OrganizationMembership")),
    errors: [403, 404, 409, 422],
  }),
  op("delete", "/v1/client/me/organization_memberships/{orgId}", "Organizations", "leaveOrganization", "Leave an organization", {
    security: "frontend",
    description: "The last admin cannot leave (`last_admin_cannot_leave`).",
    parameters: [pathParam("orgId", "Organization id.")],
    ...fapiOk(deletedObject("organization_membership")),
    errors: [403, 404],
  }),
  op("get", "/v1/client/me/organization_invitations", "Invitations", "listMyOrganizationInvitations", "List my organization invitations", {
    security: "frontend",
    parameters: [paginatedParam],
    ...paginatedList(ref("OrganizationInvitation")),
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/organization_invitations/{id}/accept", "Invitations", "acceptMyOrganizationInvitation", "Accept an organization invitation", {
    security: "frontend",
    description: "The invitation's email must match a verified address of the signed-in user.",
    parameters: [idPath],
    ...fapiOk(ref("OrganizationMembership")),
    errors: [403, 404, 409],
  }),
  op("get", "/v1/client/me/organization_suggestions", "Organizations", "listMyOrganizationSuggestions", "List suggested organizations", {
    security: "frontend",
    description: "Organizations that match one of the user's verified email domains.",
    parameters: [paginatedParam],
    ...paginatedList(ref("OrganizationSuggestion")),
    errors: [403, 404],
  }),
  op("post", "/v1/client/me/organization_suggestions/{id}/accept", "Organizations", "acceptMyOrganizationSuggestion", "Join a suggested organization", {
    security: "frontend",
    parameters: [idPath],
    ...fapiOk(ref("OrganizationMembership")),
    errors: [403, 404, 409],
  }),

  // ───────────── organizations (Frontend API) ─────────────
  op("post", "/v1/client/organizations", "Organizations", "createOrganization", "Create an organization", {
    security: "frontend",
    description: "The creator becomes the first admin. A free `slug` is derived from the name when omitted; a taken slug returns 409.",
    body: { schema: body.organizationCreate },
    ...fapiOk(ref("Organization")),
    errors: [403, 409, 422],
  }),
  op("get", "/v1/client/organizations/{id}", "Organizations", "getOrganization", "Read an organization", {
    security: "frontend",
    description: "Requires a membership in the organization.",
    parameters: [orgId],
    ...fapiOk(ref("Organization")),
    errors: [403, 404],
  }),
  op("patch", "/v1/client/organizations/{id}", "Organizations", "updateOrganization", "Update an organization", {
    security: "frontend",
    description: "Requires the `org:sys_profile:manage` permission.",
    parameters: [orgId],
    body: { schema: body.organizationUpdate },
    ...fapiOk(ref("Organization")),
    errors: [403, 404, 409, 422],
  }),
  op("delete", "/v1/client/organizations/{id}", "Organizations", "deleteOrganizationFrontend", "Delete an organization", {
    security: "frontend",
    description: "Requires `org:sys_profile:delete`, and the organization must allow admin deletion.",
    parameters: [orgId],
    ...fapiOk(deletedObject("organization")),
    errors: [403, 404],
  }),
  op("put", "/v1/client/organizations/{id}/logo", "Organizations", "setOrganizationLogo", "Upload an organization logo", {
    security: "frontend",
    description: "`multipart/form-data` with a `file` field, or JSON with a base64 `file`. Requires `org:sys_profile:manage`.",
    parameters: [orgId],
    body: { schema: body.imageUpload, contentType: "multipart/form-data" },
    ...fapiOk(ref("Organization")),
    errors: [403, 404, 422],
  }),
  op("delete", "/v1/client/organizations/{id}/logo", "Organizations", "deleteOrganizationLogo", "Remove an organization logo", {
    security: "frontend",
    parameters: [orgId],
    ...fapiOk(ref("Organization")),
    errors: [403, 404],
  }),

  // memberships
  op("get", "/v1/client/organizations/{id}/memberships", "Organizations", "listOrganizationMemberships", "List members", {
    security: "frontend",
    description: "Requires `org:sys_memberships:read`. Filters: `query`, `role`; sort with `order_by`.",
    parameters: [orgId, paginatedParam, queryParam("query", { type: "string" }, "Match on name, identifier or user id."), queryParam("role", { type: "string" }, "Only memberships with this role key.")],
    ...paginatedList(ref("OrganizationMembership")),
    errors: [403, 404],
  }),
  op("patch", "/v1/client/organizations/{id}/memberships/{userId}", "Organizations", "updateOrganizationMembership", "Change a member's role", {
    security: "frontend",
    description: "Requires `org:sys_memberships:manage`. The last admin cannot be demoted.",
    parameters: [orgId, userId],
    body: { schema: body.membershipRole },
    ...fapiOk(ref("OrganizationMembership")),
    errors: [403, 404, 422],
  }),
  op("delete", "/v1/client/organizations/{id}/memberships/{userId}", "Organizations", "removeOrganizationMembership", "Remove a member", {
    security: "frontend",
    description: "Requires `org:sys_memberships:manage`. The last admin cannot be removed.",
    parameters: [orgId, userId],
    ...fapiOk(deletedObject("organization_membership")),
    errors: [403, 404],
  }),

  // invitations
  op("get", "/v1/client/organizations/{id}/invitations", "Invitations", "listOrganizationInvitations", "List organization invitations", {
    security: "frontend",
    description: "Requires `org:sys_memberships:read`. Filter by `status`; sort with `order_by`.",
    parameters: [orgId, paginatedParam, queryParam("status", { type: "string", enum: ["pending", "accepted", "revoked", "expired"] })],
    ...paginatedList(ref("OrganizationInvitation")),
    errors: [403, 404],
  }),
  op("post", "/v1/client/organizations/{id}/invitations", "Invitations", "createOrganizationInvitation", "Invite people to an organization", {
    security: "frontend",
    description:
      "Requires `org:sys_memberships:manage`. Send `email_address` for one invitation or `email_addresses` for a " +
      "batch; with a batch the response is an array and existing members are skipped. Sends the invitation email.",
    parameters: [orgId],
    body: { schema: body.organizationInvite },
    success: { status: 200, schema: obj({ response: ref("OrganizationInvitation") }, { description: "One invitation, or an array when `email_addresses` was sent." }) },
    errors: [403, 404, 409, 422, 429],
  }),
  op("post", "/v1/client/organizations/{id}/invitations/{invId}/revoke", "Invitations", "revokeOrganizationInvitationFrontend", "Revoke an invitation", {
    security: "frontend",
    parameters: [orgId, invId],
    ...fapiOk(ref("OrganizationInvitation")),
    errors: [403, 404],
  }),

  // domains
  op("get", "/v1/client/organizations/{id}/domains", "Organizations", "listOrganizationDomains", "List domains", {
    security: "frontend",
    description: "Requires `org:sys_domains:read`, and domains must be enabled on the instance.",
    parameters: [orgId, paginatedParam],
    ...paginatedList(ref("OrganizationDomain")),
    errors: [403, 404],
  }),
  op("post", "/v1/client/organizations/{id}/domains", "Organizations", "createOrganizationDomain", "Add a domain", {
    security: "frontend",
    description: "Requires `org:sys_domains:manage`. The domain starts unverified; verify it with the affiliation endpoints.",
    parameters: [orgId],
    body: { schema: body.domainCreate },
    ...fapiOk(ref("OrganizationDomain")),
    errors: [403, 404, 409, 422],
  }),
  op("get", "/v1/client/organizations/{id}/domains/{did}", "Organizations", "getOrganizationDomain", "Read a domain", {
    security: "frontend",
    parameters: [orgId, did],
    ...fapiOk(ref("OrganizationDomain")),
    errors: [403, 404],
  }),
  op("delete", "/v1/client/organizations/{id}/domains/{did}", "Organizations", "deleteOrganizationDomain", "Delete a domain", {
    security: "frontend",
    parameters: [orgId, did],
    ...fapiOk(deletedObject("organization_domain")),
    errors: [403, 404],
  }),
  op("post", "/v1/client/organizations/{id}/domains/{did}/prepare_affiliation_verification", "Organizations", "prepareDomainAffiliation", "Send a domain affiliation code", {
    security: "frontend",
    description: "Sends a code to the affiliation address, which must be on the domain.",
    parameters: [orgId, did],
    body: { schema: body.affiliationStart },
    ...fapiOk(ref("OrganizationDomain")),
    errors: [403, 404, 422, 429],
  }),
  op("post", "/v1/client/organizations/{id}/domains/{did}/attempt_affiliation_verification", "Organizations", "attemptDomainAffiliation", "Verify a domain affiliation", {
    security: "frontend",
    parameters: [orgId, did],
    body: { schema: body.affiliationAttempt },
    ...fapiOk(ref("OrganizationDomain")),
    errors: [403, 404, 422, 429],
  }),
  op("post", "/v1/client/organizations/{id}/domains/{did}/update_enrollment_mode", "Organizations", "updateDomainEnrollment", "Change a domain's enrollment mode", {
    security: "frontend",
    description: "`delete_pending` revokes pending invitations that the domain created before the mode changes.",
    parameters: [orgId, did],
    body: { schema: body.domainEnrollment },
    ...fapiOk(ref("OrganizationDomain")),
    errors: [403, 404, 422],
  }),

  // membership requests
  op("get", "/v1/client/organizations/{id}/membership_requests", "Organizations", "listOrganizationMembershipRequests", "List membership requests", {
    security: "frontend",
    description: "Requires `org:sys_memberships:read`. Filter by `status`.",
    parameters: [orgId, queryParam("status", { type: "string", enum: ["pending", "accepted", "rejected"] })],
    ...fapiOk(arr(ref("OrganizationMembershipRequest"))),
    errors: [403, 404],
  }),
  op("post", "/v1/client/organizations/{id}/membership_requests", "Organizations", "createOrganizationMembershipRequest", "Request to join an organization", {
    security: "frontend",
    parameters: [orgId],
    body: { schema: body.membershipRequestStatus.partial({ status: true }) },
    ...fapiOk(ref("OrganizationMembershipRequest")),
    errors: [403, 404, 409, 422],
  }),
  op("post", "/v1/client/organizations/{id}/membership_requests/{rid}/accept", "Organizations", "acceptOrganizationMembershipRequest", "Accept a membership request", {
    security: "frontend",
    description: "Requires `org:sys_memberships:manage`.",
    parameters: [orgId, rid],
    ...fapiOk(ref("OrganizationMembership")),
    errors: [403, 404, 409],
  }),
  op("post", "/v1/client/organizations/{id}/membership_requests/{rid}/reject", "Organizations", "rejectOrganizationMembershipRequest", "Reject a membership request", {
    security: "frontend",
    description: "Requires `org:sys_memberships:manage`.",
    parameters: [orgId, rid],
    ...fapiOk(ref("OrganizationMembershipRequest")),
    errors: [403, 404],
  }),

  op("get", "/v1/client/organizations/{id}/roles", "Organizations", "listOrganizationRoles", "List assignable roles", {
    security: "frontend",
    description: "Every role with its permissions, for the member role dropdown.",
    parameters: [orgId],
    ...fapiOk(arr(ref("Role"))),
    errors: [403, 404],
  }),

  // ───────────── organizations (Backend API) ─────────────
  op("get", "/v1/organizations", "Organizations", "listOrganizations", "List organizations", {
    security: "backend",
    description: "Filters: `query`, `organization_id[]`, `user_id[]`. `include_members_count=false` skips the two count queries.",
    parameters: [...backendListParams, paginatedParam, queryParam("query", { type: "string" }), queryParam("include_members_count", { type: "string", enum: ["true", "false"] })],
    success: { status: 200, schema: obj({ data: arr(ref("Organization")), total_count: { type: "integer" } }) },
    errors: [429],
  }),
  op("post", "/v1/organizations", "Organizations", "createOrganizationBackend", "Create an organization", {
    security: "backend",
    description: "`created_by` becomes the creator and first admin. Metadata is stored as given.",
    body: { schema: body.backendOrganizationCreate },
    ...ok(ref("Organization")),
    errors: [404, 409, 422],
  }),
  op("get", "/v1/organizations/{id}", "Organizations", "getOrganizationBackend", "Read an organization", {
    security: "backend",
    parameters: [orgId],
    ...ok(ref("Organization")),
    errors: [404],
  }),
  op("patch", "/v1/organizations/{id}", "Organizations", "updateOrganizationBackend", "Update an organization", {
    security: "backend",
    parameters: [orgId],
    body: { schema: body.backendOrganizationUpdate },
    ...ok(ref("Organization")),
    errors: [404, 409, 422],
  }),
  op("patch", "/v1/organizations/{id}/metadata", "Organizations", "updateOrganizationMetadata", "Merge organization metadata", {
    security: "backend",
    description: "Deep-merges both metadata objects; a `null` value deletes the key.",
    parameters: [orgId],
    body: { schema: body.metadataPatch },
    ...ok(ref("Organization")),
    errors: [404, 422],
  }),
  op("delete", "/v1/organizations/{id}", "Organizations", "deleteOrganization", "Delete an organization", {
    security: "backend",
    description: "Deletes the organization with its memberships, invitations and domains.",
    parameters: [orgId],
    success: { status: 200, schema: deletedObject("organization") },
    errors: [404],
  }),
  op("put", "/v1/organizations/{id}/logo", "Organizations", "setOrganizationLogoBackend", "Upload an organization logo", {
    security: "backend",
    description: "`multipart/form-data` with a `file` field, or JSON with a base64 `file`.",
    parameters: [orgId],
    body: { schema: body.imageUpload, contentType: "multipart/form-data" },
    ...ok(ref("Organization")),
    errors: [404, 422],
  }),
  op("delete", "/v1/organizations/{id}/logo", "Organizations", "deleteOrganizationLogoBackend", "Remove an organization logo", {
    security: "backend",
    parameters: [orgId],
    ...ok(ref("Organization")),
    errors: [404],
  }),

  op("get", "/v1/organizations/{id}/memberships", "Organizations", "listOrganizationMembershipsBackend", "List members", {
    security: "backend",
    description: "Filters: `query`, `role`, `user_id[]`; sort with `order_by`.",
    parameters: [orgId, ...backendListParams, paginatedParam, queryParam("role", { type: "string" })],
    success: { status: 200, schema: obj({ data: arr(ref("OrganizationMembership")), total_count: { type: "integer" } }) },
    errors: [404],
  }),
  op("post", "/v1/organizations/{id}/memberships", "Organizations", "createOrganizationMembership", "Add a member", {
    security: "backend",
    description: "`role` defaults to the instance's default role. Capacity limits apply (`409`).",
    parameters: [orgId],
    body: { schema: body.backendMembershipCreate },
    ...ok(ref("OrganizationMembership")),
    errors: [404, 409, 422],
  }),
  op("patch", "/v1/organizations/{id}/memberships/{userId}", "Organizations", "updateOrganizationMembershipBackend", "Update a membership", {
    security: "backend",
    description: "Changes the role and deep-merges metadata. The last admin cannot be demoted.",
    parameters: [orgId, userId],
    body: { schema: body.backendMembershipUpdate },
    ...ok(ref("OrganizationMembership")),
    errors: [403, 404, 422],
  }),
  op("patch", "/v1/organizations/{id}/memberships/{userId}/metadata", "Organizations", "updateOrganizationMembershipMetadata", "Merge membership metadata", {
    security: "backend",
    parameters: [orgId, userId],
    body: { schema: body.metadataPatch },
    ...ok(ref("OrganizationMembership")),
    errors: [404, 422],
  }),
  op("delete", "/v1/organizations/{id}/memberships/{userId}", "Organizations", "deleteOrganizationMembership", "Remove a member", {
    security: "backend",
    parameters: [orgId, userId],
    success: { status: 200, schema: deletedObject("organization_membership") },
    errors: [403, 404],
  }),

  op("get", "/v1/organizations/{id}/invitations", "Invitations", "listOrganizationInvitationsBackend", "List organization invitations", {
    security: "backend",
    parameters: [orgId, ...backendListParams, queryParam("status", { type: "string" })],
    success: { status: 200, schema: obj({ data: arr(ref("OrganizationInvitation")), total_count: { type: "integer" } }) },
    errors: [404],
  }),
  op("post", "/v1/organizations/{id}/invitations", "Invitations", "createOrganizationInvitationBackend", "Invite someone to an organization", {
    security: "backend",
    description: "`notify=false` skips the email and returns the invitation `url` instead.",
    parameters: [orgId],
    body: { schema: body.backendInvitationCreate },
    ...ok(ref("OrganizationInvitation")),
    errors: [404, 409, 422],
  }),
  op("post", "/v1/organizations/{id}/invitations/bulk", "Invitations", "createOrganizationInvitationsBulk", "Invite several people at once", {
    security: "backend",
    description: "Existing members and already-invited addresses are skipped; the response is the array of created invitations.",
    parameters: [orgId],
    body: { schema: body.backendInvitationBulk },
    ...ok(arr(ref("OrganizationInvitation"))),
    errors: [404, 422],
  }),
  op("get", "/v1/organizations/{id}/invitations/{invId}", "Invitations", "getOrganizationInvitation", "Read an invitation", {
    security: "backend",
    parameters: [orgId, invId],
    ...ok(ref("OrganizationInvitation")),
    errors: [404],
  }),
  op("post", "/v1/organizations/{id}/invitations/{invId}/revoke", "Invitations", "revokeOrganizationInvitation", "Revoke an invitation", {
    security: "backend",
    parameters: [orgId, invId],
    ...ok(ref("OrganizationInvitation")),
    errors: [404],
  }),

  op("get", "/v1/organizations/{id}/domains", "Organizations", "listOrganizationDomainsBackend", "List domains", {
    security: "backend",
    parameters: [orgId, ...backendListParams],
    success: { status: 200, schema: obj({ data: arr(ref("OrganizationDomain")), total_count: { type: "integer" } }) },
    errors: [404],
  }),
  op("post", "/v1/organizations/{id}/domains", "Organizations", "createOrganizationDomainBackend", "Add a domain", {
    security: "backend",
    parameters: [orgId],
    body: { schema: body.backendDomainCreate },
    ...ok(ref("OrganizationDomain")),
    errors: [404, 409, 422],
  }),
  op("get", "/v1/organizations/{id}/domains/{did}", "Organizations", "getOrganizationDomainBackend", "Read a domain", {
    security: "backend",
    parameters: [orgId, did],
    ...ok(ref("OrganizationDomain")),
    errors: [404],
  }),
  op("patch", "/v1/organizations/{id}/domains/{did}", "Organizations", "updateOrganizationDomain", "Update a domain", {
    security: "backend",
    description: "Changes the enrollment mode; `delete_pending` revokes pending invitations from this domain first.",
    parameters: [orgId, did],
    body: { schema: body.backendDomainUpdate },
    ...ok(ref("OrganizationDomain")),
    errors: [404, 422],
  }),
  op("delete", "/v1/organizations/{id}/domains/{did}", "Organizations", "deleteOrganizationDomainBackend", "Delete a domain", {
    security: "backend",
    parameters: [orgId, did],
    success: { status: 200, schema: deletedObject("organization_domain") },
    errors: [404],
  }),

  op("get", "/v1/organizations/{id}/membership_requests", "Organizations", "listMembershipRequestsBackend", "List membership requests", {
    security: "backend",
    parameters: [orgId, ...backendListParams, queryParam("status", { type: "string" })],
    success: { status: 200, schema: obj({ data: arr(ref("OrganizationMembershipRequest")), total_count: { type: "integer" } }) },
    errors: [404],
  }),
  op("post", "/v1/organizations/{id}/membership_requests", "Organizations", "createMembershipRequestBackend", "Create or update a membership request", {
    security: "backend",
    description: "Returns the pending request when one already exists.",
    parameters: [orgId],
    body: { schema: body.membershipRequestStatus },
    ...ok(ref("OrganizationMembershipRequest")),
    errors: [404, 422],
  }),
  op("post", "/v1/organizations/{id}/membership_requests/{rid}/accept", "Organizations", "acceptMembershipRequestBackend", "Accept a membership request", {
    security: "backend",
    parameters: [orgId, rid],
    ...ok(ref("OrganizationMembership")),
    errors: [404, 409],
  }),
  op("post", "/v1/organizations/{id}/membership_requests/{rid}/reject", "Organizations", "rejectMembershipRequestBackend", "Reject a membership request", {
    security: "backend",
    parameters: [orgId, rid],
    ...ok(ref("OrganizationMembershipRequest")),
    errors: [404],
  }),
  op("get", "/v1/organizations/{id}/roles", "Organizations", "listOrganizationRolesBackend", "List roles", {
    security: "backend",
    parameters: [orgId, ...backendListParams],
    success: { status: 200, schema: obj({ data: arr(ref("Role")), total_count: { type: "integer" } }) },
    errors: [404],
  }),

  // ───────────── roles and permissions (Backend API) ─────────────
  op("get", "/v1/roles", "Organizations", "listRoles", "List roles", {
    security: "backend",
    description: "System roles and custom roles. Filter with `query`.",
    parameters: [...backendListParams, queryParam("query", { type: "string" })],
    success: { status: 200, schema: obj({ data: arr(ref("Role")), total_count: { type: "integer" } }) },
    errors: [429],
  }),
  op("post", "/v1/roles", "Organizations", "createRole", "Create a role", {
    security: "backend",
    description: "Custom role keys must be namespaced as `org:<feature>` (or `org:<feature>:<permission>`).",
    body: { schema: body.roleCreate },
    ...ok(ref("Role")),
    errors: [409, 422],
  }),
  op("get", "/v1/roles/{id}", "Organizations", "getRole", "Read a role", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("Role")),
    errors: [404],
  }),
  op("patch", "/v1/roles/{id}", "Organizations", "updateRole", "Update a role", {
    security: "backend",
    description: "System roles cannot be modified (`403`). `permissions` replaces the whole set.",
    parameters: [idPath],
    body: { schema: body.roleUpdate },
    ...ok(ref("Role")),
    errors: [403, 404, 422],
  }),
  op("delete", "/v1/roles/{id}", "Organizations", "deleteRole", "Delete a role", {
    security: "backend",
    description: "System roles cannot be deleted.",
    parameters: [idPath],
    success: { status: 200, schema: deletedObject("role") },
    errors: [403, 404],
  }),
  op("post", "/v1/roles/{id}/permissions", "Organizations", "setRolePermissions", "Replace a role's permissions", {
    security: "backend",
    parameters: [idPath],
    body: { schema: body.rolePermissions },
    ...ok(ref("Role")),
    errors: [404, 422],
  }),
  op("delete", "/v1/roles/{id}/permissions/{permissionId}", "Organizations", "removeRolePermission", "Remove one permission from a role", {
    security: "backend",
    parameters: [idPath, pathParam("permissionId", "Permission id or key.")],
    ...ok(ref("Role")),
    errors: [404],
  }),
  op("get", "/v1/permissions", "Organizations", "listPermissions", "List permissions", {
    security: "backend",
    description: "Filter with `type` (`system` or `user`) and `query`.",
    parameters: [...backendListParams, queryParam("type", { type: "string", enum: ["system", "user"] }), queryParam("query", { type: "string" })],
    success: { status: 200, schema: obj({ data: arr(ref("Permission")), total_count: { type: "integer" } }) },
    errors: [429],
  }),
  op("post", "/v1/permissions", "Organizations", "createPermission", "Create a permission", {
    security: "backend",
    description: "Custom keys must be namespaced as `org:<feature>:<permission>`.",
    body: { schema: body.permissionCreate },
    ...ok(ref("Permission")),
    errors: [409, 422],
  }),
  op("get", "/v1/permissions/{id}", "Organizations", "getPermission", "Read a permission", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("Permission")),
    errors: [404],
  }),
  op("patch", "/v1/permissions/{id}", "Organizations", "updatePermission", "Update a permission", {
    security: "backend",
    description: "System permissions cannot be modified.",
    parameters: [idPath],
    body: { schema: body.permissionUpdate },
    ...ok(ref("Permission")),
    errors: [403, 404, 422],
  }),
  op("delete", "/v1/permissions/{id}", "Organizations", "deletePermission", "Delete a permission", {
    security: "backend",
    description: "System permissions cannot be deleted.",
    parameters: [idPath],
    success: { status: 200, schema: deletedObject("permission") },
    errors: [403, 404],
  }),
];
