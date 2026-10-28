import { useCallback, useMemo } from "react";
import type { SetActiveParams, SignInResource } from "../provider/types";
import { useAuth } from "./useAuth";
import { useOrbitID } from "./useOrbitID";

export interface UseSignInReturn {
  isLoaded: boolean;
  /** `undefined` until the instance has loaded. */
  signIn: SignInResource | undefined;
  setActive(params: SetActiveParams): Promise<void>;
}

/** The in-flight sign-in attempt (`signIn.create`, `attemptFirstFactor`, …). */
export function useSignIn(): UseSignInReturn {
  const instance = useOrbitID();
  const { isLoaded: authLoaded } = useAuth();
  // `initialState` (SSR) marks auth as loaded before the instance has; creating attempts then would race the first client fetch.
  const isLoaded = authLoaded && instance.loaded;

  const setActive = useCallback(
    async (params: SetActiveParams) => {
      await instance.setActive(params);
    },
    [instance],
  );

  return useMemo(
    () => ({ isLoaded, signIn: isLoaded ? instance.signIn : undefined, setActive }),
    [isLoaded, instance, setActive],
  );
}
