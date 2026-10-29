"use client";

import * as React from "react";
import Link from "next/link";
import { Button, Input } from "@orbitid/ui";
import { CopyButton } from "./copy-button";
import { StatusChip, type StatusKind } from "./status-chip";
import type { ActionResult } from "@/lib/action-state";
import type { DeviceFlowView, DevicePollState } from "@/lib/device-flow";
import { formatClock, formatDateTime } from "@/lib/format";
import {
  createDeviceApplication,
  pollDeviceFlow,
  resetDeviceFlow,
  startDeviceFlow,
  type DeviceApplicationSummary,
} from "@/app/device/actions";

const INITIAL: ActionResult = { ok: false, message: "" };

const POLL_KIND: Record<DevicePollState, StatusKind> = {
  pending: "pending",
  "slow-down": "needs-config",
  denied: "failed",
  expired: "failed",
  complete: "success",
  failed: "failed",
};

function Feedback({ state }: { state: ActionResult }) {
  if (!state.message) return null;
  return (
    <div className="mt-2 text-xs" role="status">
      <StatusChip kind={state.ok ? "success" : "failed"} label={state.ok ? "Done" : "Failed"} />
      <p className={`mt-1 text-sm ${state.ok ? "text-foreground" : "text-signal"}`}>{state.message}</p>
      {state.detail ? <p className="mt-0.5 text-muted-foreground">{state.detail}</p> : null}
      {state.secret ? (
        <div className="mt-2 border-t pt-2">
          <p className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
            Access token
          </p>
          <div className="mt-1 flex items-start gap-2">
            <pre className="font-data min-w-0 flex-1 overflow-auto text-xs break-all whitespace-pre-wrap">
              {state.secret}
            </pre>
            <CopyButton value={state.secret} label="Copy access token" />
          </div>
          <p className="mt-1 text-muted-foreground">
            Paste it into{" "}
            <code className="font-data">
              GET {"/oauth/userinfo"}
            </code>{" "}
            with <code className="font-data">Authorization: Bearer …</code> to read the claims.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function DeviceDemo({
  applications,
  loadError,
  flow,
  secretKeyPresent,
  instanceUrl,
}: {
  applications: DeviceApplicationSummary[];
  loadError?: string;
  flow: DeviceFlowView | null;
  secretKeyPresent: boolean;
  instanceUrl: string;
}) {
  const [selected, setSelected] = React.useState(() => applications[0]?.clientId ?? "");
  const [scopes, setScopes] = React.useState("openid profile email offline_access");
  const [applicationName, setApplicationName] = React.useState("Playground device flow");
  const [startState, startAction, starting] = React.useActionState(startDeviceFlow, INITIAL);
  const [pollState, pollAction, polling] = React.useActionState(pollDeviceFlow, INITIAL);
  const [resetState, resetAction, resetting] = React.useActionState(resetDeviceFlow, INITIAL);
  const [createState, createAction, creating] = React.useActionState(createDeviceApplication, INITIAL);
  const [autoPoll, setAutoPoll] = React.useState(false);

  const chosen = applications.find((application) => application.clientId === selected);
  const complete = pollState.ok && flow?.polls.some((poll) => poll.state === "complete");
  const expired =
    flow !== null && Date.now() > flow.startedAt + flow.expiresIn * 1000 && !complete;

  // "Poll every interval" is an explicit opt-in: the button also polls once on its own.
  React.useEffect(() => {
    if (!autoPoll || !flow || complete) return;
    const every = Math.max(5, flow.interval) * 1000;
    const timer = window.setInterval(() => {
      const form = new FormData();
      void pollAction(form);
    }, every);
    return () => window.clearInterval(timer);
  }, [autoPoll, flow, complete, pollAction]);

  return (
    <div className="space-y-8">
      <section aria-labelledby="start-title" className="border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 id="start-title" className="text-base">
              Start a device request
            </h2>
            <p className="text-xs text-muted-foreground">
              The server posts to {instanceUrl}/oauth/device_authorization with the application&rsquo;s client id.
            </p>
          </div>
          {!secretKeyPresent ? <StatusChip kind="needs-config" label="Needs the secret key" /> : null}
        </div>

        {!secretKeyPresent ? (
          <div className="px-4 py-4 text-sm text-muted-foreground">
            <p>
              The device grant needs an OAuth application, and applications are managed with the secret key. Add{" "}
              <code className="font-data">ORBITID_SECRET_KEY</code> to <code className="font-data">playground/.env.local</code>{" "}
              and restart the dev server.
            </p>
            <p className="mt-2">
              Without it you can still walk the flow by hand: {instanceUrl}/oauth/device_authorization takes{" "}
              <code className="font-data">client_id</code> and <code className="font-data">scope</code> as form fields.
            </p>
          </div>
        ) : applications.length === 0 ? (
          <div className="space-y-3 px-4 py-4">
            <p className="text-sm text-muted-foreground">
              {loadError
                ? `Applications could not be listed: ${loadError}`
                : "This instance has no OAuth application yet. Register a public one to try the grant."}
            </p>
            <form action={createAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label htmlFor="application-name" className="text-xs font-medium">
                  Application name
                </label>
                <Input
                  id="application-name"
                  name="name"
                  value={applicationName}
                  onChange={(event) => setApplicationName(event.target.value)}
                  className="mt-1 h-8"
                  autoComplete="off"
                />
              </div>
              <Button type="submit" size="sm" disabled={creating}>
                {creating ? "Registering" : "Register a public application"}
              </Button>
            </form>
            <Feedback state={createState} />
          </div>
        ) : (
          <form action={startAction} className="space-y-3 px-4 py-4">
            <input type="hidden" name="clientId" value={selected} />
            <input type="hidden" name="applicationId" value={chosen?.id ?? ""} />
            <input type="hidden" name="applicationName" value={chosen?.name ?? "Device flow"} />
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label htmlFor="device-application" className="text-xs font-medium">
                  Application
                </label>
                <select
                  id="device-application"
                  value={selected}
                  onChange={(event) => setSelected(event.target.value)}
                  className="mt-1 h-8 w-full rounded-sm border bg-background px-2 text-sm"
                >
                  {applications.map((application) => (
                    <option key={application.id} value={application.clientId}>
                      {application.name} {application.public ? "(public)" : "(confidential)"}
                    </option>
                  ))}
                </select>
                <p className="mt-1 text-xs text-muted-foreground">
                  client_id <code className="font-data">{selected}</code>
                </p>
              </div>
              <div>
                <label htmlFor="device-scopes" className="text-xs font-medium">
                  Scopes
                </label>
                <Input
                  id="device-scopes"
                  name="scopes"
                  value={scopes}
                  onChange={(event) => setScopes(event.target.value)}
                  className="font-data mt-1 h-8"
                  autoComplete="off"
                />
                <p className="mt-1 text-xs text-muted-foreground">
                  Only scopes configured on the application are accepted.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Button type="submit" size="sm" disabled={starting}>
                {starting ? "Requesting a code" : "Request a device code"}
              </Button>
              {chosen && !chosen.public ? (
                <span className="text-xs text-muted-foreground">
                  A confidential application needs its secret; this page sends the client id only, so a public
                  application is the easy path.
                </span>
              ) : null}
            </div>
            <Feedback state={startState} />
          </form>
        )}

        {applications.length > 0 ? (
          <div className="border-t px-4 py-3">
            <form action={createAction} className="flex flex-col gap-2 sm:flex-row sm:items-end">
              <div className="flex-1">
                <label htmlFor="new-application-name" className="text-xs font-medium">
                  Register another public application for this site
                </label>
                <Input
                  id="new-application-name"
                  name="name"
                  value={applicationName}
                  onChange={(event) => setApplicationName(event.target.value)}
                  className="mt-1 h-8"
                  autoComplete="off"
                />
              </div>
              <Button type="submit" variant="outline" size="sm" disabled={creating}>
                {creating ? "Registering" : "Register"}
              </Button>
            </form>
            <Feedback state={createState} />
          </div>
        ) : null}
      </section>

      <section aria-labelledby="code-title" className="border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 id="code-title" className="text-base">
              Code and verification page
            </h2>
            <p className="text-xs text-muted-foreground">
              Show the code to the person, or open the complete link. The code expires.
            </p>
          </div>
          {flow ? (
            <StatusChip kind={complete ? "success" : expired ? "failed" : "pending"} label={complete ? "Approved" : expired ? "Expired" : "Waiting"} />
          ) : (
            <StatusChip kind="off" label="No request" />
          )}
        </div>

        {!flow ? (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            No device request in progress. Start one above; only one is kept at a time, in dev-server memory.
          </p>
        ) : (
          <div className="space-y-4 px-4 py-4">
            <div className="flex flex-wrap items-end gap-6">
              <div>
                <p className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  User code
                </p>
                <p className="font-data mt-1 text-[1.75rem] leading-none tracking-[0.08em]">{flow.userCode}</p>
              </div>
              <div>
                <p className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Verification link
                </p>
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  <a href={flow.verificationUriComplete} className="font-data text-xs underline underline-offset-4">
                    {flow.verificationUri}
                  </a>
                  <CopyButton value={flow.verificationUriComplete} label="Copy verification link" />
                </div>
              </div>
              <div>
                <p className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Expires
                </p>
                <p className="font-data mt-1 text-xs">
                  {formatDateTime(flow.startedAt + flow.expiresIn * 1000)} ({flow.expiresIn}s)
                </p>
              </div>
            </div>
            <p className="text-xs text-muted-foreground">
              Application {flow.applicationName}, client_id <code className="font-data">{flow.clientId}</code>, scopes{" "}
              <code className="font-data">{flow.scopes}</code>. Started at {formatClock(flow.startedAt)}.
            </p>
          </div>
        )}
      </section>

      <section aria-labelledby="poll-title" className="border">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
          <div>
            <h2 id="poll-title" className="text-base">
              Poll the token endpoint
            </h2>
            <p className="text-xs text-muted-foreground">
              grant_type urn:ietf:params:oauth:grant-type:device_code. Every answer is recorded below.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <form action={pollAction}>
              <Button type="submit" size="sm" disabled={!flow || polling || complete}>
                {polling ? "Polling" : "Poll once"}
              </Button>
            </form>
            <Button
              type="button"
              variant={autoPoll ? "default" : "outline"}
              size="sm"
              aria-pressed={autoPoll}
              onClick={() => setAutoPoll((value) => !value)}
              disabled={!flow || complete}
            >
              {autoPoll ? "Polling automatically" : "Poll every interval"}
            </Button>
            <form action={resetAction}>
              <Button type="submit" variant="ghost" size="sm" disabled={!flow || resetting}>
                Clear
              </Button>
            </form>
          </div>
        </div>

        <Feedback state={pollState} />
        <Feedback state={resetState} />

        {flow && flow.polls.length > 0 ? (
          <table className="w-full border-t text-sm">
            <caption className="sr-only">Poll answers for this device code</caption>
            <thead>
              <tr className="border-b text-left">
                <th scope="col" className="w-24 px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Time
                </th>
                <th scope="col" className="w-32 px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Answer
                </th>
                <th scope="col" className="px-4 py-2 text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">
                  Detail
                </th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {[...flow.polls].reverse().map((poll, index) => (
                <tr key={`${poll.at}-${index}`}>
                  <td className="font-data px-4 py-2 text-xs text-muted-foreground">{formatClock(poll.at)}</td>
                  <td className="px-4 py-2">
                    <StatusChip kind={POLL_KIND[poll.state]} label={poll.state} />
                  </td>
                  <td className="px-4 py-2 text-xs">{poll.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="px-4 py-4 text-sm text-muted-foreground">
            Nothing polled yet. Until the code is approved the endpoint answers{" "}
            <code className="font-data">authorization_pending</code>.
          </p>
        )}
      </section>

      <p className="max-w-[75ch] text-xs leading-5 text-muted-foreground">
        The device code never reaches the browser: it stays in the dev server and is posted to the token endpoint
        from there. Tokens shown above are real, so treat them like a password. See{" "}
        <Link href="/api-lab" className="underline underline-offset-4 hover:text-foreground">
          the API lab
        </Link>{" "}
        for the handshake and the other new endpoints.
      </p>
    </div>
  );
}
