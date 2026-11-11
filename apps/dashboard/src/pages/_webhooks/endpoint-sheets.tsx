import { useEffect, useState } from "react";
import { Accordion, AccordionContent, AccordionItem, AccordionTrigger, Button, Input } from "@orbitid/ui";
import { WEBHOOK_EVENT_TYPES } from "@orbitid/shared";
import { RotateCw } from "lucide-react";
import { describeWebhookEvent, isHttpUrl } from "../_config/settings";
import {
  CheckboxRow,
  CopyButton,
  DetailSheet,
  Field,
  SecretReveal,
  SwitchRow,
  ValidationSummary,
} from "../_config/ui";
import type { WebhooksController } from "./use-webhooks";

export function EndpointFormSheet({ ctl }: { ctl: WebhooksController }) {
  const {
    sheetOpen,
    setSheetOpen,
    form,
    setForm,
    saving,
    eventGroups,
    formErrors,
    toggleEvent,
    toggleGroup,
    saveEndpoint,
  } = ctl;
  const [attempted, setAttempted] = useState(false);
  useEffect(() => {
    if (!sheetOpen) setAttempted(false);
  }, [sheetOpen]);

  return (
    <DetailSheet
      open={sheetOpen}
      onOpenChange={setSheetOpen}
      title={form.id ? "Edit webhook endpoint" : "Add webhook endpoint"}
      description="Events are signed with the endpoint secret. Verify the signature header with the backend SDK."
      footer={
        <>
          <Button variant="outline" onClick={() => setSheetOpen(false)} disabled={saving}>
            Cancel
          </Button>
          <Button
            onClick={() => {
              setAttempted(true);
              if (formErrors.length === 0) void saveEndpoint();
            }}
            disabled={saving}
          >
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
        <ValidationSummary errors={attempted ? formErrors : []} title="Fix this before saving" />
      </div>
    </DetailSheet>
  );
}

export function SecretSheet({ ctl }: { ctl: WebhooksController }) {
  const { secretEndpoint, setSecretEndpoint, secretValue, secretLoading, rotating, rotateSecret } = ctl;

  return (
    <DetailSheet
      open={secretEndpoint !== null}
      onOpenChange={(open) => !open && setSecretEndpoint(null)}
      title="Signing secret"
      description="Verify the signature header with this secret. Rotate it if it leaks."
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
  );
}
