"use client";

import * as React from "react";
import { useSession } from "@orbitid/react";
import { frontendApiUrl } from "@/lib/client-env";
import { rawSessionsFrom, skipMarkerFor, type SkipMarker } from "@/lib/session-markers";

export function DataRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[190px_1fr] sm:gap-4">
      <dt className="font-data text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

export function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-data text-xs">{children}</span>;
}

/**
 * Reads the skip marker from the raw Frontend API list: the SDK's `Session` resource does not copy
 * `second_factor_skipped_by_trusted_device`, so `useSession()` cannot answer this.
 */
export function useSkipMarker(sessionId: string | null | undefined, signedIn: boolean | undefined) {
  const [marker, setMarker] = React.useState<SkipMarker>("unknown");
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (!signedIn || !sessionId) {
      setMarker("unknown");
      setError(null);
      return;
    }
    const apiUrl = frontendApiUrl();
    if (!apiUrl) {
      setError("The publishable key is not readable in the browser.");
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(`${apiUrl}/v1/client/sessions`, {
          credentials: "include",
          cache: "no-store",
          headers: { Accept: "application/json" },
        });
        const body: unknown = await response.json().catch(() => null);
        if (cancelled) return;
        if (!response.ok) {
          setError(`GET /v1/client/sessions answered ${response.status}.`);
          setMarker("unknown");
          return;
        }
        setError(null);
        setMarker(skipMarkerFor(rawSessionsFrom(body), sessionId));
      } catch (cause) {
        if (!cancelled) {
          setMarker("unknown");
          setError(cause instanceof Error ? cause.message : "The session list could not be read.");
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, signedIn]);

  return { marker, error };
}
