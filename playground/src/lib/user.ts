import type { User } from "@orbitid/backend";

/** The Backend API returns `email_addresses` and `primary_email_address_id`, not a joined address. */
export function primaryEmailOf(user: User): string | null {
  const addresses = user.emailAddresses ?? [];
  const primary = addresses.find((address) => address.id === user.primaryEmailAddressId);
  return primary?.emailAddress ?? addresses[0]?.emailAddress ?? null;
}
