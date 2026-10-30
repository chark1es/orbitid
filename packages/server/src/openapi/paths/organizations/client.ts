/** organizations paths: client. */
import { arr, deletedObject, obj, ref } from "../../schema";
import { idPath, op, paginatedParam, pathParam, queryParam, type DocumentedOperation } from "../../operation";
import * as body from "../../requests";
import { fapiOk } from "../common";
import { orgId, userId, invId, did, rid, paginatedList } from "./common";

export const operations: DocumentedOperation[] = [
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
];
