// Error helpers shared by the auth modules.
import type { ApiErrorItem } from "@orbitid/shared";
import { OrbitError } from "@orbitid/shared";

/** `app.ts` looks for a multi-item `items` array on OrbitError; typed so callers never need `as any`. */
type OrbitErrorWithItems = OrbitError & { items?: ApiErrorItem[] };

export function attachErrorItems(err: OrbitError, items: ApiErrorItem[]): OrbitError {
  (err as OrbitErrorWithItems).items = items;
  return err;
}

export const orbitErrorItems = (err: OrbitError): ApiErrorItem[] | undefined => (err as OrbitErrorWithItems).items;
