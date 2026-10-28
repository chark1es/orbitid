import type { ReactNode } from "react";
import { useAuth } from "../hooks/useAuth";
import type { HasParams } from "../provider/types";

export interface ProtectProps extends HasParams {
  /** Rendered when the check fails (or while loading). */
  fallback?: ReactNode;
  children?: ReactNode;
}

/**
 * Authorization gate backed by `useAuth().has()`.
 *
 * ```tsx
 * <Protect role="org:admin" fallback={<p>Admins only</p>}>…</Protect>
 * <Protect permission="org:sys_memberships:manage">…</Protect>
 * <Protect condition={isFeatureEnabled}>…</Protect>
 * ```
 *
 * Exactly one of `role`/`permission`/`feature`/`condition`/`reverification` may be passed.
 * While the instance is loading, `fallback` is rendered (never the protected children).
 */
export function Protect({ children, fallback = null, ...params }: ProtectProps) {
  const { has, isLoaded } = useAuth();
  if (!isLoaded) return <>{fallback}</>;
  return has(params) ? <>{children}</> : <>{fallback}</>;
}
