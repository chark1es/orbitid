import { useContext, useMemo } from "react";
import { AuthContext, UserContext } from "../provider/contexts";
import type { UserResource } from "../provider/types";

export interface UseUserReturn {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  user: UserResource | null;
}

/** The signed-in user resource, plus load/sign-in flags. */
export function useUser(): UseUserReturn {
  const user = useContext(UserContext);
  const { isLoaded, isSignedIn } = useContext(AuthContext);
  return useMemo(() => ({ isLoaded, isSignedIn, user }), [isLoaded, isSignedIn, user]);
}
