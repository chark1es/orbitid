"use client";

import * as React from "react";
import { useAuth } from "@orbitid/react";
import { Button, Input } from "@orbitid/ui";
import { CopyButton } from "./copy-button";
import { StatusChip } from "./status-chip";

interface EndpointInput {
  name: string;
  label: string;
  placeholder: string;
  defaultValue?: string;
}

interface Endpoint {
  method: "GET" | "POST";
  path: string;
  title: string;
  requirement: string;
  description: string;
  /** Form fields posted as a JSON body. Absent means a plain GET. */
  inputs?: EndpointInput[];
  /** Show the with/without bearer buttons; only routes that call auth() use the session. */
  session: boolean;
  /** The instance route this handler calls, shown under the title. */
  upstream?: string;
}

const ENDPOINTS: Endpoint[] = [
  {
    method: "GET",
    path: "/api/public",
    title: "Public handler",
    requirement: "nothing",
    description: "Never calls auth(). Answers the same way signed in or out.",
    session: true,
  },
  {
    method: "GET",
    path: "/api/whoami",
    title: "Session handler",
    requirement: "a session",
    description: "Calls auth() and currentUser(). Without a valid session it answers 401.",
    session: true,
  },
  {
    method: "GET",
    path: "/api/admin",
    title: "Permission handler",
    requirement: "org:sys_memberships:manage",
    description: "Calls auth(). Answers 401 without a session and 403 when the permission is missing.",
    session: true,
  },
  {
    method: "GET",
    path: "/api/handshake",
    title: "Handshake",
    requirement: "nothing",
    description:
      "Asks the instance for a handshake for this site's origin and reports the redirect instead of following it. No session or key needed.",
    session: false,
    upstream: "GET /v1/client/handshake?redirect_url=…",
  },
  {
    method: "GET",
    path: "/api/device",
    title: "Device grant and discovery",
    requirement: "nothing",
    description:
      "Reads the discovery document and probes POST /oauth/device_authorization. A 404 on the probe means the grant is off.",
    session: false,
    upstream: "GET /.well-known/openid-configuration, POST /oauth/device_authorization",
  },
  {
    method: "POST",
    path: "/api/device",
    title: "Start a device authorization",
    requirement: "an application's client id",
    description:
      "Posts client_id and scope to the instance and returns the raw device code response. Start a real, pollable request on the Device flow page.",
    inputs: [
      { name: "client_id", label: "client_id", placeholder: "oa_…" },
      { name: "scope", label: "scope", placeholder: "openid profile email", defaultValue: "openid profile email" },
    ],
    session: false,
    upstream: "POST /oauth/device_authorization",
  },
  {
    method: "POST",
    path: "/api/email-test",
    title: "Send a test email",
    requirement: "the secret key",
    description:
      "Calls POST /v1/instance/email_test server-side and returns the transport that delivered the message. The key never reaches the browser.",
    inputs: [{ name: "to", label: "to", placeholder: "you@example.com" }],
    session: false,
    upstream: "POST /v1/instance/email_test",
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

const ENDPOINT_LABEL = (endpoint: Endpoint) => `${endpoint.method} ${endpoint.path}`;

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

function BodyFields({ endpoint }: { endpoint: Endpoint }) {
  if (!endpoint.inputs) return null;
  return (
    <div className="flex flex-col gap-2 pb-1 sm:flex-row sm:items-end">
      {endpoint.inputs.map((input) => (
        <div key={input.name} className="flex-1">
          <label htmlFor={`${endpoint.path}-${input.name}`} className="font-data text-[0.6875rem] text-muted-foreground">
            {input.label}
          </label>
          <Input
            id={`${endpoint.path}-${input.name}`}
            name={input.name}
            defaultValue={input.defaultValue}
            placeholder={input.placeholder}
            className="font-data mt-1 h-8"
            autoComplete="off"
          />
        </div>
      ))}
    </div>
  );
}

export function ApiLab() {
  const { getToken } = useAuth();
  const [states, setStates] = React.useState<Record<string, CallState>>({});

  function setState(key: string, state: CallState) {
    setStates((current) => ({ ...current, [key]: state }));
  }

  async function call(endpoint: Endpoint, withToken: boolean, form?: HTMLFormElement | null) {
    const key = ENDPOINT_LABEL(endpoint);
    const started = performance.now();
    setState(key, { kind: "loading", tokenSent: withToken });
    try {
      let token: string | null = null;
      if (withToken) {
        token = await getToken();
        if (!token) {
          setState(key, {
            kind: "error",
            tokenSent: false,
            message: "No session token. Sign in first, then call again.",
          });
          return;
        }
      }
      let body: string | undefined;
      if (endpoint.method === "POST") {
        const payload: Record<string, string> = {};
        if (form) {
          for (const input of endpoint.inputs ?? []) {
            const field = form.elements.namedItem(input.name);
            if (field instanceof HTMLInputElement) payload[input.name] = field.value.trim();
          }
        }
        body = JSON.stringify(payload);
      }
      const response = await fetch(endpoint.path, {
        method: endpoint.method,
        cache: "no-store",
        credentials: withToken ? "same-origin" : "omit",
        headers: {
          Accept: "application/json",
          ...(body ? { "Content-Type": "application/json" } : {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body,
      });
      const text = await response.text();
      let pretty = text;
      try {
        pretty = JSON.stringify(JSON.parse(text), null, 2);
      } catch {
        pretty = text;
      }
      setState(key, {
        kind: "done",
        result: {
          status: response.status,
          statusText: response.statusText,
          durationMs: Math.round(performance.now() - started),
          headers: Array.from(response.headers.entries()),
          body: pretty,
          tokenSent: Boolean(token),
        },
      });
    } catch (error) {
      setState(key, {
        kind: "error",
        tokenSent: withToken,
        message: error instanceof Error ? error.message : "The request could not be made.",
      });
    }
  }

  return (
    <div className="space-y-8">
      {ENDPOINTS.map((endpoint) => {
        const key = ENDPOINT_LABEL(endpoint);
        const state = states[key] ?? { kind: "idle" as const };
        const loading = state.kind === "loading";
        const formId = `form-${endpoint.method}-${endpoint.path.replace(/\W+/g, "-")}`;
        return (
          <section key={key} aria-labelledby={`endpoint-${formId}`} className="border">
            <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div>
                <div className="flex items-center gap-2">
                  <span className="font-data rounded-sm border px-1.5 py-0.5 text-[0.6875rem] font-semibold">
                    {endpoint.method}
                  </span>
                  <code id={`endpoint-${formId}`} className="font-data text-sm">
                    {endpoint.path}
                  </code>
                </div>
                <p className="mt-1 text-sm font-medium">{endpoint.title}</p>
                <p className="mt-0.5 max-w-[65ch] text-xs text-muted-foreground">{endpoint.description}</p>
                {endpoint.upstream ? (
                  <p className="font-data mt-1 text-[0.6875rem] text-muted-foreground">Calls {endpoint.upstream}</p>
                ) : null}
              </div>
              <div className="flex flex-col items-end gap-1">
                <span className="text-[0.6875rem] text-muted-foreground">Requires {endpoint.requirement}</span>
                <div className="flex flex-wrap justify-end gap-2">
                  {endpoint.session ? (
                    <>
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={() => void call(endpoint, false)}
                        disabled={loading}
                      >
                        Call without token
                      </Button>
                      <Button type="button" size="sm" onClick={() => void call(endpoint, true)} disabled={loading}>
                        Call with token
                      </Button>
                    </>
                  ) : (
                    <Button
                      type="button"
                      size="sm"
                      disabled={loading}
                      onClick={() => {
                        const form = document.getElementById(formId);
                        void call(endpoint, false, form instanceof HTMLFormElement ? form : null);
                      }}
                    >
                      {loading ? "Calling" : "Call"}
                    </Button>
                  )}
                </div>
              </div>
            </div>
            {endpoint.inputs ? (
              <form
                id={formId}
                className="px-4 pb-3"
                onSubmit={(event) => {
                  event.preventDefault();
                  void call(endpoint, false, event.currentTarget);
                }}
              >
                <BodyFields endpoint={endpoint} />
              </form>
            ) : null}
            <ResultBlock state={state} path={endpoint.path} />
          </section>
        );
      })}
    </div>
  );
}
