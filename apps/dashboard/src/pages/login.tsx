import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button, Input, Label } from "@orbitid/ui";
import { Check, Eye, EyeOff, Loader2, Sun, TriangleAlert, X } from "lucide-react";
import { api, API_URL, ApiError, getApiUrl, setApiUrl, setSecretKey } from "../lib/api";
import { useAuth } from "../lib/auth";
import { errorMessage } from "../lib/errors";
import { databaseLabel, fetchInstanceHealth, type InstanceHealth } from "../lib/instance-health";
import { ThemeToggle } from "../components/layout/theme-toggle";

type HealthState =
  | { state: "checking" }
  | { state: "ok"; result: InstanceHealth }
  | { state: "error" };

function redirectTarget(state: unknown): string {
  if (state && typeof state === "object" && "from" in state && typeof state.from === "string" && state.from.startsWith("/")) {
    return state.from;
  }
  return "/";
}

function OrbitMark() {
  return (
    <svg viewBox="0 0 32 32" className="size-5" aria-hidden="true">
      <circle cx="16" cy="16" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" />
      <circle cx="16" cy="16" r="2.5" fill="currentColor" />
    </svg>
  );
}

export default function LoginPage() {
  const { authenticated, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [apiUrl, setApiUrlInput] = useState(getApiUrl());
  const [secretKey, setSecretKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [health, setHealth] = useState<HealthState>({ state: "checking" });
  const [checkCount, setCheckCount] = useState(0);

  useEffect(() => {
    document.title = "Sign in · OrbitID";
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    const url = apiUrl.trim();
    setHealth({ state: "checking" });
    if (!url) return () => controller.abort();

    const timer = setTimeout(() => {
      fetchInstanceHealth(url, controller.signal)
        .then((result) => setHealth({ state: "ok", result }))
        .catch(() => {
          if (!controller.signal.aborted) setHealth({ state: "error" });
        });
    }, 450);

    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [apiUrl, checkCount]);

  if (authenticated) return <Navigate to={redirectTarget(location.state)} replace />;

  async function onSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    if (!apiUrl.trim()) {
      setError("Enter the URL of your instance, for example http://localhost:4000.");
      return;
    }
    if (!secretKey.trim()) {
      setError("Enter the secret key. It is printed when the server starts.");
      return;
    }
    setPending(true);
    // Validate before committing the key so a typo does not poison every later request.
    setApiUrl(apiUrl);
    setSecretKey(secretKey);
    try {
      await api("GET", "/instance");
      signIn(apiUrl, secretKey);
      navigate(redirectTarget(location.state), { replace: true });
    } catch (cause) {
      setSecretKey(null);
      if (cause instanceof ApiError && cause.status === 401) {
        setError(
          `The server rejected that secret key. Copy the key that starts with sk_ from the server log or from ./data/keys.json, then sign in again.`,
        );
      } else {
        setError(errorMessage(cause, "The instance did not answer. Check the URL and that the server is running."));
      }
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="min-h-svh bg-background">
      <header className="flex h-12 items-center justify-between border-b border-border px-6">
        <div className="flex items-center gap-2.5">
          <span className="flex size-6 items-center justify-center rounded-sm bg-primary text-primary-foreground">
            <OrbitMark />
          </span>
          <span className="text-sm font-semibold">OrbitID</span>
        </div>
        <ThemeToggle />
      </header>

      <main className="mx-auto grid w-full max-w-[1040px] grid-cols-[minmax(0,1fr)] gap-10 px-6 py-12 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] lg:gap-16 lg:py-20">
        <section aria-labelledby="sign-in-heading" className="min-w-0">
          <h1 id="sign-in-heading" className="text-[1.75rem] leading-tight">
            Sign in with your secret key
          </h1>
          <p className="mt-2 max-w-[60ch] text-sm text-muted-foreground">
            The dashboard manages this instance through the Backend API. The key stays in this tab's session storage.
          </p>

          <form onSubmit={onSubmit} className="mt-8 space-y-5" noValidate>
            <div className="space-y-1.5">
              <Label htmlFor="api-url">API URL</Label>
              <Input
                id="api-url"
                name="apiUrl"
                value={apiUrl}
                onChange={(event) => setApiUrlInput(event.target.value)}
                placeholder={API_URL}
                autoComplete="url"
                spellCheck={false}
                className="font-data"
              />
              <p className="text-xs text-muted-foreground">
                Origin that serves the OrbitID API, without a trailing slash.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="secret-key">Secret key</Label>
              <div className="relative">
                <Input
                  id="secret-key"
                  name="secretKey"
                  type={showKey ? "text" : "password"}
                  value={secretKey}
                  onChange={(event) => setSecretKeyInput(event.target.value)}
                  placeholder="sk_..."
                  autoComplete="off"
                  spellCheck={false}
                  className="pr-9 font-data"
                  aria-invalid={!!error}
                  aria-describedby={error ? "sign-in-error" : undefined}
                />
                <button
                  type="button"
                  className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-md text-muted-foreground hover:text-foreground"
                  aria-label={showKey ? "Hide secret key" : "Show secret key"}
                  aria-pressed={showKey}
                  onClick={() => setShowKey((current) => !current)}
                >
                  {showKey ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Server-side key. The publishable key is for browsers and cannot sign in here.
              </p>
            </div>

            {error ? (
              <div id="sign-in-error" role="alert" className="rounded-md border border-signal/50 bg-signal/10 px-3 py-2.5">
                <p className="flex items-start gap-2 text-sm font-medium text-foreground">
                  <TriangleAlert className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
                  Could not sign in
                </p>
                <p className="mt-1 pl-6 text-sm text-muted-foreground">{error}</p>
              </div>
            ) : null}

            <Button type="submit" className="w-full" disabled={pending}>
              {pending ? <Loader2 className="animate-spin" aria-hidden /> : null}
              {pending ? "Checking the key" : "Sign in"}
            </Button>
          </form>

          <ConnectionResult apiUrl={apiUrl} health={health} onRetry={() => setCheckCount((count) => count + 1)} />
        </section>

        <aside className="min-w-0 lg:border-l lg:border-border lg:pl-10" aria-labelledby="key-location-heading">
          <h2 id="key-location-heading" className="text-base font-semibold">
            Where the key is
          </h2>
          <p className="mt-2 max-w-[62ch] text-sm leading-6 text-muted-foreground">
            Printed when the server starts, and stored in <code className="font-data text-foreground">&lt;data dir&gt;/keys.json</code> (default{" "}
            <code className="font-data text-foreground">./data/keys.json</code>).
          </p>

          <dl className="mt-6 space-y-4 border-t border-border pt-6 text-sm">
            <div>
              <dt className="font-medium">Server log</dt>
              <dd className="mt-0.5 text-muted-foreground">
                The first start prints the publishable key and the secret key once.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Environment variable</dt>
              <dd className="mt-0.5 text-muted-foreground">
                <code className="font-data text-foreground">ORBITID_SECRET_KEY</code> sets the key the server accepts. Use the
                same value here.
              </dd>
            </div>
            <div>
              <dt className="font-medium">Data directory</dt>
              <dd className="mt-0.5 text-muted-foreground">
                <code className="font-data text-foreground">ORBITID_DATA_DIR</code> moves the directory. The default is{" "}
                <code className="font-data text-foreground">./data</code> next to the server process.
              </dd>
            </div>
          </dl>

          <p className="mt-6 flex items-start gap-2 border-t border-border pt-6 text-sm text-muted-foreground">
            <Sun className="mt-0.5 size-4 shrink-0" aria-hidden />
            Keys are per instance. Point the dashboard at a different URL to manage a different instance.
          </p>
        </aside>
      </main>
    </div>
  );
}

function ConnectionResult({
  apiUrl,
  health,
  onRetry,
}: {
  apiUrl: string;
  health: HealthState;
  onRetry: () => void;
}) {
  return (
    <section aria-labelledby="connection-heading" className="mt-10 border-t border-border pt-5">
      <div className="flex items-center justify-between gap-3">
        <h2 id="connection-heading" className="text-[0.8125rem] font-semibold">
          Connection
        </h2>
        <Button type="button" variant="ghost" size="xs" onClick={onRetry} className="text-muted-foreground">
          Check again
        </Button>
      </div>

      {health.state === "checking" ? (
        <p role="status" className="mt-3 flex items-center gap-2 text-sm text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" aria-hidden />
          Checking {apiUrl || "the URL"}.
        </p>
      ) : null}

      {health.state === "error" ? (
        <div className="mt-3 flex items-start gap-2 text-sm">
          <X className="mt-0.5 size-4 shrink-0 text-signal" aria-hidden />
          <div>
            <p className="font-medium">No answer from {apiUrl}.</p>
            <p className="text-muted-foreground">
              Start the server, or change the URL above. The dashboard calls <code className="font-data">/health</code> without a
              key.
            </p>
          </div>
        </div>
      ) : null}

      {health.state === "ok" ? (
        <dl className="mt-3 grid grid-cols-[minmax(0,1fr)] gap-1.5 text-sm">
          <div className="flex items-baseline gap-2">
            <dt className="flex w-32 shrink-0 items-center gap-1.5 text-muted-foreground">
              <Check className="size-3.5 text-go" aria-hidden />
              Reachable
            </dt>
            <dd className="min-w-0 truncate font-data">{health.result.apiUrl}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-32 shrink-0 pl-5 text-muted-foreground">Database</dt>
            <dd className="min-w-0">
              {databaseLabel(health.result.database)}
              {health.result.database ? "" : ". This server build does not report it yet."}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-32 shrink-0 pl-5 text-muted-foreground">Publishable key</dt>
            <dd className="min-w-0 truncate font-data">
              {health.result.publishableKey || "Not reported"}
            </dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
}
