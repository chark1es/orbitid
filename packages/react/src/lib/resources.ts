import type { SessionPublicUserData } from "../provider/types";

/**
 * `@orbitid/js` exposes `public_user_data` exactly as the API sends it (snake_case). Components
 * written against Clerk's camelCase resources need both spellings, so add the aliases in place.
 * Additive and idempotent.
 */
export function withPublicUserDataAliases<T extends { publicUserData?: SessionPublicUserData | null }>(
  resource: T,
): T {
  const data = resource.publicUserData;
  if (!data) return resource;
  data.userId ??= data.user_id;
  data.firstName ??= data.first_name;
  data.lastName ??= data.last_name;
  data.imageUrl ??= data.image_url;
  data.hasImage ??= data.has_image;
  return resource;
}

/** Same for `organization_suggestion.public_organization_data`. */
export function withOrganizationDataAliases<
  T extends { publicOrganizationData?: { image_url?: string; imageUrl?: string; has_image?: boolean; hasImage?: boolean } },
>(resource: T): T {
  const data = resource.publicOrganizationData;
  if (!data) return resource;
  data.imageUrl ??= data.image_url;
  data.hasImage ??= data.has_image;
  return resource;
}
