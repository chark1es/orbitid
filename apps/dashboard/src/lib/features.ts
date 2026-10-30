import { useInstance } from "./instance";

export interface OrganizationsFeature {
  /** `true` once the instance has organizations turned on. `undefined` while settings are still loading or failed to load. */
  enabled: boolean | undefined;
  isLoading: boolean;
}

/**
 * Whether the instance has organizations turned on (`organizations.enabled`).
 * An unknown state (loading, or settings failed to load) is reported as `undefined`, so callers can avoid
 * flashing a locked screen at an operator whose organizations are in fact on.
 */
export function useOrganizationsFeature(): OrganizationsFeature {
  const instance = useInstance();
  const enabled = instance.data?.organizations?.enabled;
  return { enabled: typeof enabled === "boolean" ? enabled : undefined, isLoading: instance.isLoading };
}

/** True only after organizations are confirmed enabled. Use for nav entries and tabs that should disappear when off. */
export function useShowOrganizations(): boolean {
  return useOrganizationsFeature().enabled === true;
}
