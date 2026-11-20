import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, api, getApiUrl, isSameOrigin } from "./api";
import { errorMessage } from "./errors";

export interface OperatorSession {
  object: "operator_session";
  id: string;
  expires_at: number;
  /** The account that opened the console; the secret key never does. */
  user_id: string;
}

/** The account signed in to this instance in this browser (its own session, not the console's). */
export interface ConsoleAccount {
  id: string;
  first_name: string | null;
  last_name: string | null;
  username: string | null;
  email_address: string | null;
  image_url: string | null;
  /** True when one of the account's instance roles grants `app:sys_dashboard:access`. */
  console_access: boolean;
}

/** `GET /v1/operator_sessions/status`: the dashboard's whole boot decision in one answer. */
export interface OperatorStatus {
  object?: "operator_status";
  operator_session: OperatorSession | null;
  user: ConsoleAccount | null;
  /** The instance has no account yet: the first person to finish setup becomes its owner. */
  setup_required: boolean;
  /** Accounts exist but none can open the console yet: whoever runs the server grants the Owner role. */
  console_unclaimed?: boolean;
}

export interface OwnerSetupInput {
  first_name?: string;
  last_name?: string;
  email_address: string;
  password: string;
}

declare global {
  interface Window {
    /** Started by an inline script in `index.html`, so the status request runs while the bundle downloads. */
    __ORBITID_BOOT__?: { status?: Promise<unknown>; value?: unknown };
  }
}

interface AuthContextValue {
  /** True only once the server confirmed a live console session. */
  authenticated: boolean;
  /** True while the first status answer is pending. */
  checking: boolean;
  /** The last status answer; `null` until the first one arrives. */
  status: OperatorStatus | null;
  /** Why the last status check failed (unreachable, rate limited), or `null` when it answered. */
  statusError: string | null;
  /** Re-reads the status, for example after signing in to the account in another tab. */
  refresh: () => Promise<OperatorStatus>;
  /** Opens the console for the account signed in on this browser. */
  openConsole: () => Promise<OperatorSession>;
  /** Creates the owner account on a fresh instance and opens the console. */
  setupOwner: (input: OwnerSetupInput) => Promise<OperatorStatus>;
  /** Ends the console session. `account: true` also signs this browser's account out. */
  signOut: (options?: { account?: boolean }) => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function isOperatorStatus(value: unknown): value is OperatorStatus {
  return !!value && typeof value === "object" && "setup_required" in value && typeof value.setup_required === "boolean";
}

/** `GET /v1/operator_sessions/status` with the browser's cookies. Signed out is a normal answer, not an error. */
export async function readOperatorStatus(): Promise<OperatorStatus> {
  const status = await api<unknown>("GET", "/operator_sessions/status");
  if (!isOperatorStatus(status)) throw new ApiError(502, "unexpected_response", "The instance answered with an unexpected status.");
  return status;
}

/** The answer the inline boot script already has, when it is for this origin. Read once: later reads go to the network. */
function takeBootStatus(): { value: OperatorStatus | null; pending: Promise<unknown> | null } {
  const boot = typeof window === "undefined" ? undefined : window.__ORBITID_BOOT__;
  if (!boot || !isSameOrigin()) return { value: null, pending: null };
  window.__ORBITID_BOOT__ = undefined;
  return { value: isOperatorStatus(boot.value) ? boot.value : null, pending: boot.status ?? null };
}

/**
 * An older dashboard kept the secret key in `sessionStorage`. Clear it on every load, so an upgraded tab in
 * an existing browser stops carrying the credential even though nothing reads it any more.
 */
export function clearLegacyCredentials(storage: Storage | undefined = typeof sessionStorage === "undefined" ? undefined : sessionStorage): void {
  try {
    storage?.removeItem("orbitid.secretKey");
  } catch {
    // Storage can be blocked (private mode, a policy). Nothing to clear then.
  }
}

const SIGNED_OUT: OperatorStatus = { operator_session: null, user: null, setup_required: false };

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  // Usually the boot script has answered by the time React renders, so the first paint is already the right screen.
  const boot = useRef(takeBootStatus());
  const [status, setStatus] = useState<OperatorStatus | null>(boot.current.value);
  const [statusError, setStatusError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const next = await readOperatorStatus();
      setStatus(next);
      setStatusError(null);
      return next;
    } catch (cause) {
      setStatusError(errorMessage(cause, "The instance did not answer."));
      throw cause;
    }
  }, []);

  // One initial answer per provider, shared across StrictMode's effect replay so it is never asked twice.
  const initial = useRef<Promise<OperatorStatus> | null>(null);

  useEffect(() => {
    clearLegacyCredentials();
    if (boot.current.value) return;
    let active = true;
    const pending = boot.current.pending;
    // The boot answer when it is usable; otherwise exactly one request of our own.
    initial.current ??= pending
      ? pending
          .then((value) => (isOperatorStatus(value) ? value : Promise.reject(new Error("unexpected boot answer"))))
          .catch(() => readOperatorStatus())
      : readOperatorStatus();
    initial.current
      .then((next) => {
        if (active) setStatus(next);
      })
      .catch((cause: unknown) => {
        // An unreachable or rate-limited server is not a signed-in session. The sign-in screen says why.
        if (!active) return;
        setStatus((current) => current ?? SIGNED_OUT);
        setStatusError(errorMessage(cause, "The instance did not answer."));
      });
    return () => {
      active = false;
    };
  }, []);

  const withSession = useCallback((session: OperatorSession) => {
    setStatus((current) => ({ ...(current ?? SIGNED_OUT), operator_session: session, setup_required: false }));
  }, []);

  const openConsole = useCallback(async () => {
    const session = await api<OperatorSession>("POST", "/operator_sessions/from_user");
    queryClient.clear();
    withSession(session);
    // The browser may have switched accounts since this page loaded: settle on the account the server opened the
    // console for, so the menu never names a different one.
    await refresh().catch(() => undefined);
    return session;
  }, [queryClient, withSession, refresh]);

  const setupOwner = useCallback(
    async (input: OwnerSetupInput) => {
      const next = await api<OperatorStatus>("POST", "/operator_sessions/setup", input);
      queryClient.clear();
      setStatus(next);
      return next;
    },
    [queryClient],
  );

  const signOut = useCallback(
    async (options: { account?: boolean } = {}) => {
      try {
        await api("DELETE", options.account ? "/operator_sessions/current?account=true" : "/operator_sessions/current");
      } catch (cause) {
        // A 401 means the session was already gone server-side: that is a completed sign-out. Any other failure
        // (network, 5xx) leaves the cookie live, so the shell must keep showing the session and report the error
        // rather than claim the operator is signed out while the browser can still reach the Backend API.
        if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
      }
      queryClient.clear();
      // Ending a console session ends the account session behind it, so the account is signed out too.
      setStatus((current) => {
        const hadConsole = !!current?.operator_session;
        return { ...(current ?? SIGNED_OUT), operator_session: null, user: options.account || hadConsole ? null : current?.user ?? null };
      });
      // The server is the source of truth for what is still signed in; settle on its answer quietly.
      void refresh().catch(() => undefined);
    },
    [queryClient, refresh],
  );

  useEffect(() => {
    const onUnauthorized = (event: Event) => {
      setStatus((current) => ({ ...(current ?? SIGNED_OUT), operator_session: null }));
      queryClient.clear();
      void refresh().catch(() => undefined);
      const reason =
        event instanceof CustomEvent && typeof event.detail === "string"
          ? event.detail
          : "Your session is no longer valid. Sign in again.";
      if (!window.location.pathname.startsWith("/login")) toast.error(reason);
    };
    window.addEventListener("orbitid:unauthorized", onUnauthorized);
    return () => window.removeEventListener("orbitid:unauthorized", onUnauthorized);
  }, [queryClient, refresh]);

  const value = useMemo<AuthContextValue>(
    () => ({
      authenticated: !!status?.operator_session,
      checking: status === null,
      status,
      statusError,
      refresh,
      openConsole,
      setupOwner,
      signOut,
    }),
    [status, statusError, refresh, openConsole, setupOwner, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within <AuthProvider>");
  return context;
}

/** A display name for the signed-in account: full name, else username, else email. */
export function accountLabel(account: Pick<ConsoleAccount, "first_name" | "last_name" | "username" | "email_address">): string {
  const name = [account.first_name, account.last_name].filter(Boolean).join(" ").trim();
  return name || account.username || account.email_address || "Your account";
}

/** Route guard for every authenticated page. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { authenticated, checking } = useAuth();
  const location = useLocation();
  if (checking) {
    return (
      <div role="status" aria-label="Checking your session" className="min-h-svh bg-background">
        <span className="sr-only">Checking your session…</span>
      </div>
    );
  }
  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <>{children}</>;
}

export { getApiUrl };
