import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { Navigate, useLocation } from "react-router-dom";
import { useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getSecretKey, setApiUrl, setSecretKey } from "./api";


interface AuthContextValue {
  authenticated: boolean;
  signIn: (apiUrl: string, secretKey: string) => void;
  signOut: () => void;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [authenticated, setAuthenticated] = useState(() => !!getSecretKey());

  const signIn = useCallback(
    (apiUrl: string, secretKey: string) => {
      setApiUrl(apiUrl);
      setSecretKey(secretKey.trim());
      queryClient.clear();
      setAuthenticated(true);
    },
    [queryClient],
  );

  const signOut = useCallback(() => {
    setSecretKey(null);
    queryClient.clear();
    setAuthenticated(false);
  }, [queryClient]);

  useEffect(() => {
    const onUnauthorized = (event: Event) => {
      setAuthenticated(false);
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
    () => ({ authenticated, signIn, signOut }),
    [authenticated, signIn, signOut],
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
  const { authenticated } = useAuth();
  const location = useLocation();
  if (!authenticated) {
    return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  }
  return <>{children}</>;
}
