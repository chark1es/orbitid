import { Fragment } from "react";
import type { ReactNode } from "react";
import { useSession } from "../hooks/useSession";

export interface MultisessionAppSupportProps {
  children?: ReactNode;
}

/**
 * Remounts its subtree when the active session changes, so account-bound state
 * (forms, cached resources) cannot leak between accounts.
 */
export function MultisessionAppSupport({ children }: MultisessionAppSupportProps) {
  const { session } = useSession();
  return <Fragment key={session?.id ?? "signed-out"}>{children}</Fragment>;
}
