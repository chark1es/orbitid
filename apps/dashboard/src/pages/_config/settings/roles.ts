export const SYSTEM_ROLE_KEYS = ["org:admin", "org:member"] as const;
const ROLE_SLUG = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** Custom role keys are `org:<slug>` or `app:<slug>` (no additional colons). Returns an error message or null. */
export function roleKeyError(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return "Role key is required.";
  if (!/^(org|app):/.test(trimmed)) return "Role key must start with `org:` or `app:`.";
  const prefix = trimmed.slice(0, 4);
  const slug = trimmed.slice(4);
  if (!slug) return `Add a role name after \`${prefix}\`.`;
  if (slug.includes(":")) return "Role keys cannot contain additional colons (for example `org:auditor`).";
  if (slug.startsWith("sys_")) return "Keys starting with `org:sys_` or `app:sys_` are reserved for system roles.";
  if (!ROLE_SLUG.test(slug)) return "Use lowercase letters, numbers, dashes or underscores after `org:`.";
  return null;
}

/** Custom permission keys are `org:<feature>:<action>` or `app:<feature>:<action>`. */
export function permissionKeyError(key: string): string | null {
  const trimmed = key.trim();
  if (!trimmed) return "Permission key is required.";
  const parts = trimmed.split(":");
  if (parts.length !== 3) return "Permission key must be `org:<feature>:<action>`.";
  const [prefix, feature, action] = parts as [string, string, string];
  if (prefix !== "org" && prefix !== "app") return "Permission key must start with `org:` or `app:`.";
  if (feature.startsWith("sys_")) return "Features starting with `sys_` are reserved for system permissions.";
  if (!ROLE_SLUG.test(feature)) return "Feature must use lowercase letters, numbers, dashes or underscores.";
  if (!ROLE_SLUG.test(action)) return "Action must use lowercase letters, numbers, dashes or underscores.";
  return null;
}

export const isSystemRole = (role: { key: string; is_system?: boolean }): boolean =>
  role.is_system === true || (SYSTEM_ROLE_KEYS as readonly string[]).includes(role.key);

export function permissionFeature(key: string): string {
  return key.split(":")[1] ?? "general";
}

/* ------------------------------------------------------------------------------------------------
 * Generic form helpers
 * ---------------------------------------------------------------------------------------------- */
