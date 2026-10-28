import { useCallback, useMemo } from "react";
import type { SetActiveParams, SignUpResource } from "../provider/types";
import { useAuth } from "./useAuth";
import { useOrbitID } from "./useOrbitID";

export interface UseSignUpReturn {
  isLoaded: boolean;
  /** `undefined` until the instance has loaded. */
  signUp: SignUpResource | undefined;
  setActive(params: SetActiveParams): Promise<void>;
}

/** The in-flight sign-up attempt (`signUp.create`, `attemptEmailAddressVerification`, …). */
export function useSignUp(): UseSignUpReturn {
  const instance = useOrbitID();
  const { isLoaded } = useAuth();

  const setActive = useCallback(
    async (params: SetActiveParams) => {
      await instance.setActive(params);
    },
    [instance],
  );

  return useMemo(
    () => ({ isLoaded, signUp: isLoaded ? instance.signUp : undefined, setActive }),
    [isLoaded, instance, setActive],
  );
}
