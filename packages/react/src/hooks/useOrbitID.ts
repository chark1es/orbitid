import { useContext } from "react";
import { OrbitIDContext } from "../provider/contexts";
import type { OrbitIDInstance } from "../provider/types";

/**
 * The live `@orbitid/js` instance (`orbit.signIn`, `orbit.setActive`, `orbit.navigate`, …).
 * Throws outside `<OrbitIDProvider/>` — the Clerk `useClerk()` equivalent.
 */
export function useOrbitID(): OrbitIDInstance {
  const instance = useContext(OrbitIDContext);
  if (!instance) {
    throw new Error("[OrbitID] useOrbitID() must be used within <OrbitIDProvider/>.");
  }
  return instance;
}

/** Clerk-compatible alias for {@link useOrbitID}. */
export const useClerk = useOrbitID;
