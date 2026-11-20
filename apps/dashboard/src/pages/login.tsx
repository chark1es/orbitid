import { useCallback, useEffect, useState } from "react";
import { Navigate, useLocation, useNavigate } from "react-router-dom";
import { Button, OrbitMark, Skeleton } from "@orbitid/ui";
import { RefreshCw, Sun } from "lucide-react";
import { useQuery } from "@tanstack/react-query";
import { useAuth } from "../lib/auth";
import { fetchHealth } from "../lib/instance";
import { errorMessage } from "../lib/errors";
import { ThemeToggle } from "../components/layout/theme-toggle";
import { FormSkeleton } from "../components/shared/page-skeleton";
import { OwnerSetup, OwnerSetupHelp } from "./_login/owner-setup";
import { SignedInAccount } from "./_login/signed-in-account";
import { FormError } from "./_login/form-error";
import { ServerOwnerNotice } from "./_login/server-owner-notice";

type AccountSignInModule = typeof import("./_login/account-sign-in");

/**
 * The SDK sign-in is loaded by hand rather than with `lazy()`: React holds a Suspense boundary's content back until its
 * fallback has been visible for ~300 ms, which delayed the form (and the SDK's own requests) on every visit, even with
 * the chunk in cache.
 */
let accountSignIn: AccountSignInModule | null = null;
let accountSignInLoading: Promise<AccountSignInModule> | null = null;

function loadAccountSignIn(): Promise<AccountSignInModule> {
  accountSignInLoading ??= import("./_login/account-sign-in").then(
    (module) => {
      accountSignIn = module;
      // In production the key arrives with the page: start the SDK's requests before the form even renders.
      const injected = window.__ORBITID__?.publishableKey;
      if (injected) module.prepareAccountSignIn(injected);
      return module;
    },
    (error: unknown) => {
      accountSignInLoading = null;
      throw error;
    },
  );
  return accountSignInLoading;
}

function useAccountSignInModule(): { module: AccountSignInModule | null; failed: boolean } {
  const [module, setModule] = useState(accountSignIn);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (module) return;
    let live = true;
    loadAccountSignIn().then(
      (loaded) => live && setModule(loaded),
      () => live && setFailed(true),
    );
    return () => {
      live = false;
    };
  }, [module]);
  return { module, failed };
}

function redirectTarget(state: unknown): string {
  if (state && typeof state === "object" && "from" in state && typeof state.from === "string" && state.from.startsWith("/")) {
    return state.from;
  }
  return "/";
}

export default function LoginPage() {
  const { authenticated, checking, status, statusError, refresh, openConsole } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [retrying, setRetrying] = useState(false);
  const [openError, setOpenError] = useState<string | null>(null);
  const target = redirectTarget(location.state);
  const enter = useCallback(() => navigate(target, { replace: true }), [navigate, target]);

  useEffect(() => {
    document.title = "Sign in · OrbitID";
  }, []);

  const view = checking ? "checking" : status?.setup_required ? "setup" : status?.user ? "account" : "sign-in";
  const unclaimed = !!status?.console_unclaimed;

  const retry = useCallback(async () => {
    setRetrying(true);
    try {
      await refresh();
    } catch {
      // `statusError` says why.
    } finally {
      setRetrying(false);
    }
  }, [refresh]);

  // Start downloading the sign-in form the moment we know it will be needed.
  useEffect(() => {
    if (view === "sign-in") void loadAccountSignIn();
  }, [view]);

  /** After signing in here, go straight into the console when the account may open it. */
  const afterAccountSignIn = useCallback(async () => {
    setOpenError(null);
    try {
      const next = await refresh();
      if (next.user?.console_access) {
        await openConsole();
        enter();
      }
    } catch (cause) {
      setOpenError(errorMessage(cause, "Signed in, but the console did not open. Try again."));
    }
  }, [refresh, openConsole, enter]);

  if (authenticated) return <Navigate to={target} replace />;

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
        <section aria-labelledby={view === "checking" ? undefined : "sign-in-heading"} aria-label={view === "checking" ? "Checking your session" : undefined} className="min-w-0">
          {view === "checking" ? <FormSkeleton label="Checking your session" /> : null}
          {view !== "checking" && statusError ? (
            <div className="mb-6 space-y-2">
              <FormError id="status-error" title="Could not check your session" message={statusError} />
              <Button variant="outline" size="sm" onClick={() => void retry()} disabled={retrying}>
                <RefreshCw className={retrying ? "animate-spin" : undefined} aria-hidden /> Try again
              </Button>
            </div>
          ) : null}
          {view === "setup" ? <OwnerSetup onDone={enter} /> : null}
          {view === "account" && status?.user ? <SignedInAccount account={status.user} unclaimed={unclaimed} onOpened={enter} /> : null}
          {view === "sign-in" ? (
            <>
              <h1 id="sign-in-heading" className="text-[1.75rem] leading-tight">
                Sign in to the console
              </h1>
              <p className="mt-2 max-w-[60ch] text-sm text-muted-foreground">
                Use your account on this instance. Owners and administrators go straight in.
              </p>
              {unclaimed ? (
                <div className="mt-6">
                  <ServerOwnerNotice />
                </div>
              ) : null}
              <div className="mt-8">
                <AccountSignInSlot onSignedIn={() => void afterAccountSignIn()} />
              </div>
              {openError ? (
                <div className="mt-5">
                  <FormError id="open-error" title="Could not open the console" message={openError} />
                </div>
              ) : null}
            </>
          ) : null}
        </section>

        <aside className="min-w-0 lg:border-l lg:border-border lg:pl-10" aria-labelledby={view === "checking" ? undefined : "help-heading"}>
          {view === "setup" ? <OwnerSetupHelp /> : null}
          {view === "sign-in" || view === "account" ? <AccountHelp /> : null}
          {view !== "checking" ? (
            <p className="mt-6 flex items-start gap-2 border-t border-border pt-6 text-sm text-muted-foreground">
              <Sun className="mt-0.5 size-4 shrink-0" aria-hidden />
              The dashboard that manages an instance is served by that instance, so every session cookie stays same-origin.
            </p>
          ) : null}
        </aside>
      </main>
    </div>
  );
}

/** The publishable key comes with the page from the server; the Vite dev server has to ask `/health` for it. */
function AccountSignInSlot({ onSignedIn }: { onSignedIn: () => void }) {
  const injected = typeof window === "undefined" ? undefined : window.__ORBITID__?.publishableKey;
  const health = useQuery({
    queryKey: ["health", "publishable-key"],
    queryFn: fetchHealth,
    enabled: !injected,
    staleTime: Infinity,
  });
  const publishableKey = injected || health.data?.publishable_key;
  const { module, failed } = useAccountSignInModule();
  const fallback = (
    <div className="space-y-4" aria-hidden>
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
      <Skeleton className="h-9 w-full" />
    </div>
  );
  if (health.isError || failed) {
    return (
      <FormError id="sign-in-unavailable" title="Sign-in is unavailable" message="The instance did not answer. Check that the server is running, then reload this page." />
    );
  }
  if (!publishableKey || !module) return fallback;
  const AccountSignIn = module.default;
  return <AccountSignIn publishableKey={publishableKey} onSignedIn={onSignedIn} />;
}

function AccountHelp() {
  return (
    <>
      <h2 id="help-heading" className="text-[0.9375rem] font-heading tracking-[-0.01em]">
        Who can open the console
      </h2>
      <dl className="mt-4 space-y-4 text-sm">
        <div>
          <dt className="font-medium">Owners and administrators</dt>
          <dd className="mt-0.5 text-muted-foreground">
            Accounts with the <span className="text-foreground">Owner</span> or{" "}
            <span className="text-foreground">Administrator</span> role, or any instance role with the{" "}
            <code className="font-data text-foreground">app:sys_dashboard:access</code> permission.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Everyone else</dt>
          <dd className="mt-0.5 text-muted-foreground">
            Can sign in, and sees that the account has no console access. An owner grants it from the user's page.
          </dd>
        </div>
        <div>
          <dt className="font-medium">Not the secret key</dt>
          <dd className="mt-0.5 text-muted-foreground">
            The secret key authenticates your servers' Backend API calls; it does not open the dashboard. If no account
            can, run <code className="font-data text-foreground">orbitid owner &lt;email&gt;</code> on the server.
          </dd>
        </div>
      </dl>
    </>
  );
}
