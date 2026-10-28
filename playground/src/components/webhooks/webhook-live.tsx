"use client";

import * as React from "react";
import { Button } from "@orbitid/ui";
import { StatusChip } from "../status-chip";
import { formatClock, formatDateTime } from "@/lib/format";

interface StoredEvent {
  id: string;
  type: string;
  receivedAt: number;
  payload: unknown;
}

interface Delivery {
  id: string;
  eventType: string;
  status: string;
  attempt: number;
  responseCode: number | null;
  nextAttemptAt: number | null;
  createdAt: number;
}

interface StatusPayload {
  events: StoredEvent[];
  endpoint: { id: string; url: string } | null;
  secretSource: "env" | "form" | "endpoint" | "none";
  deliveries: Delivery[] | null;
  deliveryError: string | null;
  checkedAt: number;
}

function deliveryKind(status: string): "success" | "failed" | "pending" {
  if (status === "success") return "success";
  if (status === "failed") return "failed";
  return "pending";
}

export function WebhookLive() {
  const [data, setData] = React.useState<StatusPayload | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [nonce, setNonce] = React.useState(0);

  React.useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const response = await fetch("/api/webhooks", { cache: "no-store", credentials: "same-origin" });
        if (!response.ok) {
          if (!cancelled) setError(`The receiver status endpoint answered ${response.status}.`);
          return;
        }
        const body = (await response.json()) as StatusPayload;
        if (!cancelled) {
          setData(body);
          setError(null);
        }
      } catch (cause) {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : "The receiver status endpoint did not answer.");
        }
      }
    }
    void load();
    const timer = window.setInterval(() => void load(), 4000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [nonce]);

  const events = data?.events ?? [];

  return (
    <div className="space-y-8">
      <section aria-labelledby="received-title" className="border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 id="received-title" className="text-base">
              Received events
            </h2>
            <p className="text-xs text-muted-foreground">
              Verified payloads kept in dev server memory, newest first, at most 100.
            </p>
          </div>
          <div className="flex items-center gap-3">
            {data ? <span className="text-xs text-muted-foreground">Polled {formatClock(data.checkedAt)}</span> : null}
            <Button type="button" variant="outline" size="xs" onClick={() => setNonce((value) => value + 1)}>
              Refresh now
            </Button>
          </div>
        </div>

        {error ? (
          <div className="border-b px-4 py-3" role="alert">
            <StatusChip kind="failed" label="Poll failed" />
            <p className="mt-1 text-sm text-signal">{error}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              The app server route /api/webhooks did not answer. Check the dev server log.
            </p>
          </div>
        ) : null}

        {!data && !error ? (
          <div className="space-y-2 px-4 py-3" aria-busy="true">
            <div className="h-3 w-40 animate-pulse rounded-sm bg-muted" />
            <div className="h-16 w-full animate-pulse rounded-sm bg-muted/70" />
          </div>
        ) : events.length === 0 ? (
          <div className="px-4 py-4">
            <p className="text-sm">No events received yet.</p>
            <p className="mt-1 max-w-[65ch] text-xs text-muted-foreground">
              Send a test event, or create a user on the Seed data page to make the instance emit user.created.
            </p>
          </div>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Webhook events received by this site</caption>
            <thead className="hidden sm:table-header-group">
              <tr className="border-b text-left">
                <th scope="col" className="w-24 px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Time
                </th>
                <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Event
                </th>
                <th scope="col" className="w-24 px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Check
                </th>
                <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Payload
                </th>
              </tr>
            </thead>
            <tbody>
              {events.map((event) => (
                <tr key={event.id} className="grid gap-1 border-b px-4 py-3 sm:table-row sm:px-0 sm:py-0">
                  <td className="font-data text-xs text-muted-foreground sm:px-4 sm:py-2">
                    {formatClock(event.receivedAt)}
                  </td>
                  <td className="sm:px-4 sm:py-2">
                    <code className="font-data text-xs">{event.type}</code>
                    <p className="font-data text-[0.6875rem] text-muted-foreground">{event.id}</p>
                  </td>
                  <td className="sm:px-4 sm:py-2">
                    <StatusChip kind="success" label="Verified" />
                  </td>
                  <td className="sm:px-4 sm:py-2">
                    <details>
                      <summary className="cursor-pointer text-xs text-muted-foreground">View payload</summary>
                      <pre className="font-data mt-1 max-h-56 overflow-auto text-xs leading-relaxed">
                        {JSON.stringify(event.payload, null, 2)}
                      </pre>
                    </details>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section aria-labelledby="deliveries-title" className="border">
        <div className="border-b px-4 py-3">
          <h2 id="deliveries-title" className="text-base">
            Deliveries
          </h2>
          <p className="text-xs text-muted-foreground">
            From the Backend API. Attempt counts and response codes show whether the instance reached this site.
          </p>
        </div>
        {data?.deliveryError ? (
          <div className="px-4 py-3">
            <StatusChip kind="needs-config" label="Needs the secret key" />
            <p className="mt-1 text-sm">{data.deliveryError}</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Set ORBITID_SECRET_KEY in playground/.env.local and restart the dev server to read deliveries.
            </p>
          </div>
        ) : !data ? (
          <div className="h-16 animate-pulse bg-muted/40" aria-hidden="true" />
        ) : data.deliveries && data.deliveries.length > 0 ? (
          <table className="w-full text-sm">
            <caption className="sr-only">Recent webhook deliveries</caption>
            <thead className="hidden sm:table-header-group">
              <tr className="border-b text-left">
                <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Created
                </th>
                <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Event
                </th>
                <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Status
                </th>
                <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Attempt
                </th>
                <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Response
                </th>
              </tr>
            </thead>
            <tbody>
              {data.deliveries.map((delivery) => (
                <tr key={delivery.id} className="grid gap-1 border-b px-4 py-3 sm:table-row sm:px-0 sm:py-0">
                  <td className="font-data text-xs text-muted-foreground sm:px-4 sm:py-2">
                    {formatDateTime(delivery.createdAt)}
                  </td>
                  <td className="font-data text-xs sm:px-4 sm:py-2">{delivery.eventType}</td>
                  <td className="sm:px-4 sm:py-2">
                    <StatusChip kind={deliveryKind(delivery.status)} label={delivery.status} />
                  </td>
                  <td className="font-data text-xs sm:px-4 sm:py-2">{delivery.attempt}</td>
                  <td className="font-data text-xs sm:px-4 sm:py-2">
                    {delivery.responseCode ?? "none"}
                    {delivery.nextAttemptAt ? (
                      <span className="ml-2 text-muted-foreground">
                        retry {formatDateTime(delivery.nextAttemptAt)}
                      </span>
                    ) : null}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="px-4 py-4">
            <p className="text-sm">No deliveries recorded.</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Register the receiver and send a test event. The instance records one delivery per attempt.
            </p>
          </div>
        )}
      </section>
    </div>
  );
}
