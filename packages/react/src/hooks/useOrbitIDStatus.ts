import { useMemo } from "react";
import { useAuth } from "./useAuth";

export interface UseOrbitIDStatusReturn {
  isLoaded: boolean;
  isSignedIn: boolean | undefined;
  status: "loading" | "signed-in" | "signed-out";
}

/** Coarse load/sign-in status for routing gates and loaders. */
export function useOrbitIDStatus(): UseOrbitIDStatusReturn {
  const { isLoaded, isSignedIn } = useAuth();
  const status: UseOrbitIDStatusReturn["status"] = !isLoaded ? "loading" : isSignedIn ? "signed-in" : "signed-out";
  return useMemo(() => ({ isLoaded, isSignedIn, status }), [isLoaded, isSignedIn, status]);
}
