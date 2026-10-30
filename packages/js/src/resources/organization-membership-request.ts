import type { OrganizationMembershipRequestJSON } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import { mapOrganizationPublicUserData, type OrganizationPublicUserData } from "./organization-shared";

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
