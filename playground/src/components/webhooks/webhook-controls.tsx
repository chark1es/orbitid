"use client";

import * as React from "react";
import { Button, Input } from "@orbitid/ui";
import { CopyButton } from "../copy-button";
import { StatusChip } from "../status-chip";
import type { ActionResult } from "@/lib/action-state";
import {
  clearReceivedEvents,
  registerReceiver,
  saveWebhookSecret,
  sendTestEvent,
} from "@/app/webhooks/actions";

const INITIAL: ActionResult = { ok: false, message: "" };

function ActionFeedback({ state }: { state: ActionResult }) {
  if (!state.message) return null;
  return (
    <div className="mt-2 text-xs" role="status">
      <StatusChip kind={state.ok ? "success" : "failed"} label={state.ok ? "Done" : "Failed"} />
      <p className={`mt-1 text-sm ${state.ok ? "text-foreground" : "text-signal"}`}>{state.message}</p>
      {state.detail ? <p className="mt-0.5 text-muted-foreground">{state.detail}</p> : null}
      {state.secret ? (
        <div className="mt-2 border px-2 py-1.5">
          <div className="flex items-center justify-between gap-2">
            <span className="text-[0.6875rem] text-muted-foreground">Signing secret</span>
            <CopyButton value={state.secret} label="Copy secret" />
          </div>
          <p className="font-data mt-1 text-xs break-all">{state.secret}</p>
        </div>
      ) : null}
    </div>
  );
}

export function WebhookControls({ endpointId }: { endpointId: string | null }) {
  const [registerState, registerAction, registering] = React.useActionState(registerReceiver, INITIAL);
  const [testState, testAction, testing] = React.useActionState(sendTestEvent, INITIAL);
  const [secretState, secretAction, saving] = React.useActionState(saveWebhookSecret, INITIAL);
  const [clearState, clearAction, clearing] = React.useActionState(clearReceivedEvents, INITIAL);

  return (
    <div className="space-y-6">
      <section aria-labelledby="register-title" className="border">
        <div className="border-b px-4 py-3">
          <h2 id="register-title" className="text-base">
            Register the receiver
          </h2>
          <p className="text-xs text-muted-foreground">
            Creates an endpoint on the instance that posts every event type to this site. Each click creates a new
            endpoint, so register once per server restart.
          </p>
        </div>
        <form action={registerAction} className="px-4 py-3">
          <Button type="submit" size="sm" disabled={registering}>
            {registering ? "Registering" : "Register this site"}
          </Button>
          <ActionFeedback state={registerState} />
        </form>
      </section>

      <section aria-labelledby="test-title" className="border">
        <div className="border-b px-4 py-3">
          <h2 id="test-title" className="text-base">
            Send a test event
          </h2>
          <p className="text-xs text-muted-foreground">
            The instance delivers a user.created event to the registered endpoint and records a delivery.
          </p>
        </div>
        <form action={testAction} className="px-4 py-3">
          <Button type="submit" variant="outline" size="sm" disabled={testing || !endpointId}>
            {testing ? "Sending" : "Send test event"}
          </Button>
          {!endpointId ? (
            <p className="mt-2 text-xs text-muted-foreground">Register the receiver first so the instance has a URL.</p>
          ) : null}
          <ActionFeedback state={testState} />
        </form>
      </section>

      <section aria-labelledby="secret-title" className="border">
        <div className="border-b px-4 py-3">
          <h2 id="secret-title" className="text-base">
            Paste an endpoint secret
          </h2>
          <p className="text-xs text-muted-foreground">
            Use this when the endpoint lives in the dashboard. The receiver prefers ORBITID_WEBHOOK_SECRET, then this
            value, then the endpoint registered above.
          </p>
        </div>
        <form action={secretAction} className="space-y-2 px-4 py-3">
          <label htmlFor="webhook-secret" className="text-xs font-medium">
            Endpoint secret
          </label>
          <Input
            id="webhook-secret"
            name="secret"
            type="password"
            autoComplete="off"
            placeholder="whsec_..."
            className="font-data h-8"
          />
          <Button type="submit" size="sm" variant="outline" disabled={saving}>
            {saving ? "Saving" : "Use this secret"}
          </Button>
          <ActionFeedback state={secretState} />
        </form>
      </section>

      <section aria-labelledby="clear-title" className="border">
        <div className="border-b px-4 py-3">
          <h2 id="clear-title" className="text-base">
            Received events
          </h2>
          <p className="text-xs text-muted-foreground">Empty the in-memory list without touching the instance.</p>
        </div>
        <form action={clearAction} className="px-4 py-3">
          <Button type="submit" size="sm" variant="outline" disabled={clearing}>
            {clearing ? "Clearing" : "Clear received events"}
          </Button>
          <ActionFeedback state={clearState} />
        </form>
      </section>
    </div>
  );
}
