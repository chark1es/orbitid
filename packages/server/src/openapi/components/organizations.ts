/**
 * Organization, membership, RBAC, invitation, and allow/blocklist schemas.
 */
import { timestamps } from "./shared";
import { arr, anyJson, bool, enm, freeObject, int, lit, nullable, obj, opt, ref, str, type Schema } from "../schema";

export const organization: Schema = obj({
  object: lit("organization"),
  id: str(),
  name: str(),
  slug: str(),
  image_url: str(),
  has_image: bool(),
  members_count: opt(int()),
  pending_invitations_count: opt(int()),
  max_allowed_memberships: int(),
  admin_delete_enabled: bool(),
  public_metadata: freeObject(),
  private_metadata: opt(freeObject({ description: "Backend API only." })),
  created_by: nullable(str()),
  ...timestamps,
});

export const organizationMembership: Schema = obj({
  object: lit("organization_membership"),
  id: str(),
  role: str({ description: "Role key, for example `org:admin` or a custom `org:billing`." }),
  role_name: str(),
  permissions: arr(str()),
  public_metadata: freeObject(),
  private_metadata: opt(freeObject({ description: "Backend API only." })),
  organization: ref("Organization"),
  public_user_data: obj({ user_id: str(), first_name: nullable(str()), last_name: nullable(str()), image_url: str(), has_image: bool(), identifier: str() }),
  ...timestamps,
});

export const organizationInvitation: Schema = obj({
  object: lit("organization_invitation"),
  id: str(),
  email_address: str({ format: "email" }),
  organization_id: str(),
  organization_name: opt(str()),
  organization_image_url: opt(str()),
  role: str(),
  role_name: str(),
  status: enm(["pending", "accepted", "revoked", "expired"]),
  public_metadata: freeObject(),
  private_metadata: opt(freeObject({ description: "Backend API only." })),
  url: opt(nullable(str({ description: "Invitation link. Backend API only, and only when no email was sent." }))),
  ...timestamps,
});

export const organizationDomain: Schema = obj({
  object: lit("organization_domain"),
  id: str(),
  organization_id: str(),
  name: str(),
  enrollment_mode: enm(["manual_invitation", "automatic_invitation", "automatic_suggestion"]),
  verification: nullable(ref("Verification")),
  affiliation_email_address: nullable(str()),
  total_pending_invitations: int(),
  total_pending_suggestions: int(),
  ...timestamps,
});

export const organizationMembershipRequest: Schema = obj({
  object: lit("organization_membership_request"),
  id: str(),
  organization_id: str(),
  status: enm(["pending", "accepted", "rejected"]),
  public_user_data: obj({ user_id: str(), first_name: nullable(str()), last_name: nullable(str()), image_url: str(), has_image: bool(), identifier: str() }),
  ...timestamps,
});

export const organizationSuggestion: Schema = obj({
  object: lit("organization_suggestion"),
  id: str(),
  public_organization_data: obj({ id: str(), name: str(), slug: str(), image_url: str(), has_image: bool() }),
  status: enm(["pending", "accepted"]),
  ...timestamps,
});

export const role: Schema = obj({
  object: lit("role"),
  id: str(),
  key: str({ example: "org:billing" }),
  name: str(),
  description: str(),
  scope: enm(["organization", "instance"], "`organization` roles are memberships; `instance` roles are attached to a user and travel in the session's `roles` claim."),
  is_system: bool({ description: "Seeded `org:admin` / `org:member`; cannot be edited, deleted or assigned as an instance role." }),
  is_creator_eligible: bool(),
  permissions: arr(ref("Permission")),
  ...timestamps,
});

export const permission: Schema = obj({
  object: lit("permission"),
  id: str(),
  key: str({ example: "org:billing:manage" }),
  name: str(),
  description: str(),
  type: enm(["system", "user"]),
  scope: enm(["organization", "instance"], "`organization` for `org:*` keys, `instance` for `app:*` keys."),
  ...timestamps,
});

export const invitation: Schema = obj({
  object: lit("invitation"),
  id: str(),
  email_address: str({ format: "email" }),
  status: enm(["pending", "accepted", "revoked", "expired"]),
  url: opt(str({ description: "Invitation link, returned when the email was not sent." })),
  public_metadata: freeObject(),
  created_at: int(),
  updated_at: int(),
  expires_at: nullable(int()),
});

export const waitlistEntry: Schema = obj({
  object: lit("waitlist_entry"),
  id: str(),
  email_address: str({ format: "email" }),
  status: enm(["pending", "invited", "completed", "rejected"]),
  invitation: nullable(ref("Invitation")),
  ...timestamps,
});

export const allowlistIdentifier: Schema = obj({
  object: lit("allowlist_identifier"),
  id: str(),
  identifier: str(),
  identifier_type: enm(["email_address", "phone_number", "web3_wallet"]),
  invitation_id: nullable(str()),
  ...timestamps,
});

export const blocklistIdentifier: Schema = obj({
  object: lit("blocklist_identifier"),
  id: str(),
  identifier: str(),
  identifier_type: enm(["email_address", "phone_number", "web3_wallet"]),
  ...timestamps,
});

export const jwtTemplate: Schema = obj({
  object: lit("jwt_template"),
  id: str(),
  name: str(),
  claims: freeObject(),
  lifetime: int({ description: "Token lifetime in seconds." }),
  allowed_clock_skew: int(),
  custom_signing_key: bool(),
  signing_algorithm: enm(["RS256", "ES256", "HS256"]),
  signing_key: opt(anyJson({ description: "Verification key for templates with a custom signing key: an HS256 secret or a public JWK." })),
  ...timestamps,
});
