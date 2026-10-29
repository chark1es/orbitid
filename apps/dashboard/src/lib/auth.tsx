import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { ApiError, api, getApiUrl, isSameOrigin, setApiUrl } from "./api";

export interface OperatorSession {
  object: "operator_session";
  id: string;
  expires_at: number;
}

/** `checking` covers the first paint: the shell must not flash before the session is confirmed. */
type AuthState = "checking" | "authenticated" | "unauthenticated";

interface AuthContextValue {
  /** True only once the server confirmed a live session. */
  authenticated: boolean;
  /** True while the session is being confirmed on load. */
  checking: boolean;
  /** Exchanges the secret key for an httpOnly session cookie. The key is not stored anywhere in the page. */
  signIn: (apiUrl: string, secretKey: string) => Promise<OperatorSession>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

/** `GET /v1/operator_sessions/current` with the browser's cookie; null when there is no live session. */
async function readOperatorSession(): Promise<OperatorSession | null> {
  try {
    return await api<OperatorSession>("GET", "/operator_sessions/current");
  } catch (cause) {
    if (cause instanceof ApiError && (cause.status === 401 || cause.status === 403)) return null;
    throw cause;
  }
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

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [state, setState] = useState<AuthState>("checking");

  useEffect(() => {
    clearLegacyCredentials();
    let active = true;
    readOperatorSession()
      .then((session) => {
        if (active) setState(session ? "authenticated" : "unauthenticated");
      })
      .catch(() => {
        // An unreachable server is not a signed-in session, but it is also not a reason to lose the shell's
        // error state: the sign-in screen shows the connection check.
        if (active) setState("unauthenticated");
      });
    return () => {
      active = false;
    };
  }, []);

  const signIn = useCallback(
    async (apiUrl: string, secretKey: string) => {
      if (!isSameOrigin(apiUrl)) {
        throw new ApiError(
          400,
          "not_allowed_access",
          "The dashboard must be served by the instance it manages. Open the dashboard URL the server prints, or serve this build from the server.",
        );
      }
      setApiUrl(apiUrl);
      // The key is sent once, here. The server answers with an httpOnly cookie and returns no key material.
      const session = await api<OperatorSession>("POST", "/operator_sessions", { secret_key: secretKey.trim() });
      queryClient.clear();
      setState("authenticated");
      return session;
    },
    [queryClient],
  );

  const signOut = useCallback(async () => {
    try {
      await api("DELETE", "/operator_sessions/current");
    } catch (cause) {
      // A 401 means the session was already gone server-side: that is a completed sign-out. Any other failure
      // (network, 5xx) leaves the cookie live, so the shell must keep showing the session and report the error
      // rather than claim the operator is signed out while the browser can still reach the Backend API.
      if (!(cause instanceof ApiError && cause.status === 401)) throw cause;
    }
    queryClient.clear();
    setState("unauthenticated");
  }, [queryClient]);

  useEffect(() => {
    const onUnauthorized = (event: Event) => {
      setState("unauthenticated");
      queryClient.clear();
      const reason =
        event instanceof CustomEvent && typeof event.detail === "string"
          ? event.detail
          : "Your session is no longer valid. Sign in again.";
      if (!window.location.pathname.startsWith("/login")) toast.error(reason);
    };
    window.addEventListener("orbitid:unauthorized", onUnauthorized);
    return () => window.removeEventListener("orbitid:unauthorized", onUnauthorized);
  }, [queryClient]);

  const value = useMemo<AuthContextValue>(
    () => ({ authenticated: state === "authenticated", checking: state === "checking", signIn, signOut }),
    [state, signIn, signOut],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const context = useContext(AuthContext);
  if (!context) throw new Error("useAuth must be used within <AuthProvider>");
  return context;
}

/** Route guard for every authenticated page. */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { authenticated, checking } = useAuth();
  const location = useLocation();
  if (checking) {
    return (
      <div role="status" className="flex min-h-svh items-center justify-center text-sm text-muted-foreground">
        Checking your session…
      </div>
    );
  }
  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <>{children}</>;
}

export { readOperatorSession, getApiUrl };
