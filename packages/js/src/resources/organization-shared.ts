import type { OrganizationMembershipJSON } from "@orbitid/shared";

export interface OrganizationPublicUserData {
  userId: string;
  firstName: string | null;
  lastName: string | null;
  imageUrl: string;
  hasImage: boolean;
  identifier: string;
}

export interface PublicOrganizationData {
  id: string;
  name: string;
  slug: string;
  imageUrl: string;
  hasImage: boolean;
}

export function mapOrganizationPublicUserData(data: OrganizationMembershipJSON["public_user_data"]): OrganizationPublicUserData {
  return {
    userId: data.user_id,
    firstName: data.first_name,
    lastName: data.last_name,
    imageUrl: data.image_url,
    hasImage: data.has_image,
    identifier: data.identifier,
  };
}
