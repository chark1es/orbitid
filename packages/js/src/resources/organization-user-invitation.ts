import type { Metadata, OrganizationJSON } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { Organization } from "./organization";

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
