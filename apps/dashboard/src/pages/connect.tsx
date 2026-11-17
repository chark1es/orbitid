import { useEffect, useMemo, useState } from "react";
import { Page as PageLayout } from "../components/shared/page";
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
  Loader2,
  RefreshCw,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";
import { getApiUrl } from "../lib/api";
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
import { useAuth } from "../lib/auth";

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

function SnippetBlock({ block }: { block: ConnectBlock }) {
  // The heading travels with the block so a paste into a chat or a ticket keeps its "where this goes" line.
  const copyValue = renderBlockWithHeader(block);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 space-y-0.5">
          <h3 className="text-sm font-heading">{block.heading}</h3>
          <p className="max-w-[70ch] text-[0.8125rem] leading-relaxed text-muted-foreground">{block.where}</p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <CopyButton value={copyValue} label="Copy" size="sm" variant="outline" />
        </div>
      </div>
      <figure className="overflow-hidden rounded-[4px] border border-border">
        <figcaption className="flex items-center justify-between gap-2 border-b border-border bg-muted/40 px-3 py-1.5">
          <span className="font-data text-[0.6875rem] text-muted-foreground">{block.filename}</span>
          <span className="text-[0.6875rem] text-muted-foreground">{block.id === "browser" ? "Public" : "Server only"}</span>
        </figcaption>
        <pre className="overflow-x-auto px-3 py-2.5 font-data text-[0.8125rem] leading-6">{renderEnvBlock(block)}</pre>
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
  const { authenticated } = useAuth();
  const settingsEditor = useSettingsEditor();
  const settings: InstanceSettings | null = settingsEditor.settings;
  const [framework, setFramework] = useState<FrameworkKey>("nextjs");

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
        homeUrl: settings?.application.homeUrl,
      }),
    [health?.publishableKey, apiUrl, settings?.application.homeUrl],
  );
  const plan = useMemo(() => buildConnectPlan(framework, target), [framework, target]);
  const summary = useMemo(
    () => serverSummary({ apiUrl, database: health?.database ?? null, databaseDriver: health?.databaseDriver ?? null, settings }),
    [apiUrl, health?.database, health?.databaseDriver, settings],
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
        sessionActive: authenticated,
        settings,
      }),
    [apiUrl, health, healthError, environment, environmentError, target.publishableKey, authenticated, settings],
  );

  const copyAll = async (blocks: readonly ConnectBlock[], label: string) => {
    try {
      await navigator.clipboard.writeText(renderEnvBlocks(blocks));
      toast.success(`Copied ${label}`);
    } catch {
      toast.error("Could not copy", { description: "Select the block and copy it manually." });
    }
  };

  if (settingsEditor.isLoading && !settings) return <LoadingPage rows={4} />;

  return (
    <PageLayout>
      <PageHeader
        title="Connect your app"
        description="Copy the values for this instance into a new application. The publishable key is public; the secret key stays on a server and is never held by this dashboard."
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
              Dashboard session <span className="font-normal text-muted-foreground">· httpOnly cookie</span>
            </dt>
            <dd className="flex min-w-0 items-center gap-1">
              <span className="text-xs text-muted-foreground">
                {authenticated ? "Signed in. The secret key is not kept in this page." : "No live session"}
              </span>
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
                  The secret key is a placeholder: copy the real value from the server, not from this page.
                </p>
                <Button variant="outline" size="sm" onClick={() => void copyAll(plan.blocks, `${plan.label} environment`)}>
                  <Copy className="size-4" aria-hidden /> Copy all
                </Button>
              </div>
              {plan.blocks.map((block) => (
                <SnippetBlock key={block.id} block={block} />
              ))}
              <div className="space-y-2">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <h3 className="text-sm font-heading">First file</h3>
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
        <p className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
          <ShieldAlert className="mt-0.5 size-3.5 shrink-0" strokeWidth={1.5} aria-hidden />
          The dashboard signs in with the secret key once and then holds only an httpOnly session cookie, so the backend
          blocks keep a placeholder. Print the real key with <code className="font-data">orbitid keys</code> and put it in
          your server's environment, and rotate it if it was ever pasted into a browser bundle or a public repository.
        </p>
      </SettingsSection>
    </PageLayout>
  );
}
