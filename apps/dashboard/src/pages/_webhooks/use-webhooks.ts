import { useState } from "react";
import { type PaginatedList, type WebhookDeliveryJSON, type WebhookEndpointJSON } from "@orbitid/shared";
import { toast } from "sonner";
import { api, useApi } from "../../lib/api";
import { oneTimeSecret, unwrapList } from "../_config/data";
import { errorMessage, groupWebhookEvents, isHttpUrl } from "../_config/settings";
import { type EndpointForm, EMPTY_FORM } from "./model";

export function useWebhooks() {
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

  return {
    sheetOpen,
    setSheetOpen,
    form,
    setForm,
    saving,
    selected,
    setSelected,
    deleting,
    secretEndpoint,
    setSecretEndpoint,
    secretValue,
    secretLoading,
    rotating,
    setDetailId,
    testing,
    bodyView,
    setBodyView,
    query,
    endpoints,
    detail,
    deliveriesQuery,
    deliveries,
    eventGroups,
    openCreate,
    openEdit,
    formErrors,
    toggleEvent,
    toggleGroup,
    saveEndpoint,
    toggleEndpoint,
    deleteEndpoint,
    openSecret,
    rotateSecret,
    sendTest,
    retryDelivery,
  };
}

export type WebhooksController = ReturnType<typeof useWebhooks>;
