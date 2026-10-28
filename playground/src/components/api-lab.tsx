"use client";

import * as React from "react";
import { useAuth } from "@orbitid/react";
import { Button } from "@orbitid/ui";
import { CopyButton } from "./copy-button";
import { StatusChip } from "./status-chip";

interface Endpoint {
  path: string;
  title: string;
  requirement: string;
  description: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    path: "/api/public",
    title: "Public handler",
    requirement: "nothing",
    description: "Never calls auth(). Answers the same way signed in or out.",
  },
  {
    path: "/api/whoami",
    title: "Session handler",
    requirement: "a session",
    description: "Calls auth() and currentUser(). Without a valid session it answers 401.",
  },
  {
    path: "/api/admin",
    title: "Permission handler",
    requirement: "org:sys_memberships:manage",
    description: "Calls auth(). Answers 401 without a session and 403 when the permission is missing.",
  },
];

interface CallResult {
  status: number;
  statusText: string;
  durationMs: number;
  headers: Array<[string, string]>;
  body: string;
  tokenSent: boolean;
}

type CallState =
  | { kind: "idle" }
  | { kind: "loading"; tokenSent: boolean }
  | { kind: "done"; result: CallResult }
  | { kind: "error"; message: string; tokenSent: boolean };

function ResultBlock({ state, path }: { state: CallState; path: string }) {
  if (state.kind === "idle") {
    return (
      <p className="border-t px-4 py-3 text-xs text-muted-foreground">
        Run a call to see the status line, response headers and body.
      </p>
    );
  }
  if (state.kind === "loading") {
    return (
      <div className="space-y-2 border-t px-4 py-3" aria-busy="true">
        <div className="h-3 w-40 animate-pulse rounded-sm bg-muted" />
        <div className="h-16 w-full animate-pulse rounded-sm bg-muted/70" />
      </div>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="border-t px-4 py-3" role="alert">
        <StatusChip kind="failed" label="Request failed" />
        <p className="mt-1 text-sm text-signal">{state.message}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The app server did not answer {path}. Check the dev server log, then try again.
        </p>
      </div>
    );
  }

  const { result } = state;
  const ok = result.status < 400;
  const interesting = result.headers.filter(([name]) =>
    ["content-type", "cache-control", "x-demo-check", "x-demo-requires"].includes(name),
  );
  return (
    <div className="border-t">
      <div className="flex flex-wrap items-center gap-3 px-4 py-2.5">
        <StatusChip kind={ok ? "success" : "failed"} label={`${result.status} ${result.statusText}`.trim()} />
        <span className="font-data text-xs text-muted-foreground">{result.durationMs} ms</span>
        <span className="text-xs text-muted-foreground">
          {result.tokenSent ? "Bearer token sent" : "No bearer token, cookies omitted"}
        </span>
        <CopyButton value={result.body} label="Copy body" className="ml-auto" />
      </div>
      <div className="grid border-t md:grid-cols-[220px_1fr]">
        <div className="border-b px-4 py-3 md:border-r md:border-b-0">
          <p className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Response headers
          </p>
          <dl className="mt-1.5 space-y-1">
            {interesting.length ? (
              interesting.map(([name, value]) => (
                <div key={name} className="text-xs">
                  <dt className="font-data text-muted-foreground">{name}</dt>
                  <dd className="font-data break-all text-foreground">{value}</dd>
                </div>
              ))
            ) : (
              <p className="text-xs text-muted-foreground">No headers reported.</p>
            )}
          </dl>
        </div>
        <div className="min-w-0 px-4 py-3">
          <p className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">Body</p>
          <pre className="font-data mt-1.5 max-h-72 overflow-auto text-xs leading-relaxed">{result.body}</pre>
        </div>
      </div>
    </div>
  );
}

export function ApiLab() {
  const { getToken } = useAuth();
  const [states, setStates] = React.useState<Record<string, CallState>>({});

  function setState(path: string, state: CallState) {
    setStates((current) => ({ ...current, [path]: state }));
  }

  async function call(path: string, withToken: boolean) {
    const started = performance.now();
    setState(path, { kind: "loading", tokenSent: withToken });
    try {
      let token: string | null = null;
      if (withToken) {
        token = await getToken();
        if (!token) {
          setState(path, {
            kind: "error",
            tokenSent: false,
            message: "No session token. Sign in first, then call again.",
          });
          return;
        }
      }
      const response = await fetch(path, {
        cache: "no-store",
        credentials: withToken ? "same-origin" : "omit",
        headers: {
          Accept: "application/json",
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
      });
      const text = await response.text();
      let body = text;
      try {
        body = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        body = text;
      }
      setState(path, {
        kind: "done",
        result: {
          status: response.status,
          statusText: response.statusText,
          durationMs: Math.round(performance.now() - started),
          headers: Array.from(response.headers.entries()),
          body,
          tokenSent: Boolean(token),
        },
      });
    } catch (error) {
      setState(path, {
        kind: "error",
        tokenSent: withToken,
        message: error instanceof Error ? error.message : "The request could not be made.",
      });
    }
  }

  return (
    <div className="space-y-8">
      {ENDPOINTS.map((endpoint) => {
        const state = states[endpoint.path] ?? { kind: "idle" as const };
        const loading = state.kind === "loading";
        return (
          <section key={endpoint.path} aria-labelledby={`endpoint-${endpoint.path}`} className="border">
            <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-data rounded-sm border px-1.5 py-0.5 text-[0.6875rem] font-semibold">GET</span>
                  <code id={`endpoint-${endpoint.path}`} className="font-data text-sm">
                    {endpoint.path}
                  </code>
                </div>
                <p className="mt-1 text-sm font-medium">{endpoint.title}</p>
                <p className="mt-0.5 max-w-[65ch] text-xs text-muted-foreground">{endpoint.description}</p>
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-[0.6875rem] text-muted-foreground">Requires {endpoint.requirement}</span>
                <div className="flex flex-wrap justify-end gap-2">
                  <Button type="button" variant="outline" size="sm" onClick={() => call(endpoint.path, false)} disabled={loading}>
                    Call without token
                  </Button>
                  <Button type="button" size="sm" onClick={() => call(endpoint.path, true)} disabled={loading}>
                    Call with token
                  </Button>
                </div>
              </div>
            </div>
            <ResultBlock state={state} path={endpoint.path} />
          </section>
        );
      })}
    </div>
  );
}
