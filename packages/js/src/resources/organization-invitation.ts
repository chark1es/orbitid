import type { Metadata, OrganizationInvitationJSON } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { fetchData } from "./base";

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
