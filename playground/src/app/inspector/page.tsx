import { PageHeader } from "@/components/page-header";
import { ProviderGate } from "@/components/provider-gate";
import { Inspector } from "@/components/inspector";

export default function InspectorPage() {
  return (
    <div className="space-y-8">
      <PageHeader
        title="Inspector"
        description="Read the live session: ids, organization, permissions, the decoded JWT and every check that decides access."
      />
      <ProviderGate
        title="The inspector needs a publishable key"
        description="It reads the session and token through useAuth and useSession, which need the browser SDK."
      >
        <Inspector />
      </ProviderGate>
    </div>
  );
}
