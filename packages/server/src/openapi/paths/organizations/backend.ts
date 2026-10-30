/** organizations paths: backend. */
import { arr, deletedObject, obj, ref } from "../../schema";
import { backendListParams, op, paginatedParam, queryParam, type DocumentedOperation } from "../../operation";
import * as body from "../../requests";
import { ok } from "../common";
import { orgId, userId, invId, did, rid } from "./common";

export const operations: DocumentedOperation[] = [
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
];
