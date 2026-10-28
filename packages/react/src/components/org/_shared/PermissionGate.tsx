import type { ReactNode } from "react";
import { hasPermission } from "./utils";

interface MembershipLike {
  role: string;
  permissions?: string[];
}

export interface PermissionGateProps {
  membership: MembershipLike | null | undefined;
  /** Required system permission key(s), e.g. `org:sys_profile:manage`. */
  permission: string | string[];
  /** Require every permission (default: any). */
  requireAll?: boolean;
  children: ReactNode;
  fallback?: ReactNode;
}

/**
 * Renders `children` only when the caller's membership carries the permission(s). The server
 * enforces the same permissions; this only hides controls that would always fail.
 */
export function PermissionGate({
  membership,
  permission,
  requireAll = false,
  children,
  fallback = null,
}: PermissionGateProps) {
  const required = Array.isArray(permission) ? permission : [permission];
  const allowed = requireAll
    ? required.every((key) => hasPermission(membership, key))
    : required.some((key) => hasPermission(membership, key));
  return <>{allowed ? children : fallback}</>;
}
