import { useContext, useMemo } from "react";
import { AuthContext, SessionContext } from "../provider/contexts";
import type { SessionResource } from "../provider/types";

export interface UseSessionReturn {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  session: SessionResource | null;
}

/** The active session resource. Use `session.getToken()` for JWTs / custom templates. */
export function useSession(): UseSessionReturn {
  const session = useContext(SessionContext);
  const { isLoaded, isSignedIn } = useContext(AuthContext);
  return useMemo(() => ({ isLoaded, isSignedIn, session }), [isLoaded, isSignedIn, session]);
}
