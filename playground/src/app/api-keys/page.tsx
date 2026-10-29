import { APIKeys } from "@/components/orbit-widgets";
import { PageHeader } from "@/components/page-header";
import { ProviderGate } from "@/components/provider-gate";

export default function ApiKeysPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="API keys"
        description="Create, copy and revoke keys for this user or the active organization. The secret is shown once, at creation."
      />
      <ProviderGate
        title="API keys need a publishable key"
        description="The APIKeys component reads the signed-in subject through the instance."
      >
        <div className="space-y-10">
          <section aria-labelledby="user-keys-title" className="space-y-3">
            <h2 id="user-keys-title" className="text-lg">
              User keys
            </h2>
            <APIKeys type="user" showDescription />
          </section>
          <section aria-labelledby="org-keys-title" className="space-y-3">
            <h2 id="org-keys-title" className="text-lg">
              Organization keys
            </h2>
            <p className="text-muted-foreground">
              Select an active organization on the Organizations page to manage its keys.
            </p>
            <APIKeys type="organization" showDescription />
          </section>
        </div>
      </ProviderGate>
    </div>
  );
}
