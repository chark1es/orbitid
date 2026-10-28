import { useCallback, useMemo } from "react";
import type {
  SessionResource,
  SetActiveParams,
  SignOutParams,
} from "../provider/types";
import { useAuth } from "./useAuth";
import { useOrbitID } from "./useOrbitID";

export interface UseSessionListReturn {
  isLoaded: boolean;
  /** Every session on this client (multi-session mode). */
  sessions: SessionResource[];
  setActive(params: SetActiveParams): Promise<void>;
  signOut(options?: SignOutParams): Promise<void>;
}

/** All sessions attached to the current client, plus activation/sign-out helpers. */
export function useSessionList(): UseSessionListReturn {
  const instance = useOrbitID();
  const { isLoaded } = useAuth();
  const sessions = instance.client?.sessions ?? [];

  const setActive = useCallback(
    async (params: SetActiveParams) => {
      await instance.setActive(params);
    },
    [instance],
  );

  const signOut = useCallback(
    async (options?: SignOutParams) => {
      await instance.signOut(options);
    },
    [instance],
  );

  return useMemo(
    () => ({ isLoaded, sessions, setActive, signOut }),
    [isLoaded, sessions, setActive, signOut],
  );
}
