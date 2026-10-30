import type { ReactNode } from "react";
import { Link } from "react-router-dom";
import { Lock } from "lucide-react";
import { Button, Skeleton } from "@orbitid/ui";
import { useOrganizationsFeature } from "../../lib/features";
import { EmptyState } from "./empty-state";
import { PageHeader } from "./page-header";

/**
 * Keeps a routed page behind its feature switch. A locked page keeps its title so the operator knows where
 * they are, says what is off, and links to the one setting that turns it on.
 */
export function RequireOrganizations({ title, children }: { title: string; children: ReactNode }) {
  const { enabled, isLoading } = useOrganizationsFeature();

  if (isLoading && enabled === undefined) {
    return (
      <div className="space-y-4" aria-busy="true">
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-48 w-full" />
      </div>
    );
  }

  if (enabled === undefined) {
    return <div className="space-y-6"><PageHeader title={title} />
      <EmptyState icon={Lock} title="Organization settings could not be loaded"
        description="Reload to check whether organizations are enabled."
        action={<Button variant="outline" onClick={() => window.location.reload()}>Reload</Button>} />
    </div>;
  }

  if (enabled === false) {
    return (
      <div className="space-y-6">
        <PageHeader title={title} />
        <div className="animate-in fade-in-0 border border-border bg-card duration-200" data-testid="feature-locked">
          <EmptyState
            icon={Lock}
            title="Organizations are turned off"
            description="Turn organizations on to manage them here. Until then, users cannot create or join them and the Backend API refuses organization requests."
            action={
              <Button asChild size="sm">
                <Link to="/settings/organizations">Open organization settings</Link>
              </Button>
            }
          />
        </div>
      </div>
    );
  }

  return <>{children}</>;
}
