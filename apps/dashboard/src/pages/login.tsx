import { useEffect, useState, type FormEvent } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button, Input, Label, OrbitMark } from "@orbitid/ui";
import { Check, Eye, EyeOff, Loader2, Sun, TriangleAlert, X } from "lucide-react";
import { API_URL, ApiError, DEFAULT_API_URL, getApiUrl, isSameOrigin } from "../lib/api";
import { useAuth } from "../lib/auth";
import { errorMessage } from "../lib/errors";
import { databaseLabel, databaseSupportNote, fetchInstanceHealth, type InstanceHealth } from "../lib/instance-health";
import { ThemeToggle } from "../components/layout/theme-toggle";
import { FormSkeleton } from "../components/shared/page-skeleton";

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

export default function LoginPage() {
  const { authenticated, checking, signIn } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [apiUrl, setApiUrlInput] = useState(getApiUrl());
  const [secretKey, setSecretKeyInput] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [health, setHealth] = useState<HealthState>({ state: "checking" });
  const [checkCount, setCheckCount] = useState(0);
  const sameOrigin = isSameOrigin(apiUrl.trim() || DEFAULT_API_URL);

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
      setError("Enter the secret key. Print it with `orbitid keys` if you do not have it.");
      return;
    }
    if (!isSameOrigin(apiUrl.trim())) {
      setError(
        "The dashboard must be served by the instance it manages. Open the dashboard at the URL the server prints.",
      );
      return;
    }
    setPending(true);
    try {
      await signIn(apiUrl, secretKey);
      // The key was only ever in this form field. Clear it as soon as the exchange succeeds.
      setSecretKeyInput("");
      navigate(redirectTarget(location.state), { replace: true });
    } catch (cause) {
      if (cause instanceof ApiError && cause.status === 401) {
        setError(
          `The server rejected that secret key. Copy the key that starts with sk_ from the orbitid keys command (or ORBITID_SECRET_KEY), then sign in again.`,
        );
      } else {
        setError(errorMessage(cause, "The instance did not answer. Check the URL and that the server is running."));
      }
    } finally {
      setPending(false);
    }
  }

  if (checking) {
    return (
      <div className="min-h-svh bg-background">
        <header className="flex h-12 items-center justify-between border-b border-border px-6">
          <div className="flex items-center gap-2.5">
            <span className="flex size-6 items-center justify-center rounded-sm bg-primary text-primary-foreground">
              <OrbitMark />
            </span>
            <span className="text-sm font-semibold">OrbitID</span>
          </div>
        </header>
        <main className="mx-auto grid w-full max-w-[1040px] grid-cols-[minmax(0,1fr)] gap-10 px-6 py-12 lg:grid-cols-[minmax(0,440px)_minmax(0,1fr)] lg:gap-16 lg:py-20">
          <section aria-label="Checking your session">
            <FormSkeleton label="Checking your session" />
          </section>
        </main>
      </div>
    );
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
            Exchanged once for an 8-hour session cookie; the key is never stored.
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
              {!sameOrigin ? (
                <p className="flex items-start gap-1.5 text-xs text-signal">
                  <TriangleAlert className="mt-0.5 size-3.5 shrink-0" aria-hidden />
                  This build can only sign in to the instance that serves it. Open the dashboard at{" "}
                  <code className="font-data">{apiUrl}</code> instead.
                </p>
              ) : null}
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
                  className="absolute inset-y-0 right-0 grid w-9 place-items-center rounded-r-md text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
                  aria-label={showKey ? "Hide secret key" : "Show secret key"}
                  aria-pressed={showKey}
                  onClick={() => setShowKey((current) => !current)}
                >
                  {showKey ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
                </button>
              </div>
              <p className="text-xs text-muted-foreground">
                Server-side key. It is used once to start the session and is not kept in this page. The publishable key
                is for browsers and cannot sign in here.
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
              {pending ? "Starting the session" : "Sign in"}
            </Button>
          </form>

          <ConnectionResult apiUrl={apiUrl} health={health} onRetry={() => setCheckCount((count) => count + 1)} />
        </section>

        <aside className="min-w-0 lg:border-l lg:border-border lg:pl-10" aria-labelledby="key-location-heading">
          <h2 id="key-location-heading" className="text-[0.9375rem] font-heading tracking-[-0.01em]">
            Where the key is
          </h2>
          <p className="mt-2 max-w-[62ch] text-sm leading-6 text-muted-foreground">
            Derived from <code className="font-data text-foreground">ORBITID_ENCRYPTION_KEY</code>, or set explicitly
            with <code className="font-data text-foreground">ORBITID_SECRET_KEY</code>. The start command hides the
            secret key; <code className="font-data text-foreground">orbitid keys</code> prints it.
          </p>

          <dl className="mt-6 space-y-4 border-t border-border pt-6 text-sm">
            <div>
              <dt className="font-medium">Server log</dt>
              <dd className="mt-0.5 text-muted-foreground">
                Startup prints the publishable key and leaves the secret key hidden.<br />
                <code className="font-data text-foreground">orbitid keys</code> prints both keys on demand.
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
              <dt className="font-medium">Encryption key</dt>
              <dd className="mt-0.5 text-muted-foreground">
                <code className="font-data text-foreground">ORBITID_ENCRYPTION_KEY</code> derives the secret key and
                decrypts stored secrets. Keep it stable: changing it makes stored signing keys unreadable.
              </dd>
            </div>
          </dl>

          <p className="mt-6 flex items-start gap-2 border-t border-border pt-6 text-sm text-muted-foreground">
            <Sun className="mt-0.5 size-4 shrink-0" aria-hidden />
            Keys are per instance. The dashboard that manages an instance is served by that instance, so the session
            cookie stays same-origin.
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
        <h2 id="connection-heading" className="text-[0.9375rem] font-heading tracking-[-0.01em]">
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
            <dt className="flex w-36 shrink-0 items-center gap-1.5 text-muted-foreground">
              <Check className="size-4 text-go" aria-hidden />
              Reachable
            </dt>
            <dd className="min-w-0 truncate font-data">{health.result.apiUrl}</dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-36 shrink-0 pl-5 text-muted-foreground">Database</dt>
            <dd className="min-w-0">
              {databaseLabel(health.result.database)}
              {health.result.database ? "" : ". This server build does not report it yet."}
            </dd>
          </div>
          <div className="flex items-baseline gap-2">
            <dt className="w-36 shrink-0 pl-5 text-muted-foreground">Publishable key</dt>
            <dd className="min-w-0 truncate font-data">
              {health.result.publishableKey || "Not reported"}
            </dd>
          </div>
        </dl>
      ) : null}
      {health.state === "ok" && databaseSupportNote(health.result.database, health.result.databaseDriver) ? (
        <p role="status" className="mt-2 flex items-start gap-2 text-sm text-signal">
          <TriangleAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>{databaseSupportNote(health.result.database, health.result.databaseDriver)}</span>
        </p>
      ) : null}
    </section>
  );
}
