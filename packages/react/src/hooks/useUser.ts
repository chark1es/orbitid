import { useContext, useMemo } from "react";
import { AuthContext, UserContext } from "../provider/contexts";
import type { UserResource } from "../provider/types";

export interface UseUserReturn {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  user: UserResource | null;
  /** True for a guest account that has not attached an email address, phone number or password yet. */
  isAnonymous: boolean;
}

/** The signed-in user resource, plus load/sign-in flags. */
export function useUser(): UseUserReturn {
  const user = useContext(UserContext);
  const { isLoaded, isSignedIn } = useContext(AuthContext);
  return useMemo(
    () => ({ isLoaded, isSignedIn, user, isAnonymous: Boolean(user?.isAnonymous ?? user?.is_anonymous) }),
    [isLoaded, isSignedIn, user],
  );
}
