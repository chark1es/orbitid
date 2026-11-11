import { Button } from "@orbitid/ui";
import { Page as PageLayout } from "../components/shared/page";
import { Plus } from "lucide-react";
import { errorMessage } from "./_config/settings";
import { ErrorAlert, MetaChip, PageHeader } from "./_config/ui";
import { ConfirmDialog } from "../components/shared/confirm-dialog";
import { useWebhooks } from "./_webhooks/use-webhooks";
import { EndpointsTable } from "./_webhooks/endpoints-table";
import { EndpointFormSheet, SecretSheet } from "./_webhooks/endpoint-sheets";
import { EndpointDetailSheet, DeliveryBodySheet } from "./_webhooks/delivery-sheets";

export default function Page() {
  const ctl = useWebhooks();
  const { selected, setSelected, deleting, query, endpoints, openCreate, deleteEndpoint } = ctl;

  return (
    <PageLayout>
      <PageHeader
        title="Webhooks"
        description="Send signed events to your application and inspect delivery attempts. Failed deliveries retry with exponential backoff."
        badge={<MetaChip>{endpoints.length} {endpoints.length === 1 ? "endpoint" : "endpoints"}</MetaChip>}
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" aria-hidden /> Add endpoint
          </Button>
        }
      />

      {query.error ? <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : null}

      <EndpointsTable ctl={ctl} />

      <EndpointFormSheet ctl={ctl} />

      <SecretSheet ctl={ctl} />

      <EndpointDetailSheet ctl={ctl} />

      <DeliveryBodySheet ctl={ctl} />

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title="Delete webhook endpoint?"
        description={
          <span>
            Deliveries and the signing secret for <code className="font-data">{selected?.url}</code> are removed.
          </span>
        }
        confirmLabel="Delete endpoint"
        destructive
        pending={deleting}
        onConfirm={() => void deleteEndpoint()}
      />
    </PageLayout>
  );
}
