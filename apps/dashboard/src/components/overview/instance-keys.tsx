import { useState, type ReactNode } from "react";
import type { InstanceSettings } from "@orbitid/shared";
import { Badge, Button } from "@orbitid/ui";
import { Eye, KeyRound, TriangleAlert } from "lucide-react";
import { getApiUrl, getSecretKey } from "../../lib/api";
import { homeUrlOf, type HealthJSON } from "../../lib/instance";
import { CopyButton } from "../shared/copy-button";
import { SecretReveal } from "../shared/secret-reveal";
import { Panel, Section } from "../shared/section";
import { Snippet } from "./snippet";

function KeyRow({
  label,
  value,
  copyLabel,
  hint,
  children,
}: {
  label: string;
  value: string;
  copyLabel: string;
  hint?: string;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1 border-b border-border px-4 py-2.5 last:border-b-0 sm:flex-row sm:items-center sm:gap-4">
      <div className="sm:w-44 sm:shrink-0">
        <p className="text-sm font-medium">{label}</p>
        {hint ? <p className="text-xs leading-5 text-muted-foreground">{hint}</p> : null}
      </div>
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <code className="min-w-0 flex-1 truncate font-data text-[0.8125rem] leading-5 text-muted-foreground">
          {value || "—"}
        </code>
        {children}
        <CopyButton value={value} label={copyLabel} size="icon-sm" />
      </div>
    </div>
  );
}

/**
 * Publishable key and copy-paste setup, from `GET /health` and `GET /instance`. The secret key is
 * read from the session and only shown after an explicit reveal.
 */
export function InstanceKeys({
  health,
  healthError,
  instance,
  loading,
}: {
  health: HealthJSON | undefined;
  healthError: unknown;
  instance: InstanceSettings | undefined;
  loading: boolean;
}) {
  const [revealSecret, setRevealSecret] = useState(false);
  const publishableKey = health?.publishable_key ?? "";
  const apiUrl = getApiUrl();
  const homeUrl = homeUrlOf(instance);
  const signInUrl = homeUrl ? `${homeUrl.replace(/\/+$/, "")}/sign-in` : "https://your-app.example.com/sign-in";
  const secretKey = getSecretKey();

  const nextEnv = [
    `NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY=${publishableKey || "pk_test_…"}`,
    `NEXT_PUBLIC_ORBITID_SIGN_IN_URL=${signInUrl}`,
    "ORBITID_SECRET_KEY=sk_test_…",
  ].join("\n");

  const backendEnv = [
    `ORBITID_API_URL=${apiUrl}`,
    "ORBITID_SECRET_KEY=sk_test_…",
  ].join("\n");

  const backendCode = [
    'import { createOrbitIdClient } from "@orbitid/backend";',
    "",
    "const orbit = createOrbitIdClient({",
    "  secretKey: process.env.ORBITID_SECRET_KEY,",
    "  apiUrl: process.env.ORBITID_API_URL,",
    "});",
  ].join("\n");

  return (
    <Section
      title="Keys"
      description="The publishable key goes in the browser. The secret key stays on your server and is never shipped to a client bundle."
      actions={
        <Badge variant="outline" className="font-normal">
          {loading ? "Checking instance" : health ? "Instance reachable" : "Instance status unknown"}
        </Badge>
      }
    >
      <Panel>
        <KeyRow label="Publishable key" value={publishableKey} copyLabel="Copy publishable key" />
        <KeyRow label="Frontend API URL" value={apiUrl} copyLabel="Copy frontend API URL" />
        <KeyRow
          label="Secret key"
          value={secretKey ? `${secretKey.slice(0, 8)}${"•".repeat(12)}` : "Not in this session"}
          copyLabel="Copy secret key"
          hint="Server only"
        >
          <Button type="button" variant="outline" size="sm" onClick={() => setRevealSecret(true)} disabled={!secretKey}>
            <Eye aria-hidden /> Reveal
          </Button>
        </KeyRow>
      </Panel>

      {healthError ? (
        <p role="alert" className="mt-3 flex items-start gap-2 text-sm leading-6">
          <TriangleAlert className="mt-1 size-4 shrink-0 text-signal" strokeWidth={1.5} aria-hidden />
          <span>
            The publishable key could not be read from <code className="font-data text-xs">{apiUrl}/health</code>. Start the
            server at that address, or sign out and point the dashboard at another frontend API URL.
          </span>
        </p>
      ) : null}

      <div className="mt-4 space-y-4">
        <div className="min-w-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Next.js</p>
            <CopyButton value={nextEnv} label="Copy .env" size="xs" variant="outline" />
          </div>
          <Snippet title=".env.local" code={nextEnv} />
        </div>
        <div className="min-w-0 space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Backend</p>
            <CopyButton value={backendCode} label="Copy setup" size="xs" variant="outline" />
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <Snippet title="server.ts" code={backendCode} />
            <Snippet title=".env" code={backendEnv} />
          </div>
        </div>
      </div>

      {homeUrl ? (
        <p className="mt-3 text-xs leading-5 text-muted-foreground">
          Sign-in redirects go to <code className="font-data">{homeUrl}</code>, from instance settings.
        </p>
      ) : (
        <p className="mt-3 flex items-start gap-1.5 text-xs leading-5 text-muted-foreground">
          <KeyRound className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
          No application home URL is set. Set it under Settings, Appearance so sign-in redirects have a destination.
        </p>
      )}

      <SecretReveal
        open={revealSecret}
        onOpenChange={setRevealSecret}
        title="Secret key"
        description="Grants full Backend API access for this session."
        secret={secretKey}
        warning="Anyone with this key can read and change every user, session and organization. Keep it server-side and rotate it if it leaks."
      />
    </Section>
  );
}
