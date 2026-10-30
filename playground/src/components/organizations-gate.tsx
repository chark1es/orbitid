"use client";

import { Lock } from "lucide-react";
import { useOrganizationsEnabled } from "./orbit-widgets";

/** Keeps the organization widgets behind the instance's organizations switch, with a plain way to turn it on. */
export function OrganizationsGate({ children }: { children: React.ReactNode }) {
  const enabled = useOrganizationsEnabled();
  if (enabled) return <>{children}</>;
  return (
    <div className="max-w-2xl border bg-card p-6" role="status">
      <div className="flex items-start gap-3">
        <Lock className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <div className="space-y-1">
          <h2 className="text-base">Organizations are turned off on this instance</h2>
          <p className="text-muted-foreground">
            The organization components stay locked until an operator turns organizations on. In the dashboard, open
            Configure, then Organizations, switch on Enable organizations and save. This page unlocks on the next load.
          </p>
        </div>
      </div>
    </div>
  );
}
