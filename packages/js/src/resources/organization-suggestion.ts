import type { OrganizationSuggestionJSON } from "@orbitid/shared";
import type { FapiClient } from "../fapi";
import type { PublicOrganizationData } from "./organization-shared";

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
