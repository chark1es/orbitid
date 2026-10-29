import { CopyButton } from "./copy-button";
import { StatusChip } from "./status-chip";
import type { InstanceStatus } from "@/lib/env";
import { formatClock } from "@/lib/format";

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-1.5 px-4 py-3 sm:grid-cols-[190px_1fr] sm:gap-4">
      <dt className="text-[0.6875rem] font-semibold tracking-[0.04em] text-muted-foreground uppercase">{label}</dt>
      <dd className="min-w-0 text-sm">{children}</dd>
    </div>
  );
}

/** Where every value came from, so the operator can tell a stale env file from a wrong server. */
export function ConnectionPanel({ status }: { status: InstanceStatus }) {
  const health = status.health;
  return (
    <section aria-labelledby="connection-title" className="border">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b px-4 py-3">
        <h2 id="connection-title" className="text-base">
          Connection
        </h2>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span>{status.publishableKey ? `Checked at ${formatClock(health.checkedAt)}` : "Not checked"}</span>
          {!status.publishableKey ? (
            <StatusChip kind="needs-config" label="No instance" />
          ) : health.reachable ? (
            <StatusChip kind="success" label={`HTTP ${health.status ?? 200}`} />
          ) : (
            <StatusChip kind="failed" label="Unreachable" />
          )}
        </div>
      </div>
      <dl className="divide-y">
        <Row label="Publishable key">
          <div className="flex flex-wrap items-start gap-2">
            <div className="min-w-0 flex-1">
              <p className="font-data text-xs break-all text-foreground">
                {status.publishableKey ?? "NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY is not set"}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                {status.publishableKey
                  ? status.publishableKeyValid
                    ? `Read from NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY, ${status.publishableKeyEnv ?? "unknown"} key.`
                    : "The value is not a valid pk_test or pk_live key."
                  : "Add it to playground/.env.local, then restart the dev server."}
              </p>
            </div>
            {status.publishableKey ? <CopyButton value={status.publishableKey} label="Copy key" /> : null}
          </div>
        </Row>
        <Row label="API URL">
          <p className="font-data text-xs break-all">{status.apiUrl}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {status.apiUrlFromKey
              ? "Decoded from the publishable key. Set ORBITID_API_URL to override it."
              : status.publishableKey
                ? "From ORBITID_API_URL."
                : "Default. Set the publishable key or ORBITID_API_URL."}
          </p>
        </Row>
        <Row label="Secret key">
          <StatusChip kind={status.secretKeyPresent ? "success" : "off"} label={status.secretKeyPresent ? "Present" : "Not set"} />
          <p className="mt-1 text-xs text-muted-foreground">
            {status.secretKeyPresent
              ? "Backend actions are available: seed data, webhook endpoints and session settings."
              : "Set ORBITID_SECRET_KEY to unlock seed data, webhook registration and session settings."}
          </p>
        </Row>
        <Row label="Webhook secret">
          <StatusChip
            kind={status.webhookSecretPresent ? "success" : "off"}
            label={status.webhookSecretPresent ? "Present" : "Not set"}
          />
          <p className="mt-1 text-xs text-muted-foreground">
            {status.webhookSecretPresent
              ? "The receiver verifies signatures with ORBITID_WEBHOOK_SECRET."
              : "Register the receiver on the Webhooks page, or set ORBITID_WEBHOOK_SECRET."}
          </p>
        </Row>
        <Row label="Health check">
          {health.reachable ? (
            <>
              <p className="text-sm">
                {health.latencyMs !== null ? `${health.latencyMs} ms` : "Answered"}
                {health.database ? ` · database ${health.database}` : " · database not reported by /health"}
              </p>
              <p className="font-data mt-1 text-xs text-muted-foreground">{status.apiUrl}/health</p>
            </>
          ) : (
            <>
              <p className={`text-sm ${status.publishableKey ? "text-signal" : "text-muted-foreground"}`}>
                {health.error ?? "The health check did not answer."}
              </p>
              <p className="mt-1 text-xs text-muted-foreground">
                The pages still load. Only data that needs the instance is missing.
              </p>
            </>
          )}
        </Row>
      </dl>
      {health.keyMatches === false ? (
        <p role="alert" className="border-t px-4 py-3 text-xs text-signal">
          The server reports a different publishable key. Copy the key printed by this server into{" "}
          <code className="font-data">playground/.env.local</code> and restart the dev server.
        </p>
      ) : null}
    </section>
  );
}
