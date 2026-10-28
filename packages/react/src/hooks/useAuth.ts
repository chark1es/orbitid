import { useContext, useMemo } from "react";
import { AuthContext } from "../provider/contexts";
import type { AuthState } from "../provider/types";

export interface UseAuthOptions {
  /** Default `true`, matching Clerk: a `pending` session is treated as signed out. */
  treatPendingAsSignedOut?: boolean;
}

/**
 * Auth state for the active session.
 *
 * ```tsx
 * const { isLoaded, isSignedIn, userId, orgId, orgRole, has, getToken, signOut } = useAuth();
 * if (has({ permission: 'org:sys_memberships:manage' })) ...
 * ```
 */
export function useAuth(options: UseAuthOptions = {}): AuthState {
  const auth = useContext(AuthContext);
  const treatPendingAsSignedOut = options.treatPendingAsSignedOut ?? true;
  return useMemo(() => {
    if (treatPendingAsSignedOut || auth.sessionStatus !== "pending") return auth;
    return { ...auth, isSignedIn: auth.isLoaded ? true : undefined };
  }, [auth, treatPendingAsSignedOut]);
}
