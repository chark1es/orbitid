import { useState } from "react";
import { WEBHOOK_EVENT_TYPES, type PaginatedList, type WebhookDeliveryJSON, type WebhookEndpointJSON } from "@orbitid/shared";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
  Button,
  Input,
  Switch,
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
  DetailSheet,
  EmptyState,
  ErrorAlert,
  Field,
  MetaChip,
  PageHeader,
  RuledTable,
  SecretReveal,
  StatusBadge,
  SwitchRow,
  TableSkeleton,
  ValidationSummary,
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
  const [sheetOpen, setSheetOpen] = useState(false);
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
    setSheetOpen(true);
  };

  const openEdit = (endpoint: WebhookEndpointJSON) => {
    setForm({
      id: endpoint.id,
      url: endpoint.url,
      description: endpoint.description ?? "",
      eventTypes: endpoint.event_types ?? [],
      allEvents: (endpoint.event_types ?? []).length === 0,
    });
    setSheetOpen(true);
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
      setSheetOpen(false);
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
        badge={<MetaChip>{endpoints.length} {endpoints.length === 1 ? "endpoint" : "endpoints"}</MetaChip>}
        actions={
          <Button size="sm" onClick={openCreate}>
            <Plus className="size-4" aria-hidden /> Add endpoint
          </Button>
        }
      />

      {query.error ? <ErrorAlert error={errorMessage(query.error)} onRetry={() => void query.refetch()} /> : null}

      <section className="space-y-3">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold">Endpoints</h2>
          <p className="text-xs text-muted-foreground">An empty event selection means every event. Secrets are shown once.</p>
        </div>
        {query.isLoading ? (
          <TableSkeleton />
        ) : endpoints.length === 0 ? (
          <EmptyState
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
                <TableHead>Events</TableHead>
                <TableHead>Status</TableHead>
                <TableHead>Created</TableHead>
                <TableHead className="w-44 text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {endpoints.map((endpoint) => (
                <TableRow key={endpoint.id}>
                  <TableCell className="max-w-[26rem]">
                    <div className="flex min-w-0 items-baseline gap-2">
                      <button
                        type="button"
                        className="truncate text-left font-data text-xs font-medium underline-offset-4 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2"
                        onClick={() => setDetailId(endpoint.id)}
                      >
                        {endpoint.url}
                      </button>
                      {endpoint.description ? (
                        <span className="truncate text-xs text-muted-foreground">{endpoint.description}</span>
                      ) : null}
                    </div>
                  </TableCell>
                  <TableCell>
                    {(endpoint.event_types ?? []).length === 0 ? (
                      <span className="text-xs text-muted-foreground">All events</span>
                    ) : (
                      <span className="font-data text-xs text-muted-foreground">
                        {endpoint.event_types.length} selected
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2.5">
                      <Switch checked={!endpoint.disabled} onCheckedChange={() => void toggleEndpoint(endpoint)} aria-label="Endpoint enabled" />
                      <StatusBadge status={endpoint.disabled ? "disabled" : "active"} />
                    </div>
                  </TableCell>
                  <TableCell className="font-data text-xs text-muted-foreground">{formatDate(endpoint.created_at)}</TableCell>
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

      <DetailSheet
        open={sheetOpen}
        onOpenChange={setSheetOpen}
        size="lg"
        title={form.id ? "Edit webhook endpoint" : "Add webhook endpoint"}
        description="Events are signed with the endpoint secret in Svix-compatible headers."
        footer={
          <>
            <Button variant="outline" onClick={() => setSheetOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button onClick={() => void saveEndpoint()} disabled={saving || formErrors.length > 0}>
              {saving ? "Saving…" : form.id ? "Save changes" : "Add endpoint"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <Field label="Endpoint URL" htmlFor="webhook-url" required error={form.url && !isHttpUrl(form.url) ? "Enter an http(s) URL." : null}>
            <Input
              id="webhook-url"
              value={form.url}
              onChange={(event) => setForm((current) => ({ ...current, url: event.target.value }))}
              placeholder="https://example.com/webhooks/orbitid"
              className="font-data text-xs"
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
            description="Receive every event type. Individual subscriptions are ignored while this is on."
            checked={form.allEvents}
            onCheckedChange={(allEvents) => setForm((current) => ({ ...current, allEvents }))}
          />
          {!form.allEvents ? (
            <div className="space-y-2 border-t border-border pt-3">
              <div className="flex items-center justify-between gap-3">
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
                          <span className="font-data text-xs text-muted-foreground">{selectedCount}</span>
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
                              label={<code className="font-data text-xs">{event}</code>}
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
          <ValidationSummary errors={formErrors} title="Fix this before saving" />
        </div>
      </DetailSheet>

      <DetailSheet
        open={secretEndpoint !== null}
        onOpenChange={(open) => !open && setSecretEndpoint(null)}
        title="Signing secret"
        description="Verify the svix-signature header with this secret. Rotate it if it leaks."
        footer={
          <>
            <Button variant="outline" onClick={() => setSecretEndpoint(null)}>
              Close
            </Button>
            <Button variant="destructive" onClick={() => void rotateSecret()} disabled={rotating}>
              <RotateCw className="size-4" aria-hidden /> {rotating ? "Rotating…" : "Rotate secret"}
            </Button>
          </>
        }
      >
        <div className="space-y-4">
          <p className="break-all font-data text-xs text-muted-foreground">{secretEndpoint?.url}</p>
          {secretLoading ? (
            <p className="text-sm text-muted-foreground">Loading signing secret…</p>
          ) : secretValue ? (
            <>
              <SecretReveal
                value={secretValue}
                warning="Rotating this secret invalidates the old one immediately. Update your receiver before you rotate."
              />
              <div className="flex items-center justify-between gap-3 border-t border-border pt-3">
                <p className="text-xs text-muted-foreground">Copy the secret into your receiver's signature check.</p>
                <CopyButton value={secretValue} size="sm" variant="outline" label="Copy secret" />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <p className="text-sm text-muted-foreground">The server did not return the stored secret. Rotate the secret to generate a new one.</p>
            </div>
          )}
        </div>
      </DetailSheet>

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
        loading={deleting}
        onConfirm={() => void deleteEndpoint()}
      />
    </div>
  );
}
