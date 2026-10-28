"use client";

import * as React from "react";
import type { ActivityMethod } from "@orbitid/ui";

export interface ClientActivityEvent {
  id: string;
  at: number;
  method: ActivityMethod;
  outcome: "success" | "failed" | "pending";
  detail: string;
}

export type ClientActivityInput = Omit<ClientActivityEvent, "id" | "at">;

export interface ClientActivityLog {
  events: ClientActivityEvent[];
  record: (event: ClientActivityInput) => void;
  clear: () => void;
}

const STORAGE_KEY = "orbitid-playground:activity";
const MAX_EVENTS = 40;

function read(): ClientActivityEvent[] {
  try {
    const raw = window.sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item): item is ClientActivityEvent =>
        Boolean(item) &&
        typeof item === "object" &&
        typeof (item as ClientActivityEvent).id === "string" &&
        typeof (item as ClientActivityEvent).at === "number" &&
        typeof (item as ClientActivityEvent).detail === "string",
    );
  } catch {
    return [];
  }
}

function write(events: ClientActivityEvent[]): void {
  try {
    window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(events));
  } catch {
    // Storage can be unavailable in private windows; the in-memory list still renders.
  }
}

/** Events this browser produced: token refreshes, template calls, permission checks. */
export function useClientActivity() {
  const [events, setEvents] = React.useState<ClientActivityEvent[]>([]);

  React.useEffect(() => {
    setEvents(read());
  }, []);

  const record = React.useCallback(
    (event: Omit<ClientActivityEvent, "id" | "at">) => {
      const current = read();
      const latest = current[0];
      if (latest && latest.detail === event.detail && Date.now() - latest.at < 2000) return;
      const next = [{ ...event, id: crypto.randomUUID(), at: Date.now() }, ...current].slice(0, MAX_EVENTS);
      write(next);
      setEvents(next);
    },
    [],
  );

  const clear = React.useCallback(() => {
    write([]);
    setEvents([]);
  }, []);

  return { events, record, clear };
}
