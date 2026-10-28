"use client";

import * as React from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { ActivityBoard, Button, Input, type ActivityRow } from "@orbitid/ui";
import { useAuth, useSession, useSessionList, useUser } from "@orbitid/react";
import { CopyButton } from "./copy-button";
import { StatusChip } from "./status-chip";
import { useClientActivity, type ClientActivityEvent, type ClientActivityInput } from "./inspector/use-client-activity";
import { buildHasProbe, describeHasResult, type HasProbeKind } from "@/lib/has";
import {
  decodeJwt,
  formatClaimValue,
  formatExpiry,
  formatRemaining,
  orderClaims,
  tokenExpiry,
} from "@/lib/jwt";
import { formatDateTime } from "@/lib/format";

function DataRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1 px-4 py-2.5 sm:grid-cols-[190px_1fr] sm:gap-4">
      <dt className="font-data text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 text-sm break-words">{children}</dd>
    </div>
  );
}

function Mono({ children }: { children: React.ReactNode }) {
  return <span className="font-data text-xs">{children}</span>;
}

function SessionState() {
  const auth = useAuth({ treatPendingAsSignedOut: false });
  const { user } = useUser();
  const { session } = useSession();
  const permissions = auth.orgPermissions ?? [];

  return (
    <section aria-labelledby="state-title" className="border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 id="state-title" className="text-base">
            Auth state
          </h2>
          <p className="text-xs text-muted-foreground">Live values from useAuth, useUser and useSession.</p>
        </div>
        {!auth.isLoaded ? (
          <StatusChip kind="pending" label="Loading" />
        ) : auth.isSignedIn ? (
          <StatusChip kind="success" label="Signed in" />
        ) : (
          <StatusChip kind="off" label="Signed out" />
        )}
      </div>
      <dl className="divide-y">
        <DataRow label="userId">
          {auth.userId ? <Mono>{auth.userId}</Mono> : <span className="text-muted-foreground">null</span>}
        </DataRow>
        <DataRow label="sessionId">
          {auth.sessionId ? <Mono>{auth.sessionId}</Mono> : <span className="text-muted-foreground">null</span>}
        </DataRow>
        <DataRow label="sessionStatus">
          {auth.sessionStatus ? (
            <span className="flex flex-wrap items-center gap-2">
              <StatusChip
                kind={auth.sessionStatus === "pending" ? "pending" : "success"}
                label={auth.sessionStatus}
              />
              {auth.sessionStatus === "pending" ? (
                <span className="text-xs text-muted-foreground">
                  useAuth treats a pending session as signed out unless you pass treatPendingAsSignedOut: false.
                </span>
              ) : null}
            </span>
          ) : (
            <span className="text-muted-foreground">none</span>
          )}
        </DataRow>
        <DataRow label="organization">
          {auth.orgId ? (
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{auth.orgSlug ?? auth.orgId}</Mono>
              <span className="text-xs text-muted-foreground">role {auth.orgRole ?? "none"}</span>
            </span>
          ) : (
            <span className="text-muted-foreground">No active organization</span>
          )}
        </DataRow>
        <DataRow label="permissions">
          {permissions.length ? (
            <ul className="flex flex-wrap gap-1.5">
              {permissions.map((permission) => (
                <li key={permission} className="font-data rounded-sm border px-1.5 py-0.5 text-[0.6875rem]">
                  {permission}
                </li>
              ))}
            </ul>
          ) : (
            <span className="text-muted-foreground">None on the active organization</span>
          )}
        </DataRow>
        <DataRow label="user">
          {user ? (
            <span className="flex flex-wrap items-center gap-2">
              <Mono>{user.primaryEmailAddress?.emailAddress ?? user.id}</Mono>
              <span className="text-xs text-muted-foreground">
                {[user.firstName, user.lastName].filter(Boolean).join(" ") || "No name set"}
              </span>
            </span>
          ) : (
            <span className="text-muted-foreground">Not loaded</span>
          )}
        </DataRow>
        <DataRow label="session expires">
          {session?.expireAt ? (
            <Mono>{formatDateTime(session.expireAt)}</Mono>
          ) : (
            <span className="text-muted-foreground">Not reported by the session resource</span>
          )}
        </DataRow>
        <DataRow label="isLoaded">
          <Mono>{String(auth.isLoaded)}</Mono>
        </DataRow>
      </dl>
    </section>
  );
}

function TokenPanel({
  record,
}: {
  record: (event: ClientActivityInput) => void;
}) {
  const { getToken, isSignedIn } = useAuth();
  const [token, setToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [now, setNow] = React.useState(() => Date.now());

  const refresh = React.useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const next = await getToken();
      setToken(next);
      if (!next && isSignedIn) setError("The instance returned no token. Check the dev server log for the token endpoint.");
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The token request failed.";
      setError(`${message} The instance may be unreachable. Check the Setup page.`);
      record({ method: "unknown", outcome: "failed", detail: `Session token refresh failed: ${message}` });
    } finally {
      setLoading(false);
    }
  }, [getToken, isSignedIn, record]);

  React.useEffect(() => {
    if (!isSignedIn) {
      setToken(null);
      return;
    }
    void refresh();
    const refreshTimer = window.setInterval(() => void refresh(), 30_000);
    return () => window.clearInterval(refreshTimer);
  }, [isSignedIn, refresh]);

  React.useEffect(() => {
    const ticker = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(ticker);
  }, []);

  const decoded = React.useMemo(() => (token ? decodeJwt(token) : null), [token]);
  const expiry = decoded?.ok ? tokenExpiry(decoded.jwt.claims, now) : { expiresAt: null, remainingMs: null };

  return (
    <section aria-labelledby="token-title" className="border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <div>
          <h2 id="token-title" className="text-base">
            Session token
          </h2>
          <p className="text-xs text-muted-foreground">
            A short-lived RS256 JWT from getToken(). The SDK refreshes it before it expires.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {token ? (
            <span className="font-data rounded-sm border px-2 py-1 text-xs">
              {formatRemaining(expiry.remainingMs)}
            </span>
          ) : null}
          <Button type="button" variant="outline" size="sm" onClick={() => void refresh()} disabled={!isSignedIn || loading}>
            <RefreshCw aria-hidden="true" className={loading ? "animate-spin" : undefined} />
            {loading ? "Refreshing" : "Refresh"}
          </Button>
        </div>
      </div>

      {!isSignedIn ? (
        <p className="px-4 py-4 text-sm text-muted-foreground">
          No session. <Link href="/sign-in" className="underline underline-offset-4 hover:text-foreground">Sign in</Link> to
          mint a token.
        </p>
      ) : error ? (
        <div className="px-4 py-4" role="alert">
          <StatusChip kind="failed" label="Token request failed" />
          <p className="mt-1 text-sm text-signal">{error}</p>
        </div>
      ) : !token ? (
        <div className="space-y-2 px-4 py-4" aria-busy="true">
          <div className="h-3 w-64 animate-pulse rounded-sm bg-muted" />
          <div className="h-20 w-full animate-pulse rounded-sm bg-muted/70" />
        </div>
      ) : decoded && !decoded.ok ? (
        <div className="px-4 py-4" role="alert">
          <StatusChip kind="failed" label="Not decodable" />
          <p className="mt-1 text-sm text-signal">{decoded.error}</p>
        </div>
      ) : decoded?.ok ? (
        <div>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5">
            <span className="text-xs text-muted-foreground">
              Expires {formatExpiry(expiry.expiresAt)}
            </span>
            <CopyButton value={token} label="Copy token" />
          </div>
          <div className="grid lg:grid-cols-2">
            <div className="border-b px-4 py-3 lg:border-r lg:border-b-0">
              <h3 className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">Header</h3>
              <pre className="font-data mt-1.5 overflow-x-auto text-xs leading-relaxed">
                {JSON.stringify(decoded.jwt.header, null, 2)}
              </pre>
            </div>
            <div className="min-w-0 px-4 py-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">Claims</h3>
                <CopyButton value={JSON.stringify(decoded.jwt.claims, null, 2)} label="Copy claims" />
              </div>
              <table className="mt-1.5 w-full text-xs">
                <tbody className="divide-y">
                  {orderClaims(decoded.jwt.claims).map(([key, value]) => (
                    <tr key={key}>
                      <th scope="row" className="font-data w-[34%] py-1 pr-3 text-left font-normal text-muted-foreground">
                        {key}
                      </th>
                      <td className="font-data py-1 break-all">{formatClaimValue(key, value)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="border-t px-4 py-2.5">
            <p className="text-xs text-muted-foreground">
              Signature segment: <Mono>{decoded.jwt.signature.slice(0, 24)}…</Mono>. Decoding does not verify it; the
              server verifies on every request.
            </p>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function TemplatePanel({
  record,
}: {
  record: (event: ClientActivityInput) => void;
}) {
  const { getToken, isSignedIn } = useAuth();
  const [template, setTemplate] = React.useState("custom");
  const [token, setToken] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(false);

  async function fetchTemplate() {
    const name = template.trim();
    if (!name) {
      setError("Enter a template name. Create templates in the dashboard under JWT templates.");
      return;
    }
    setLoading(true);
    setError(null);
    setToken(null);
    try {
      const next = await getToken({ template: name });
      if (!next) {
        const message = "No token returned. Create the template in the dashboard, or sign in first.";
        setError(message);
        record({ method: "unknown", outcome: "failed", detail: `Template ${name} returned no token` });
      } else {
        setToken(next);
        record({ method: "unknown", outcome: "success", detail: `Template ${name} token fetched` });
      }
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "The template request failed.";
      setError(message);
      record({ method: "unknown", outcome: "failed", detail: `Template ${name} failed: ${message}` });
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-labelledby="template-title" className="border">
      <div className="border-b px-4 py-3">
        <h2 id="template-title" className="text-base">
          Session token with a template
        </h2>
        <p className="text-xs text-muted-foreground">
          getToken({"{ template }"}) makes the instance mint a token with that template's claims.
        </p>
      </div>
      <form
        className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-end"
        onSubmit={(event) => {
          event.preventDefault();
          void fetchTemplate();
        }}
      >
        <div className="flex-1">
          <label htmlFor="template-name" className="text-xs font-medium">
            Template name
          </label>
          <Input
            id="template-name"
            value={template}
            onChange={(event) => setTemplate(event.target.value)}
            className="font-data mt-1 h-8"
            placeholder="custom"
            autoComplete="off"
          />
        </div>
        <Button type="submit" size="sm" disabled={!isSignedIn || loading}>
          {loading ? "Fetching" : "Fetch token"}
        </Button>
      </form>
      {error ? (
        <div className="border-t px-4 py-3" role="alert">
          <StatusChip kind="failed" label="Template failed" />
          <p className="mt-1 text-sm text-signal">{error}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            The template must exist on this instance and its claims must be valid.
          </p>
        </div>
      ) : null}
      {token ? (
        <div className="border-t px-4 py-3">
          <div className="flex items-center justify-between gap-2">
            <StatusChip kind="success" label="Token minted" />
            <CopyButton value={token} label="Copy template token" />
          </div>
          <pre className="font-data mt-2 max-h-40 overflow-auto text-xs leading-relaxed break-all whitespace-pre-wrap">{token}</pre>
        </div>
      ) : null}
    </section>
  );
}

function HasTester({
  record,
}: {
  record: (event: ClientActivityInput) => void;
}) {
  const auth = useAuth({ treatPendingAsSignedOut: false });
  const [kind, setKind] = React.useState<HasProbeKind>("permission");
  const [value, setValue] = React.useState("org:sys_memberships:manage");
  const [checked, setChecked] = React.useState<string | null>(null);

  const probe = buildHasProbe(kind, value);
  const allowed = probe.ok ? auth.has(probe.params) : false;
  const verdict = describeHasResult(allowed);
  const permissions = auth.orgPermissions ?? [];

  function check() {
    if (!probe.ok) {
      setChecked(probe.error);
      return;
    }
    setChecked(probe.expression);
    record({
      method: "unknown",
      outcome: allowed ? "success" : "failed",
      detail: `${probe.expression} → ${verdict.word}`,
    });
  }

  return (
    <section aria-labelledby="has-title" className="border">
      <div className="border-b px-4 py-3">
        <h2 id="has-title" className="text-base">
          has() tester
        </h2>
        <p className="text-xs text-muted-foreground">
          Checks the active session claims. Exactly one of role or permission, as the SDK requires.
        </p>
      </div>
      <div className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-wrap gap-1.5" role="group" aria-label="Check kind">
          {(["permission", "role"] as const).map((option) => (
            <Button
              key={option}
              type="button"
              size="xs"
              variant={kind === option ? "default" : "outline"}
              aria-pressed={kind === option}
              onClick={() => {
                setKind(option);
                setValue(option === "role" ? (auth.orgRole ?? "org:admin") : "org:sys_memberships:manage");
                setChecked(null);
              }}
            >
              {option === "permission" ? "Permission" : "Role"}
            </Button>
          ))}
        </div>
        <form
          className="flex flex-col gap-2 sm:flex-row sm:items-end"
          onSubmit={(event) => {
            event.preventDefault();
            check();
          }}
        >
          <div className="flex-1">
            <label htmlFor="has-value" className="text-xs font-medium">
              {kind === "role" ? "Role" : "Permission"}
            </label>
            <Input
              id="has-value"
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setChecked(null);
              }}
              className="font-data mt-1 h-8"
              placeholder={kind === "role" ? "org:admin" : "org:sys_memberships:manage"}
              autoComplete="off"
            />
          </div>
          <Button type="submit" size="sm">
            Run check
          </Button>
        </form>
        {!probe.ok ? (
          <p className="text-xs text-signal">{probe.error}</p>
        ) : (
          <div className="flex flex-wrap items-center gap-3">
            <code className="font-data rounded-sm border px-2 py-1 text-xs">{probe.expression}</code>
            <StatusChip kind={allowed ? "success" : "failed"} label={verdict.word} />
            <span className="text-xs text-muted-foreground">{verdict.detail}</span>
          </div>
        )}
        {permissions.length ? (
          <div>
            <p className="text-xs text-muted-foreground">Permissions on this session. Pick one.</p>
            <div className="mt-1 flex flex-wrap gap-1.5">
              {permissions.map((permission) => (
                <Button
                  key={permission}
                  type="button"
                  size="xs"
                  variant="outline"
                  className="font-data"
                  onClick={() => {
                    setKind("permission");
                    setValue(permission);
                    setChecked(null);
                  }}
                >
                  {permission}
                </Button>
              ))}
            </div>
          </div>
        ) : null}
        {checked ? <p className="font-data text-xs text-muted-foreground">Last run: {checked}</p> : null}
      </div>
    </section>
  );
}

function SessionsTable() {
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

function ActivitySection({
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

export function Inspector() {
  const { events, record, clear } = useClientActivity();
  const { isLoaded } = useAuth({ treatPendingAsSignedOut: false });

  return (
    <div className="space-y-8">
      {!isLoaded ? (
        <div className="border px-4 py-3" aria-busy="true">
          <div className="h-4 w-40 animate-pulse rounded-sm bg-muted" />
        </div>
      ) : null}
      <SessionState />
      <TokenPanel record={record} />
      <TemplatePanel record={record} />
      <HasTester record={record} />
      <SessionsTable />
      <ActivitySection record={record} events={events} clear={clear} />
    </div>
  );
}
