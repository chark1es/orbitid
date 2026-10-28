import { useState } from "react";
import type { InstanceSettings } from "@orbitid/shared";
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
  Separator,
} from "@orbitid/ui";
import { Eye, KeyRound } from "lucide-react";
import { getApiUrl, getSecretKey } from "../../lib/api";
import { homeUrlOf, type HealthJSON } from "../../lib/instance";
import { CopyButton } from "../shared/copy-button";
import { SecretReveal } from "../shared/secret-reveal";

function KeyRow({ label, value, masked }: { label: string; value: string; masked?: boolean }) {
  return (
    <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
      <span className="text-sm text-muted-foreground">{label}</span>
      <div className="flex min-w-0 items-center gap-1">
        <code className="min-w-0 truncate rounded bg-muted px-2 py-1 font-mono text-xs">{value || "—"}</code>
        {!masked && value ? <CopyButton value={value} label={`Copy ${label.toLowerCase()}`} size="icon" /> : null}
      </div>
    </div>
  );
}

/** Publishable key + copy-paste Next.js env, sourced from `GET /health` and `GET /instance`. */
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
  const homeUrl = homeUrlOf(instance);
  const signInUrl = homeUrl ? `${homeUrl.replace(/\/+$/, "")}/sign-in` : "<your app sign-in URL>";
  const snippet = [
    "NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY=" + (publishableKey || "pk_test_…"),
    `NEXT_PUBLIC_ORBITID_SIGN_IN_URL=${signInUrl}`,
    "ORBITID_SECRET_KEY=sk_test_…",
  ].join("\n");
  const secretKey = getSecretKey();

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <KeyRound className="size-4 text-muted-foreground" aria-hidden />
          Instance keys
        </CardTitle>
        <CardDescription>
          Publishable keys are safe in the browser. Secret keys are server-only — never expose them to a client bundle.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-2.5">
          <KeyRow label="Publishable key" value={publishableKey} />
          <KeyRow label="Frontend API URL" value={getApiUrl()} />
          <div className="flex flex-col gap-1.5 sm:flex-row sm:items-center sm:justify-between">
            <span className="text-sm text-muted-foreground">Secret key</span>
            <div className="flex min-w-0 items-center gap-2">
              <code className="min-w-0 truncate rounded bg-muted px-2 py-1 font-mono text-xs">
                {secretKey ? `${secretKey.slice(0, 8)}${"•".repeat(12)}` : "—"}
              </code>
              <Button type="button" variant="outline" size="sm" onClick={() => setRevealSecret(true)} disabled={!secretKey}>
                <Eye aria-hidden /> Reveal
              </Button>
            </div>
          </div>
        </div>

        <Separator />

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <p className="text-sm font-medium">Next.js environment</p>
            <CopyButton value={snippet} label="Copy .env" size="sm" variant="outline" />
          </div>
          <pre className="overflow-x-auto rounded-lg border bg-muted/40 p-3 font-mono text-xs leading-relaxed">{snippet}</pre>
          {healthError ? (
            <p className="text-xs text-muted-foreground">
              Publishable key unavailable from <code>{getApiUrl()}/health</code>. Check the instance URL.
            </p>
          ) : null}
        </div>

        <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline">{loading ? "Checking instance…" : health ? "Instance reachable" : "Instance status unknown"}</Badge>
          {homeUrl ? <span>App origin: {homeUrl}</span> : null}
        </div>
      </CardContent>
      <SecretReveal
        open={revealSecret}
        onOpenChange={setRevealSecret}
        title="Secret key"
        description="Full Backend API access. Treat it like a password."
        secret={secretKey}
        warning="Anyone with this key can read and modify every user, session and organization. Keep it server-side."
      />
    </Card>
  );
}
