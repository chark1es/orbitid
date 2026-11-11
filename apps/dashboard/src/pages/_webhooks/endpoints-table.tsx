import { Button, Switch, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@orbitid/ui";
import { Eye, Pencil, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { formatDate } from "../_config/settings";
import { EmptyState, RuledTable, StatusBadge, TableSkeleton } from "../_config/ui";
import type { WebhooksController } from "./use-webhooks";

export function EndpointsTable({ ctl }: { ctl: WebhooksController }) {
  const {
    setSelected,
    setDetailId,
    query,
    endpoints,
    openCreate,
    openEdit,
    toggleEndpoint,
    openSecret,
  } = ctl;

  return (
    <section className="space-y-3">
      <div className="flex items-baseline justify-between gap-3">
        <h2 className="text-sm font-heading">Endpoints</h2>
        <p className="text-xs text-muted-foreground">An empty event selection means every event. Secrets are shown once.</p>
      </div>
      {query.isLoading ? (
        <TableSkeleton />
      ) : endpoints.length === 0 ? (
        <EmptyState
          compact
          title="No webhook endpoints"
          description="Create an endpoint to receive user, session, organization, and API key events."
          action={
            <Button size="sm" onClick={openCreate}>
              <Plus className="size-4" aria-hidden /> Add endpoint
            </Button>
          }
        />
      ) : (
        <RuledTable>
          <TableHeader>
            <TableRow>
              <TableHead>Endpoint</TableHead>
              <TableHead className="hidden xl:table-cell">Events</TableHead>
              <TableHead>Status</TableHead>
              <TableHead className="hidden xl:table-cell">Created</TableHead>
              <TableHead className="w-28 text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {endpoints.map((endpoint) => (
              <TableRow key={endpoint.id}>
                <TableCell>
                  <div className="flex min-w-0 max-w-[20rem] items-baseline gap-2 xl:max-w-[26rem]">
                    <button
                      type="button"
                      className="min-w-0 truncate text-left font-data text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                      onClick={() => setDetailId(endpoint.id)}
                    >
                      {endpoint.url}
                    </button>
                    {endpoint.description ? (
                      <span className="min-w-0 truncate text-xs text-muted-foreground">{endpoint.description}</span>
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="hidden xl:table-cell">
                  {(endpoint.event_types ?? []).length === 0 ? (
                    <span className="text-xs text-muted-foreground">All events</span>
                  ) : (
                    <span className="font-data text-xs text-muted-foreground">
                      {endpoint.event_types.length} selected
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <div className="flex items-baseline gap-2.5">
                    <Switch
                      checked={!endpoint.disabled}
                      onCheckedChange={() => void toggleEndpoint(endpoint)}
                      aria-label="Endpoint enabled"
                      className="self-center"
                    />
                    <StatusBadge status={endpoint.disabled ? "disabled" : "active"} />
                  </div>
                </TableCell>
                <TableCell className="hidden font-data text-xs text-muted-foreground xl:table-cell">{formatDate(endpoint.created_at)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <Button variant="ghost" size="icon-sm" onClick={() => setDetailId(endpoint.id)} title="Deliveries">
                      <Eye className="size-4" aria-hidden />
                      <span className="sr-only">Deliveries for {endpoint.url}</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => void openSecret(endpoint)} title="Signing secret">
                      <ShieldCheck className="size-4" aria-hidden />
                      <span className="sr-only">Signing secret for {endpoint.url}</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" onClick={() => openEdit(endpoint)} title="Edit">
                      <Pencil className="size-4" aria-hidden />
                      <span className="sr-only">Edit {endpoint.url}</span>
                    </Button>
                    <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(endpoint)} title="Delete">
                      <Trash2 className="size-4" aria-hidden />
                      <span className="sr-only">Delete {endpoint.url}</span>
                    </Button>
                  </div>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </RuledTable>
      )}
    </section>
  );
}
