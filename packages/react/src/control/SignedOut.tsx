import type { ReactNode } from "react";
import { useAuth } from "../hooks/useAuth";

export interface SignedOutProps {
  children?: ReactNode;
}

/** Renders `children` only once loaded and signed out (never during the loading window). */
export function SignedOut({ children }: SignedOutProps) {
  const { isLoaded, isSignedIn } = useAuth();
  return isLoaded && !isSignedIn ? <>{children}</> : null;
}
