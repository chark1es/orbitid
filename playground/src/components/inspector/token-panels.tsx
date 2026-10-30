"use client";

import * as React from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { Button, Input } from "@orbitid/ui";
import { useAuth } from "@orbitid/react";
import { CopyButton } from "../copy-button";
import { StatusChip } from "../status-chip";
import { type ClientActivityInput } from "./use-client-activity";
import {
  decodeJwt,
  formatClaimValue,
  formatExpiry,
  formatRemaining,
  orderClaims,
  tokenExpiry,
} from "@/lib/jwt";
import { Mono } from "./shared";

export function TokenPanel({
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
    // A hidden tab has nobody to show the token to; catch up as soon as it is visible again.
    const refreshTimer = window.setInterval(() => {
      if (!document.hidden) void refresh();
    }, 30_000);
    const onVisible = () => {
      if (!document.hidden) void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.clearInterval(refreshTimer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [isSignedIn, refresh]);

  React.useEffect(() => {
    const ticker = window.setInterval(() => {
      if (!document.hidden) setNow(Date.now());
    }, 1000);
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

export function TemplatePanel({
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
