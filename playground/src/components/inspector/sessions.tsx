"use client";

import * as React from "react";
import { ActivityBoard, Button, type ActivityRow } from "@orbitid/ui";
import { useAuth, useSessionList, useUser } from "@orbitid/react";
import { StatusChip } from "../status-chip";
import { type ClientActivityEvent, type ClientActivityInput } from "./use-client-activity";
import { formatDateTime } from "@/lib/format";

export function SessionsTable() {
  const { isLoaded, sessions } = useSessionList();
  const { sessionId } = useAuth({ treatPendingAsSignedOut: false });

  return (
    <section aria-labelledby="sessions-title" className="border">
      <div className="border-b px-4 py-3">
        <h2 id="sessions-title" className="text-base">
          Sessions on this client
        </h2>
        <p className="text-xs text-muted-foreground">useSessionList(). Multi-session mode keeps more than one.</p>
      </div>
      {!isLoaded ? (
        <div className="space-y-2 px-4 py-3" aria-busy="true">
          <div className="h-3 w-48 animate-pulse rounded-sm bg-muted" />
          <div className="h-12 w-full animate-pulse rounded-sm bg-muted/70" />
        </div>
      ) : sessions.length === 0 ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">No sessions. Sign in to create one.</p>
      ) : (
        <table className="w-full text-sm">
          <caption className="sr-only">Sessions attached to this client</caption>
          <thead>
            <tr className="border-b text-left">
              <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Session
              </th>
              <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                Status
              </th>
              <th scope="col" className="hidden px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase sm:table-cell">
                Created
              </th>
              <th scope="col" className="hidden px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase sm:table-cell">
                Last active
              </th>
            </tr>
          </thead>
          <tbody className="divide-y">
            {sessions.map((session) => (
              <tr key={session.id}>
                <td className="px-4 py-2">
                  <span className="font-data text-xs">{session.id}</span>
                  {session.id === sessionId ? (
                    <span className="ml-2 text-[0.6875rem] text-muted-foreground">This session</span>
                  ) : null}
                </td>
                <td className="px-4 py-2">
                  <StatusChip
                    kind={session.status === "active" ? "success" : session.status === "pending" ? "pending" : "failed"}
                    label={session.status}
                  />
                </td>
                <td className="font-data hidden px-4 py-2 text-xs text-muted-foreground sm:table-cell">
                  {session.createdAt ? formatDateTime(session.createdAt) : "Unknown"}
                </td>
                <td className="font-data hidden px-4 py-2 text-xs text-muted-foreground sm:table-cell">
                  {session.lastActiveAt ? formatDateTime(session.lastActiveAt) : "Unknown"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

export function ActivitySection({
  record,
  events,
  clear,
}: {
  record: (event: ClientActivityInput) => void;
  events: ClientActivityEvent[];
  clear: () => void;
}) {
  const { isLoaded, sessions } = useSessionList();
  const { user } = useUser();
  const { userId, sessionId } = useAuth({ treatPendingAsSignedOut: false });

  const who = user?.primaryEmailAddress?.emailAddress ?? user?.fullName ?? userId ?? "This browser";
  const recordedOpen = React.useRef(false);

  React.useEffect(() => {
    if (recordedOpen.current) return;
    recordedOpen.current = true;
    record({ method: "unknown", outcome: "success", detail: "Inspector opened in this browser" });
  }, [record]);

  const rows: ActivityRow[] = React.useMemo(() => {
    const sessionRows: ActivityRow[] = sessions.map((session) => ({
      id: `session-${session.id}`,
      at: session.createdAt ?? Date.now(),
      method: "unknown",
      who,
      whoSub: session.user?.id ?? userId ?? undefined,
      where: session.id === sessionId ? "This browser" : "Another device",
      outcome: session.status === "pending" ? "pending" : "success",
      detail: session.status === "active" ? "Session started" : `Session ${session.status}`,
    }));
    const clientRows: ActivityRow[] = events.map((event) => ({
      id: event.id,
      at: event.at,
      method: event.method,
      who,
      whoSub: userId ?? undefined,
      where: "This browser",
      outcome: event.outcome,
      detail: event.detail,
    }));
    return [...sessionRows, ...clientRows].sort((left, right) => new Date(right.at).getTime() - new Date(left.at).getTime());
  }, [sessions, events, who, userId]);

  return (
    <section aria-labelledby="activity-title" className="space-y-3">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h2 id="activity-title" className="text-base">
            Activity
          </h2>
          <p className="text-xs text-muted-foreground">
            Sessions from useSessionList plus events this browser recorded. Kept in session storage.
          </p>
        </div>
        <Button type="button" variant="outline" size="xs" onClick={clear}>
          Clear browser events
        </Button>
      </div>
      <ActivityBoard
        rows={rows}
        loading={!isLoaded}
        emptyTitle="No activity yet"
        emptyHint="Sign in, fetch a token or run a has() check to fill the board."
      />
    </section>
  );
}
