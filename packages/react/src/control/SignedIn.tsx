import type { ReactNode } from "react";
import { useAuth } from "../hooks/useAuth";

export interface SignedInProps {
  children?: ReactNode;
}

/** Renders `children` only when the instance is loaded and a session is active. */
export function SignedIn({ children }: SignedInProps) {
  const { isLoaded, isSignedIn } = useAuth();
  return isLoaded && isSignedIn ? <>{children}</> : null;
}
