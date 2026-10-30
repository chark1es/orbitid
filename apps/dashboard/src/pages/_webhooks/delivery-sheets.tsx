import { Button, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@orbitid/ui";
import { Eye, RefreshCw, Send } from "lucide-react";
import { errorMessage, formatDate, truncate } from "../_config/settings";
import { DetailSheet, EmptyState, ErrorAlert, RuledTable, StatusBadge, TableSkeleton } from "../_config/ui";
import type { WebhooksController } from "./use-webhooks";

export function EndpointDetailSheet({ ctl }: { ctl: WebhooksController }) {
  const {
    setDetailId,
    testing,
    setBodyView,
    detail,
    deliveriesQuery,
    deliveries,
    sendTest,
    retryDelivery,
  } = ctl;

  return (
    <DetailSheet
      open={detail !== null}
      onOpenChange={(open) => !open && setDetailId(null)}
      size="lg"
      title="Delivery log"
      description={detail ? <span className="break-all font-data text-xs">{detail.url}</span> : undefined}
      footer={
        <Button variant="outline" onClick={() => setDetailId(null)}>
          Close
        </Button>
      }
    >
      {detail ? (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">A test delivery sends a user.created event.</p>
            <div className="flex items-center gap-2">
              <Button variant="outline" size="sm" onClick={() => void sendTest()} disabled={testing}>
                <Send className="size-4" aria-hidden /> {testing ? "Sending…" : "Send test event"}
              </Button>
              <Button variant="ghost" size="icon-sm" onClick={() => void deliveriesQuery.refetch()} title="Refresh">
                <RefreshCw className="size-4" aria-hidden />
                <span className="sr-only">Refresh deliveries</span>
              </Button>
            </div>
          </div>
          {deliveriesQuery.isLoading ? (
            <TableSkeleton rows={4} />
          ) : deliveriesQuery.error ? (
            <ErrorAlert error={errorMessage(deliveriesQuery.error)} onRetry={() => void deliveriesQuery.refetch()} />
          ) : deliveries.length === 0 ? (
            <EmptyState title="No deliveries yet" description="Events sent to this endpoint appear here, newest first." />
          ) : (
            <RuledTable>
              <TableHeader>
                <TableRow>
                  <TableHead>Time</TableHead>
                  <TableHead>Event</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Attempt</TableHead>
                  <TableHead className="text-right">Response</TableHead>
                  <TableHead className="w-20 text-right">Actions</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {deliveries.map((delivery) => (
                  <TableRow key={delivery.id}>
                    <TableCell
                      className="font-data text-xs text-muted-foreground"
                      title={formatDate(delivery.created_at)}
                    >
                      {new Date(delivery.created_at).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}
                    </TableCell>
                    <TableCell>
                      <code className="font-data text-xs">{delivery.event_type}</code>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={delivery.status} />
                    </TableCell>
                    <TableCell className="text-right font-data text-xs">{delivery.attempt}</TableCell>
                    <TableCell className="text-right">
                      <button
                        type="button"
                        className="font-data text-xs underline-offset-4 hover:underline disabled:no-underline disabled:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        disabled={!delivery.response_body}
                        onClick={() => setBodyView(delivery)}
                      >
                        {delivery.response_code ?? "none"}
                        {delivery.response_body ? <span className="ml-1 text-muted-foreground">({truncate(delivery.response_body, 18)})</span> : null}
                      </button>
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center justify-end gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => void retryDelivery(delivery)} title="Retry">
                          <RefreshCw className="size-4" aria-hidden />
                          <span className="sr-only">Retry delivery</span>
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => setBodyView(delivery)} title="View response">
                          <Eye className="size-4" aria-hidden />
                          <span className="sr-only">View response body</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </RuledTable>
          )}
        </div>
      ) : null}
    </DetailSheet>
  );
}

export function DeliveryBodySheet({ ctl }: { ctl: WebhooksController }) {
  const { bodyView, setBodyView, retryDelivery } = ctl;

  return (
    <DetailSheet
      open={bodyView !== null}
      onOpenChange={(open) => !open && setBodyView(null)}
      title="Delivery response"
      description={
        bodyView ? `${bodyView.event_type}, attempt ${bodyView.attempt}, status ${bodyView.status}` : undefined
      }
      footer={
        <>
          <Button variant="outline" onClick={() => setBodyView(null)}>
            Close
          </Button>
          {bodyView ? (
            <Button onClick={() => void retryDelivery(bodyView)}>
              <RefreshCw className="size-4" aria-hidden /> Retry delivery
            </Button>
          ) : null}
        </>
      }
    >
      <pre className="max-h-96 overflow-auto border border-border bg-muted/40 p-3 font-data text-xs leading-relaxed">
        {bodyView?.response_body ?? "(empty response body)"}
      </pre>
    </DetailSheet>
  );
}
