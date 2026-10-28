import Link from "next/link";
import { PageHeader } from "@/components/page-header";
import { ConnectionPanel } from "@/components/connection-panel";
import { FeatureMatrix } from "@/components/feature-matrix";
import { SetupRequired } from "@/components/setup-required";
import { StatusChip } from "@/components/status-chip";
import { getInstanceStatus, loadEnvironment, loadInstanceSnapshot } from "@/lib/env";
import { buildFeatureMatrix } from "@/lib/feature-matrix";

export default async function SetupPage() {
  const [status, environment, instance] = await Promise.all([
    getInstanceStatus(),
    loadEnvironment(),
    loadInstanceSnapshot(),
  ]);

  const matrix = environment.ok ? buildFeatureMatrix(environment.environment, instance) : null;

  return (
    <div className="space-y-8">
      <PageHeader
        title="Setup"
        description={
          status.publishableKey
            ? "What this instance supports, read from its public environment. Start a flow from any row."
            : "Connect an OrbitID instance. This page then lists what it supports and links each flow."
        }
        actions={
          status.publishableKey ? (
            <Link
              href="/sign-in"
              className="inline-flex h-8 items-center rounded-md bg-primary px-3 text-sm font-medium text-primary-foreground"
            >
              Open sign-in
            </Link>
          ) : undefined
        }
      />

      <ConnectionPanel status={status} />

      {!status.publishableKey ? (
        <SetupRequired
          title="No instance connected"
          description="The test site reads the instance from the publishable key. Without it, no page can load the environment or start a sign-in."
          missing="NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY is not set"
        />
      ) : !status.publishableKeyValid ? (
        <SetupRequired
          title="The publishable key is not readable"
          description="The key must start with pk_test or pk_live and carry the Frontend API URL in its second segment."
          missing="NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY is not a valid OrbitID key"
        />
      ) : !environment.ok ? (
        <SetupRequired
          title="The instance did not answer"
          description={environment.error}
          missing={status.apiUrl}
        />
      ) : (
        <>
          <section aria-labelledby="matrix-title" className="space-y-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 id="matrix-title" className="text-lg">
                Feature matrix
              </h2>
              <div className="flex items-center gap-3 text-xs text-muted-foreground">
                <StatusChip kind="success" label="Live from /v1/client/environment" />
                {instance ? <span>Session settings read with the secret key.</span> : null}
              </div>
            </div>
            {matrix ? <FeatureMatrix sections={matrix} /> : null}
          </section>
        </>
      )}
    </div>
  );
}
