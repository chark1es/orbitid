import { Button } from "@orbitid/ui";
import { Page as PageLayout } from "../components/shared/page";
import { Plus } from "lucide-react";
import { errorMessage } from "./_config/settings";
import { ErrorAlert, MetaChip, PageHeader } from "./_config/ui";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { useEnterpriseSso } from "./_enterprise-sso/use-enterprise-sso";
import { ConnectionsTable } from "./_enterprise-sso/connections-table";
import { SsoWizard } from "./_enterprise-sso/sso-wizard";
import { ConnectionDetail } from "./_enterprise-sso/connection-detail";

export default function Page() {
  const ctl = useEnterpriseSso();
  const { selected, setSelected, deleting, query, connections, openWizard, deleteConnection } = ctl;

  return (
    <PageLayout>
      <PageHeader
        title="Enterprise SSO"
        description="Domain-routed SAML 2.0 and OpenID Connect connections. Users with a matching email domain are sent to the identity provider."
        badge={<MetaChip>{connections.length} {connections.length === 1 ? "connection" : "connections"}</MetaChip>}
        actions={
          <Button size="sm" onClick={openWizard}>
            <Plus className="size-4" aria-hidden /> Connect SSO
          </Button>
        }
      />

      {query.error ? <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : null}

      <ConnectionsTable ctl={ctl} />

      <SsoWizard ctl={ctl} />

      <ConnectionDetail ctl={ctl} />

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => !open && setSelected(null)}
        title="Delete enterprise connection?"
        description={
          <span>
            Users at <strong>{selected?.domains.join(", ")}</strong> are no longer routed to this identity provider.
          </span>
        }
        confirmLabel="Delete connection"
        destructive
        pending={deleting}
        onConfirm={() => void deleteConnection()}
      />
    </PageLayout>
  );
}
