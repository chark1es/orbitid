import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import type { EnvironmentJSON, InstanceSettings } from "@orbitid/shared";
import {
  Button,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
} from "@orbitid/ui";
import {
  CircleAlert,
  CircleCheck,
  CircleX,
  Copy,
  Database,
  Eye,
  EyeOff,
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { getApiUrl, getSecretKey } from "../lib/api";
import { fetchInstanceHealth, type InstanceHealth } from "../lib/instance-health";
import {
  FRAMEWORKS,
  buildConnectPlan,
  connectTarget,
  renderBlockWithHeader,
  renderEnvBlock,
  renderEnvBlocks,
  serverSummary,
  setupChecks,
  type CheckState,
  type ConnectBlock,
  type FrameworkKey,
} from "./_config/connect";
import {
  CopyButton,
  ErrorAlert,
  LoadingPage,
  MetaChip,
  Notice,
  PageHeader,
  SettingsSection,
} from "./_config/ui";
import { useSettingsEditor } from "./_config/use-settings";

interface EnvironmentSummary {
  firstFactors: string[];
  signUpMode: string;
  applicationName: string;
}

async function fetchEnvironment(apiUrl: string, signal: AbortSignal): Promise<EnvironmentSummary> {
  const res = await fetch(`${apiUrl}/v1/client/environment`, { signal });
  if (!res.ok) throw new Error(`GET ${apiUrl}/v1/client/environment returned ${res.status}`);
  const body = (await res.json()) as EnvironmentJSON;
  return {
    firstFactors: Array.isArray(body?.auth_config?.first_factors) ? body.auth_config.first_factors : [],
    signUpMode: body?.auth_config?.sign_up_mode ?? "public",
    applicationName: body?.display_config?.application_name ?? "This instance",
  };
}

function SnippetBlock({
  block,
  reveal,
  onToggleReveal,
}: {
  block: ConnectBlock;
  reveal: boolean;
  onToggleReveal: () => void;
}) {
  const display = renderEnvBlock(block, reveal);
  // Copying always yields the real values: masking is a screen concern only. The heading travels with the
  // block so a paste into a chat or a ticket keeps its "where this goes" line.
  const copyValue = renderBlockWithHeader(block, true);
  const hasSecret = block.variables.some((variable) => variable.secret);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-sm font-semibold">{block.heading}</h3>
          <p className="max-w-[70ch] text-[0.8125rem] leading-relaxed text-muted-foreground">{block.where}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          {hasSecret ? (
            <Button variant="outline" size="sm" onClick={onToggleReveal}>
              {reveal ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
              {reveal ? "Hide secret" : "Reveal secret"}
            </Button>
          ) : null}
          <CopyButton value={copyValue} label="Copy" size="sm" variant="outline" />
        </div>
      </div>
      <figure className="overflow-hidden rounded-[4px] border border-border">
        <figcaption className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
          <span className="font-data text-[0.6875rem] text-muted-foreground">{block.filename}</span>
          <span className="text-[0.6875rem] text-muted-foreground">{block.id === "browser" ? "Public" : "Server only"}</span>
        </figcaption>
        <pre className="overflow-x-auto px-3 py-2.5 font-data text-[0.8125rem] leading-6">{display}</pre>
      </figure>
      {block.note ? <p className="max-w-[75ch] text-xs leading-relaxed text-muted-foreground">{block.note}</p> : null}
    </div>
  );
}

function CheckRow({ label, state, detail }: { label: string; state: CheckState; detail: string }) {
  const Icon = state === "ok" ? CircleCheck : state === "fail" ? CircleX : CircleAlert;
  const word = state === "ok" ? "Works" : state === "fail" ? "Failed" : "Check";
  return (
    <div className="flex items-start gap-3 border-b border-border py-2.5 last:border-b-0">
      <Icon
        className={
          state === "ok" ? "mt-0.5 size-4 shrink-0 text-go" : state === "fail" ? "mt-0.5 size-4 shrink-0 text-signal" : "mt-0.5 size-4 shrink-0 text-caution"
        }
        strokeWidth={1.5}
        aria-hidden
      />
      <div className="min-w-0 space-y-0.5">
        <p className="text-[0.8125rem] font-medium">
          {label} <span className="font-normal text-muted-foreground">· {word}</span>
        </p>
        <p className="text-xs leading-relaxed text-muted-foreground">{detail}</p>
      </div>
    </div>
  );
}

export default function Page() {
  const apiUrl = getApiUrl();
  const secretKey = getSecretKey();
  const settingsEditor = useSettingsEditor();
  const settings: InstanceSettings | null = settingsEditor.settings;
  const [framework, setFramework] = useState<FrameworkKey>("nextjs");
  const [revealed, setRevealed] = useState(false);

  const [health, setHealth] = useState<InstanceHealth | null>(null);
  const [healthError, setHealthError] = useState<string | null>(null);
  const [healthChecking, setHealthChecking] = useState(true);
  const [environment, setEnvironment] = useState<EnvironmentSummary | null>(null);
  const [environmentError, setEnvironmentError] = useState<string | null>(null);
  const [checkRun, setCheckRun] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setHealthChecking(true);
    setHealth(null);
    setHealthError(null);
    setEnvironment(null);
    setEnvironmentError(null);
    fetchInstanceHealth(apiUrl, controller.signal)
      .then((result) => {
        setHealth(result);
        setHealthChecking(false);
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setHealthError(error instanceof Error ? error.message : "The server did not answer.");
        setHealthChecking(false);
      });
    fetchEnvironment(apiUrl, controller.signal)
      .then(setEnvironment)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setEnvironmentError(error instanceof Error ? error.message : "The server did not answer.");
      });
    return () => controller.abort();
  }, [apiUrl, checkRun]);

  const target = useMemo(
    () =>
      connectTarget({
        publishableKey: health?.publishableKey ?? "",
        apiUrl,
        secretKey,
        homeUrl: settings?.application.homeUrl,
      }),
    [health?.publishableKey, apiUrl, secretKey, settings?.application.homeUrl],
  );
  const plan = useMemo(() => buildConnectPlan(framework, target), [framework, target]);
  const summary = useMemo(
    () => serverSummary({ apiUrl, database: health?.database ?? null, settings }),
    [apiUrl, health?.database, settings],
  );
  const checks = useMemo(
    () =>
      setupChecks({
        apiUrl,
        health: health ? { status: health.status, publishableKey: health.publishableKey, database: health.database } : null,
        healthError,
        environment,
        environmentError,
        publishableKey: target.publishableKey,
        secretKey,
        settings,
      }),
    [apiUrl, health, healthError, environment, environmentError, target.publishableKey, secretKey, settings],
  );

  const copyAll = async (blocks: readonly ConnectBlock[], label: string) => {
    try {
      // Masking never reaches the clipboard.
      await navigator.clipboard.writeText(renderEnvBlocks(blocks, true));
      toast.success(`Copied ${label}`);
    } catch {
      toast.error("Could not copy", { description: "Select the block and copy it manually." });
    }
  };

  const withoutSecretKey = [
    `NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY=${target.publishableKey || "pk_test_…"}`,
    `NEXT_PUBLIC_ORBITID_API_URL=${target.apiUrl}`,
    "ORBITID_SECRET_KEY=sk_test_…",
  ].join("\n");

  if (settingsEditor.isLoading && !settings) return <LoadingPage rows={4} />;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Connect your app"
        description="Copy the values for this instance into a new application. The publishable key is public; the secret key stays on a server."
        badge={<MetaChip>{target.publishableKey ? "Instance ready" : "Checking instance"}</MetaChip>}
        actions={
          <Button variant="outline" size="sm" onClick={() => setCheckRun((value) => value + 1)} disabled={healthChecking}>
            {healthChecking ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
            {healthChecking ? "Checking…" : "Run check again"}
          </Button>
        }
      />

      <SettingsSection
        title="This instance"
        description="Read from the running server and this signed-in session, not from placeholders."
      >
        <dl className="divide-y divide-border border-y border-border">
          <div className="flex flex-wrap items-baseline justify-between gap-3 py-2">
            <dt className="text-[0.8125rem] font-medium">API URL</dt>
            <dd className="flex min-w-0 items-center gap-1">
              <code className="min-w-0 truncate font-data text-xs text-muted-foreground">{apiUrl}</code>
              <CopyButton value={apiUrl} size="icon-sm" />
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-3 py-2">
            <dt className="text-[0.8125rem] font-medium">
              Publishable key <span className="font-normal text-muted-foreground">· public</span>
            </dt>
            <dd className="flex min-w-0 items-center gap-1">
              <code className="min-w-0 truncate font-data text-xs text-muted-foreground">
                {target.publishableKey || (healthChecking ? "Reading /health…" : "Not reported by this server")}
              </code>
              {target.publishableKey ? <CopyButton value={target.publishableKey} size="icon-sm" /> : null}
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-3 py-2">
            <dt className="text-[0.8125rem] font-medium">
              Secret key <span className="font-normal text-muted-foreground">· this session, server only</span>
            </dt>
            <dd className="flex min-w-0 items-center gap-1">
              <code className="min-w-0 truncate font-data text-xs text-muted-foreground">
                {secretKey ? (revealed ? secretKey : `${secretKey.slice(0, 8)}${"•".repeat(12)}`) : "Not in this session"}
              </code>
              {secretKey ? (
                <Button variant="ghost" size="icon-sm" onClick={() => setRevealed((value) => !value)} title={revealed ? "Hide" : "Reveal"}>
                  {revealed ? <EyeOff className="size-3.5" aria-hidden /> : <Eye className="size-3.5" aria-hidden />}
                  <span className="sr-only">{revealed ? "Hide secret key" : "Reveal secret key"}</span>
                </Button>
              ) : null}
              {secretKey ? <CopyButton value={secretKey} size="icon-sm" /> : null}
            </dd>
          </div>
          <div className="flex flex-wrap items-baseline justify-between gap-3 py-2">
            <dt className="text-[0.8125rem] font-medium">
              Database <span className="font-normal text-muted-foreground">· where the data lives</span>
            </dt>
            <dd className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <Database className="size-3.5" strokeWidth={1.5} aria-hidden />
              <span className="font-data">{summary[0]?.value ?? "Unknown"}</span>
            </dd>
          </div>
        </dl>
        {healthError ? <ErrorAlert error={healthError} onRetry={() => setCheckRun((value) => value + 1)} /> : null}
      </SettingsSection>

      <SettingsSection
        title="Framework"
        description="The tabs change the variable names and the install line. The values come from this instance in every case."
      >
        <Tabs value={framework} onValueChange={(value) => setFramework(value as FrameworkKey)}>
          <TabsList variant="line" className="flex-wrap">
            {FRAMEWORKS.map((item) => (
              <TabsTrigger key={item.key} value={item.key}>
                {item.label}
              </TabsTrigger>
            ))}
          </TabsList>
          {FRAMEWORKS.map((item) => (
            <TabsContent key={item.key} value={item.key} className="space-y-5 pt-3">
              <div className="flex flex-wrap items-center justify-between gap-2 border-y border-border py-2">
                <code className="font-data text-xs">{item.install}</code>
                <CopyButton value={item.install} label="Copy install" size="sm" variant="outline" />
              </div>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-[0.8125rem] leading-relaxed text-muted-foreground">
                  Secrets are masked on screen. Copying always copies the real values.
                </p>
                <Button variant="outline" size="sm" onClick={() => void copyAll(plan.blocks, `${plan.label} environment`)}>
                  <Copy className="size-4" aria-hidden /> Copy all
                </Button>
              </div>
              {plan.blocks.map((block) => (
                <SnippetBlock key={block.id} block={block} reveal={revealed} onToggleReveal={() => setRevealed((value) => !value)} />
              ))}
              <div className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-semibold">First file</h3>
                    <p className="text-[0.8125rem] text-muted-foreground">Where this goes: {plan.sample.title}</p>
                  </div>
                  <CopyButton value={plan.sample.code} label="Copy code" size="sm" variant="outline" />
                </div>
                <figure className="overflow-hidden rounded-[4px] border border-border">
                  <figcaption className="border-b border-border bg-muted/40 px-3 py-1.5 font-data text-[0.6875rem] text-muted-foreground">
                    {plan.sample.title}
                  </figcaption>
                  <pre className="overflow-x-auto px-3 py-2.5 font-data text-[0.8125rem] leading-6">{plan.sample.code}</pre>
                </figure>
              </div>
            </TabsContent>
          ))}
        </Tabs>
      </SettingsSection>

      <SettingsSection
        title="Server (this instance)"
        description="What the running server is configured with. Read-only: change these on their own settings pages."
      >
        <dl className="divide-y divide-border border-y border-border">
          {summary.map((row) => (
            <div key={row.label} className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:justify-between sm:gap-6">
              <dt className="shrink-0 text-[0.8125rem] font-medium">{row.label}</dt>
              <dd className="min-w-0 text-right sm:max-w-[42ch]">
                <span className="font-data text-xs">{row.value}</span>
                {row.detail ? <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{row.detail}</span> : null}
              </dd>
            </div>
          ))}
        </dl>
        <div className="flex flex-wrap items-center gap-3">
          <p className="text-xs leading-relaxed text-muted-foreground">
            Server environment variables (database URL, encryption key, port) are documented in{" "}
            <code className="font-data">docs/ENVIRONMENT.md</code>; the deployment guide today is{" "}
            <code className="font-data">docs/SELF_HOSTING.md</code>. The encryption key is never shown here or by any API.
          </p>
          <a
            className="text-xs font-medium underline-offset-4 hover:underline"
            href={`${apiUrl}/docs`}
            target="_blank"
            rel="noreferrer"
          >
            Open the API reference
          </a>
        </div>
      </SettingsSection>

      <SettingsSection
        title="Check your setup"
        description="Calls the public health and environment endpoints and reads the saved settings. Nothing here changes the instance."
        actions={
          <Button variant="outline" size="sm" onClick={() => setCheckRun((value) => value + 1)} disabled={healthChecking}>
            {healthChecking ? <Loader2 className="size-4 animate-spin" aria-hidden /> : <RefreshCw className="size-4" aria-hidden />}
            Run again
          </Button>
        }
      >
        <div className="border-y border-border">
          {checks.map((check) => (
            <CheckRow key={check.id} label={check.label} state={check.state} detail={check.detail} />
          ))}
        </div>
        <p className="text-xs leading-relaxed text-muted-foreground">
          Two checks the dashboard cannot make: whether your app's origin is reachable from a browser, and whether the
          server can reach your SMTP host. Send a test email from{" "}
          <Link to="/settings/email-sms" className="font-medium underline-offset-4 hover:underline">
            Email &amp; SMS
          </Link>{" "}
          to confirm delivery.
        </p>
        {!target.publishableKey && !healthChecking ? (
          <Notice tone="caution" title="The health endpoint did not return a publishable key">
            <p>Snippets below keep a placeholder. Fix the server first, then run this check again.</p>
          </Notice>
        ) : null}
        {!secretKey ? (
          <div className="space-y-2">
            <Notice tone="danger" title="No secret key in this session">
              <p>
                This dashboard was opened without a stored key, so the backend block cannot be filled in. Sign in again to
                read it from the session.
              </p>
            </Notice>
            <figure className="overflow-hidden rounded-[4px] border border-border">
              <figcaption className="border-b border-border bg-muted/40 px-3 py-1.5 font-data text-[0.6875rem] text-muted-foreground">
                Placeholders
              </figcaption>
              <pre className="overflow-x-auto px-3 py-2.5 font-data text-[0.8125rem] leading-6">{withoutSecretKey}</pre>
            </figure>
            <CopyButton value={withoutSecretKey} label="Copy placeholders" size="sm" variant="outline" />
          </div>
        ) : null}
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
          Rotate the secret key if it was ever pasted into a browser bundle, a chat message or a public repository. Anyone
          who holds it can read and change every user.
        </p>
      </SettingsSection>
    </div>
  );
}
