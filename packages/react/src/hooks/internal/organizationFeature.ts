import type { EnvironmentResource } from "../../provider/types";

/** Older SDK adapters expose the environment payload in snake case. Unknown is disabled. */
export function organizationsEnabled(environment: EnvironmentResource | null): boolean {
  const settings = environment?.organizationSettings ?? environment?.organization_settings;
  return Boolean(settings && typeof settings === "object" && "enabled" in settings && settings.enabled === true);
}
