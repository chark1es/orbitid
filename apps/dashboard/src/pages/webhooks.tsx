import { useState } from "react";
import { WEBHOOK_EVENT_TYPES, type PaginatedList, type WebhookDeliveryJSON, type WebhookEndpointJSON } from "@orbitid/shared";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Alert,
  AlertDescription,
  AlertTitle,
  Badge,
  Button,
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  Input,
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
  Switch,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@orbitid/ui";
import { Eye, Pencil, Plus, RefreshCw, RotateCw, Send, ShieldCheck, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { api, useApi } from "../lib/api";
import { oneTimeSecret, unwrapList } from "./_config/data";
import {
  describeWebhookEvent,
  errorMessage,
  formatDate,
  groupWebhookEvents,
  isHttpUrl,
  truncate,
} from "./_config/settings";
import {
  CheckboxRow,
  ConfirmDialog,
  CopyButton,
  EmptyState,
  ErrorAlert,
  Field,
  PageHeader,
  SectionCard,
  SecretReveal,
  StatusBadge,
  SwitchRow,
  TableSkeleton,
} from "./_config/ui";

interface EndpointForm {
  id?: string;
  url: string;
  description: string;
  eventTypes: string[];
  allEvents: boolean;
}

const EMPTY_FORM: EndpointForm = { url: "", description: "", eventTypes: [], allEvents: true };

export default function Page() {
  const query = useApi<PaginatedList<WebhookEndpointJSON>>(["webhooks"], "/webhooks/endpoints?limit=100");
  const endpoints = unwrapList<WebhookEndpointJSON>(query.data);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [form, setForm] = useState<EndpointForm>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);
  const [selected, setSelected] = useState<WebhookEndpointJSON | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [secretEndpoint, setSecretEndpoint] = useState<WebhookEndpointJSON | null>(null);
  const [secretValue, setSecretValue] = useState<string | null>(null);
  const [secretLoading, setSecretLoading] = useState(false);
  const [rotating, setRotating] = useState(false);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [bodyView, setBodyView] = useState<WebhookDeliveryJSON | null>(null);

  const detail = endpoints.find((endpoint) => endpoint.id === detailId) ?? null;
  const deliveriesQuery = useApi<PaginatedList<WebhookDeliveryJSON>>(
    ["webhook-deliveries", detailId],
    `/webhooks/endpoints/${detailId}/deliveries?limit=50`,
    { enabled: Boolean(detailId) },
  );
  const deliveries = unwrapList<WebhookDeliveryJSON>(deliveriesQuery.data);

  const eventGroups = groupWebhookEvents();

  const openCreate = () => {
    setForm(EMPTY_FORM);
    setDialogOpen(true);
  };

  const openEdit = (endpoint: WebhookEndpointJSON) => {
    setForm({
      id: endpoint.id,
      url: endpoint.url,
      description: endpoint.description ?? "",
      eventTypes: endpoint.event_types ?? [],
      allEvents: (endpoint.event_types ?? []).length === 0,
    });
    setDialogOpen(true);
  };

  const formErrors: string[] = [];
  if (!isHttpUrl(form.url)) formErrors.push("Endpoint URL must be an http(s) URL.");
  if (!form.allEvents && form.eventTypes.length === 0) formErrors.push("Select at least one event or choose all events.");

  const toggleEvent = (event: string) => {
    setForm((current) => ({
      ...current,
      eventTypes: current.eventTypes.includes(event)
        ? current.eventTypes.filter((value) => value !== event)
        : [...current.eventTypes, event],
    }));
  };

  const toggleGroup = (events: string[], checked: boolean) => {
    setForm((current) => {
      const rest = current.eventTypes.filter((event) => !events.includes(event));
      return { ...current, eventTypes: checked ? [...rest, ...events] : rest };
    });
  };

  const saveEndpoint = async () => {
    if (formErrors.length > 0) return;
    setSaving(true);
    try {
      const body = {
        url: form.url.trim(),
        description: form.description.trim(),
        event_types: form.allEvents ? [] : form.eventTypes,
      };
      const response = await api<WebhookEndpointJSON>(form.id ? "PATCH" : "POST", form.id ? `/webhooks/endpoints/${form.id}` : "/webhooks/endpoints", body);
      await query.refetch();
      toast.success(form.id ? "Webhook endpoint updated" : "Webhook endpoint created");
      setDialogOpen(false);
      if (!form.id) {
        setSecretEndpoint(response);
        setSecretValue(oneTimeSecret(response));
        setSecretLoading(false);
      }
    } catch (error) {
      toast.error("Could not save webhook endpoint", { description: errorMessage(error) });
    } finally {
      setSaving(false);
    }
  };

  const toggleEndpoint = async (endpoint: WebhookEndpointJSON) => {
    try {
      await api("PATCH", `/webhooks/endpoints/${endpoint.id}`, { disabled: !endpoint.disabled });
      await query.refetch();
      toast.success(endpoint.disabled ? "Endpoint enabled" : "Endpoint disabled");
    } catch (error) {
      toast.error("Could not update endpoint", { description: errorMessage(error) });
    }
  };

  const deleteEndpoint = async () => {
    if (!selected) return;
    setDeleting(true);
    try {
      await api("DELETE", `/webhooks/endpoints/${selected.id}`);
      await query.refetch();
      if (detailId === selected.id) setDetailId(null);
      toast.success("Webhook endpoint deleted");
      setSelected(null);
    } catch (error) {
      toast.error("Could not delete endpoint", { description: errorMessage(error) });
    } finally {
      setDeleting(false);
    }
  };

  const openSecret = async (endpoint: WebhookEndpointJSON) => {
    setSecretEndpoint(endpoint);
    setSecretValue(endpoint.secret ?? null);
    setSecretLoading(true);
    try {
      const response = await api<{ secret?: string }>("GET", `/webhooks/endpoints/${endpoint.id}/secret`);
      setSecretValue(response.secret ?? null);
    } catch (error) {
      toast.error("Could not load signing secret", { description: errorMessage(error) });
    } finally {
      setSecretLoading(false);
    }
  };

  const rotateSecret = async () => {
    if (!secretEndpoint) return;
    setRotating(true);
    try {
      const response = await api<unknown>("PATCH", `/webhooks/endpoints/${secretEndpoint.id}`, { rotate_secret: true });
      setSecretValue(oneTimeSecret(response));
      await query.refetch();
      toast.success("Signing secret rotated", { description: "Update your receiver with the new secret." });
    } catch (error) {
      toast.error("Could not rotate signing secret", { description: errorMessage(error) });
    } finally {
      setRotating(false);
    }
  };

  const sendTest = async () => {
    if (!detail) return;
    setTesting(true);
    try {
      await api("POST", `/webhooks/endpoints/${detail.id}/test`);
      toast.success("Test event queued", { description: "A user.created test event was sent." });
      await deliveriesQuery.refetch();
    } catch (error) {
      toast.error("Could not send test event", { description: errorMessage(error) });
    } finally {
      setTesting(false);
    }
  };

  const retryDelivery = async (delivery: WebhookDeliveryJSON) => {
    if (!detail) return;
    try {
      await api("POST", `/webhooks/deliveries/${delivery.id}/retry`);
      toast.success("Retry queued");
      await deliveriesQuery.refetch();
    } catch (error) {
      toast.error("Could not retry delivery", { description: errorMessage(error) });
    }
  };

  return (
    <div className="space-y-6">
      <PageHeader
        title="Webhooks"
        description="Send signed events to your application and inspect delivery attempts. Failed deliveries retry with exponential backoff."
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" /> Add endpoint
          </Button>
        }
      />

      {query.error ? <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : null}

      <SectionCard title="Endpoints" description="Empty event selection means all events. Secrets are shown once and can be rotated.">
        {query.isLoading ? (
          <TableSkeleton />
        ) : endpoints.length === 0 ? (
          <EmptyState
            title="No webhook endpoints"
            description="Create an endpoint to receive user, session, organization, and API key events."
            action={
              <Button size="sm" onClick={openCreate}>
                <Plus className="size-4" /> Add endpoint
              </Button>
            }
          />
        ) : (
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>URL</TableHead>
                  <TableHead>Events</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Created</TableHead>
                  <TableHead className="w-40" />
                </TableRow>
              </TableHeader>
              <TableBody>
                {endpoints.map((endpoint) => (
                  <TableRow key={endpoint.id}>
                    <TableCell>
                      <button type="button" className="block max-w-xs truncate text-left font-mono text-xs hover:underline" onClick={() => setDetailId(endpoint.id)}>
                        {endpoint.url}
                      </button>
                      {endpoint.description ? <p className="max-w-xs truncate text-xs text-muted-foreground">{endpoint.description}</p> : null}
                    </TableCell>
                    <TableCell>
                      {(endpoint.event_types ?? []).length === 0 ? (
                        <Badge variant="outline">All events</Badge>
                      ) : (
                        <div className="flex flex-wrap gap-1">
                          {endpoint.event_types.slice(0, 2).map((event) => (
                            <Badge key={event} variant="secondary" className="font-mono text-[10px]">
                              {event}
                            </Badge>
                          ))}
                          {endpoint.event_types.length > 2 ? <Badge variant="secondary">+{endpoint.event_types.length - 2}</Badge> : null}
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <Switch checked={!endpoint.disabled} onCheckedChange={() => void toggleEndpoint(endpoint)} aria-label="Endpoint enabled" />
                        <StatusBadge status={endpoint.disabled ? "disabled" : "active"} />
                      </div>
                    </TableCell>
                    <TableCell className="text-xs text-muted-foreground">{formatDate(endpoint.created_at)}</TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon-sm" onClick={() => setDetailId(endpoint.id)} title="Deliveries">
                          <Eye className="size-4" />
                          <span className="sr-only">Deliveries</span>
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => void openSecret(endpoint)} title="Signing secret">
                          <ShieldCheck className="size-4" />
                          <span className="sr-only">Signing secret</span>
                        </Button>
                        <Button variant="ghost" size="icon-sm" onClick={() => openEdit(endpoint)} title="Edit">
                          <Pencil className="size-4" />
                          <span className="sr-only">Edit</span>
                        </Button>
                        <Button variant="ghost" size="icon-sm" className="text-destructive" onClick={() => setSelected(endpoint)} title="Delete">
                          <Trash2 className="size-4" />
                          <span className="sr-only">Delete</span>
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </SectionCard>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{form.id ? "Edit webhook endpoint" : "Add webhook endpoint"}</DialogTitle>
            <DialogDescription>Events are signed with the endpoint secret using Svix-compatible headers.</DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <Field label="Endpoint URL" htmlFor="webhook-url" required error={form.url && !isHttpUrl(form.url) ? "Enter an http(s) URL." : null}>
              <Input
                id="webhook-url"
                value={form.url}
                onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
                placeholder="https://example.com/webhooks/orbitid"
              />
            </Field>
            <Field label="Description" htmlFor="webhook-description">
              <Input
                id="webhook-description"
                value={form.description}
                onChange={(event) => setForm((current) => ({ ...current, description: event.target.value }))}
                placeholder="Production event receiver"
              />
            </Field>
            <SwitchRow
              label="All events"
              description="Receive every event type. Individual event subscriptions are ignored while this is on."
              checked={form.allEvents}
              onCheckedChange={(allEvents) => setForm((current) => ({ ...current, allEvents }))}
            />
            {!form.allEvents ? (
              <div className="space-y-2">
                <div className="flex items-center justify-between">
                  <p className="text-sm font-medium">Event types</p>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => setForm((current) => ({ ...current, eventTypes: [...WEBHOOK_EVENT_TYPES] }))}
                    >
                      Select all
                    </Button>
                    <Button type="button" variant="ghost" size="sm" onClick={() => setForm((current) => ({ ...current, eventTypes: [] }))}>
                      Clear
                    </Button>
                  </div>
                </div>
                <Accordion type="multiple" defaultValue={eventGroups.map((group) => group.resource)}>
                  {eventGroups.map((group) => {
                    const selectedCount = group.events.filter((event) => form.eventTypes.includes(event)).length;
                    return (
                      <AccordionItem key={group.resource} value={group.resource}>
                        <AccordionTrigger className="text-sm">
                          <span className="flex items-center gap-2">
                            {group.label}
                            <Badge variant="secondary">{selectedCount}</Badge>
                          </span>
                        </AccordionTrigger>
                        <AccordionContent>
                          <div className="space-y-1">
                            <CheckboxRow
                              label={`All ${group.label.toLowerCase()}`}
                              checked={selectedCount === group.events.length}
                              onCheckedChange={(checked) => toggleGroup(group.events, checked)}
                            />
                            {group.events.map((event) => (
                              <CheckboxRow
                                key={event}
                                label={<code className="text-xs">{event}</code>}
                                description={describeWebhookEvent(event)}
                                checked={form.eventTypes.includes(event)}
                                onCheckedChange={() => toggleEvent(event)}
                              />
                            ))}
                          </div>
                        </AccordionContent>
                      </AccordionItem>
                    );
                  })}
                </Accordion>
              </div>
            ) : null}
            {formErrors.length > 0 ? (
              <ul className="list-disc space-y-0.5 pl-5 text-xs text-destructive">
                {formErrors.map((error) => (
                  <li key={error}>{error}</li>
                ))}
              </ul>
            ) : null}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void saveEndpoint()} disabled={saving || formErrors.length > 0}>
              {saving ? "Saving…" : form.id ? "Save changes" : "Add endpoint"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={secretEndpoint !== null} onOpenChange={(open) => !open && setSecretEndpoint(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Signing secret</DialogTitle>
            <DialogDescription>Use this secret to verify the `svix-signature` header. Rotate it if it leaks.</DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            {secretLoading ? (
              <p className="py-4 text-center text-sm text-muted-foreground">Loading signing secret…</p>
            ) : secretValue ? (
              <SecretReveal value={secretValue} />
            ) : (
              <Alert>
                <AlertTitle>Secret unavailable</AlertTitle>
                <AlertDescription>Rotate the secret to generate and reveal a new one.</AlertDescription>
              </Alert>
            )}
            <div className="flex items-center justify-between rounded-lg border px-3 py-2 text-xs">
              <span className="truncate text-muted-foreground">{secretEndpoint?.url}</span>
              {secretValue ? <CopyButton value={secretValue} size="sm" variant="outline" label="Copy" /> : null}
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setSecretEndpoint(null)}>
              Close
            </Button>
            <Button variant="destructive" onClick={() => void rotateSecret()} disabled={rotating}>
              <RotateCw className="size-4" /> {rotating ? "Rotating…" : "Rotate secret"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Sheet open={detail !== null} onOpenChange={(open) => !open && setDetailId(null)}>
        <SheetContent side="right" className="w-full overflow-y-auto sm:max-w-3xl">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              Delivery log
              {detail ? <StatusBadge status={detail.disabled ? "disabled" : "active"} /> : null}
            </SheetTitle>
            <SheetDescription className="break-all font-mono">{detail?.url}</SheetDescription>
          </SheetHeader>
          {detail ? (
            <div className="space-y-4 px-4 pb-4">
              <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border p-3">
                <p className="text-xs text-muted-foreground">Test deliveries send a `user.created` event.</p>
                <div className="flex items-center gap-2">
                  <Button variant="outline" onClick={() => void sendTest()} disabled={testing}>
                    <Send className="size-4" /> {testing ? "Sending…" : "Send test event"}
                  </Button>
                  <Button variant="ghost" size="icon-sm" onClick={() => void deliveriesQuery.refetch()} title="Refresh">
                    <RefreshCw className="size-4" />
                    <span className="sr-only">Refresh</span>
                  </Button>
                </div>
              </div>
              {deliveriesQuery.isLoading ? (
                <TableSkeleton rows={4} />
              ) : deliveriesQuery.error ? (
                <ErrorAlert error={errorMessage(deliveriesQuery.error)} onRetry={() => void deliveriesQuery.refetch()} />
              ) : deliveries.length === 0 ? (
                <EmptyState title="No deliveries yet" description="Events sent to this endpoint will appear here." />
              ) : (
                <div className="rounded-lg border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Status</TableHead>
                        <TableHead>Event</TableHead>
                        <TableHead>Attempt</TableHead>
                        <TableHead>Response</TableHead>
                        <TableHead>Created</TableHead>
                        <TableHead className="w-20" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {deliveries.map((delivery) => (
                        <TableRow key={delivery.id} className={delivery.status === "failed" ? "bg-destructive/5" : undefined}>
                          <TableCell>
                            <StatusBadge status={delivery.status} />
                          </TableCell>
                          <TableCell className="font-mono text-xs">{delivery.event_type}</TableCell>
                          <TableCell>{delivery.attempt}</TableCell>
                          <TableCell>
                            <button
                              type="button"
                              className="text-left font-mono text-xs hover:underline disabled:no-underline"
                              disabled={!delivery.response_body}
                              onClick={() => setBodyView(delivery)}
                            >
                              {delivery.response_code ?? "—"}
                              {delivery.response_body ? <span className="ml-1 text-muted-foreground">({truncate(delivery.response_body, 24)})</span> : null}
                            </button>
                          </TableCell>
                          <TableCell className="text-xs text-muted-foreground">{formatDate(delivery.created_at)}</TableCell>
                          <TableCell>
                            <div className="flex items-center gap-1">
                              <Button variant="ghost" size="icon-sm" onClick={() => void retryDelivery(delivery)} title="Retry">
                                <RefreshCw className="size-4" />
                                <span className="sr-only">Retry</span>
                              </Button>
                              <Button variant="ghost" size="icon-sm" onClick={() => setBodyView(delivery)} title="View response">
                                <Eye className="size-4" />
                                <span className="sr-only">View response</span>
                              </Button>
                            </div>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              )}
            </div>
          ) : null}
          <SheetFooter>
            <Button variant="outline" onClick={() => setDetailId(null)}>
              Close
            </Button>
          </SheetFooter>
        </SheetContent>
      </Sheet>

      <Dialog open={bodyView !== null} onOpenChange={(open) => !open && setBodyView(null)}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Delivery response</DialogTitle>
            <DialogDescription>
              {bodyView?.event_type} · attempt {bodyView?.attempt} · status {bodyView?.status}
            </DialogDescription>
          </DialogHeader>
          <pre className="max-h-80 overflow-auto rounded-md border bg-muted/40 p-3 text-xs">
            {bodyView?.response_body ?? "(empty response body)"}
          </pre>
          <DialogFooter>
            <Button variant="outline" onClick={() => setBodyView(null)}>
              Close
            </Button>
            {bodyView ? (
              <Button onClick={() => void retryDelivery(bodyView)}>
                <RefreshCw className="size-4" /> Retry delivery
              </Button>
            ) : null}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={selected !== null}
        onOpenChange={(open) => {
          if (!open) setSelected(null);
        }}
        title="Delete webhook endpoint?"
        description={
          <span>
            Deliveries and the signing secret for <code>{selected?.url}</code> will be removed.
          </span>
        }
        confirmLabel="Delete endpoint"
        destructive
        loading={deleting}
        onConfirm={() => void deleteEndpoint()}
      />
    </div>
  );
}
