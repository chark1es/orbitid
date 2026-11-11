"use client";

import * as React from "react";

export type ThemeChoice = "light" | "dark" | "system";
export type ResolvedTheme = "light" | "dark";

/**
 * Small theme store shared by the dashboard and every OrbitID widget.
 *
 * It deliberately avoids an inline `<script>` in the React tree (React 19 rejects one during render):
 * call {@link initTheme} once before `createRoot` in a client-only app so the class is on `<html>` before the
 * first paint, and let the provider keep it in sync afterwards. `system` follows `prefers-color-scheme` live.
 *
 * In a **server-rendered** app the server cannot know `localStorage` or the visitor's colour scheme, so the
 * provider renders a deterministic snapshot (the `defaultTheme`, with `system` resolved to light) on the server
 * *and* for the hydration render, then switches to the stored/system preference after hydration. That avoids a
 * hydration mismatch without guessing; pair it with {@link themeBootstrapScript} in `<head>` to avoid a flash of
 * the wrong theme before the first paint.
 */
const STORAGE_KEY = "orbitid-theme";

const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function systemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function readChoice(storageKey: string, fallback: ThemeChoice): ThemeChoice {
  if (typeof window === "undefined") return fallback;
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (stored === "light" || stored === "dark" || stored === "system") return stored;
  } catch {
    // Private mode: fall through to the default.
  }
  return fallback;
}

function applyTheme(resolved: ResolvedTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.style.colorScheme = resolved;
}

/** Resolve and apply the stored choice before React mounts. No DOM is touched on the server. */
export function initTheme(storageKey = STORAGE_KEY, fallback: ThemeChoice = "system"): ResolvedTheme {
  const choice = readChoice(storageKey, fallback);
  const resolved = choice === "system" ? systemTheme() : choice;
  applyTheme(resolved);
  return resolved;
}

/**
 * Pre-paint bootstrap for server-rendered apps: put the returned source in a `<script>` in `<head>`
 * (for example `dangerouslySetInnerHTML={{ __html: themeBootstrapScript() }}`) before the app hydrates. It applies
 * the stored system/light/dark choice immediately, so the server's deterministic markup can hydrate without a
 * flash of the wrong theme and without the React tree trying to render a `<script>`.
 */
export function themeBootstrapScript(storageKey = STORAGE_KEY, fallback: ThemeChoice = "system"): string {
  const key = JSON.stringify(storageKey).replace(/</g, "\\u003c");
  const preset = JSON.stringify(fallback).replace(/</g, "\\u003c");
  return (
    `(function(){try{var c=localStorage.getItem(${key});` +
    `if(c!=="light"&&c!=="dark"&&c!=="system")c=${preset};` +
    `var q=window.matchMedia&&window.matchMedia("(prefers-color-scheme: dark)");` +
    `var d=c==="system"?(q&&q.matches?"dark":"light"):c;` +
    `var r=document.documentElement;r.classList.toggle("dark",d==="dark");r.style.colorScheme=d;` +
    `}catch(e){}})();`
  );
}

interface ThemeSnapshot {
  theme: ThemeChoice;
  resolvedTheme: ResolvedTheme;
}

const snapshotCache = new Map<string, ThemeSnapshot>();
/**
 * A choice made in this tab that could not be written to `localStorage` (private mode) must still hold for this
 * visit. A `storage` event from another tab clears it, so a cross-tab change is not masked.
 */
const inMemoryChoices = new Map<string, ThemeChoice>();

function cachedSnapshot(key: string, theme: ThemeChoice, resolvedTheme: ResolvedTheme): ThemeSnapshot {
  const cached = snapshotCache.get(key);
  if (cached && cached.theme === theme && cached.resolvedTheme === resolvedTheme) return cached;
  const next: ThemeSnapshot = { theme, resolvedTheme };
  snapshotCache.set(key, next);
  return next;
}

/** Read the live preference on the client. Identity only changes when a value changes, as `useSyncExternalStore` requires. */
function clientSnapshot(storageKey: string, fallback: ThemeChoice): ThemeSnapshot {
  const theme = inMemoryChoices.get(storageKey) ?? readChoice(storageKey, fallback);
  const resolvedTheme = theme === "system" ? systemTheme() : theme;
  return cachedSnapshot(`client:${storageKey}:${fallback}`, theme, resolvedTheme);
}

/**
 * The snapshot used by `renderToString` **and** by the hydration render. It must not read storage or `matchMedia`:
 * the server has neither, and reading them on the first client render is exactly the hydration mismatch this
 * provider avoids. `system` resolves to light until the post-hydration snapshot takes over.
 */
function serverSnapshot(storageKey: string, fallback: ThemeChoice): ThemeSnapshot {
  return cachedSnapshot(`server:${storageKey}:${fallback}`, fallback, fallback === "system" ? "light" : fallback);
}

interface ThemeContextValue {
  theme: ThemeChoice;
  resolvedTheme: ResolvedTheme;
  setTheme: (theme: ThemeChoice) => void;
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null);

export interface ThemeProviderProps {
  children: React.ReactNode;
  defaultTheme?: ThemeChoice;
  storageKey?: string;
}

export function ThemeProvider({
  children,
  defaultTheme = "system",
  storageKey = STORAGE_KEY,
}: ThemeProviderProps): React.JSX.Element {
  const getSnapshot = React.useCallback(() => clientSnapshot(storageKey, defaultTheme), [storageKey, defaultTheme]);
  const getServerSnapshot = React.useCallback(() => serverSnapshot(storageKey, defaultTheme), [storageKey, defaultTheme]);
  const snapshot = React.useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
  const { theme, resolvedTheme } = snapshot;

  const setTheme = React.useCallback(
    (next: ThemeChoice) => {
      inMemoryChoices.set(storageKey, next);
      try {
        window.localStorage.setItem(storageKey, next);
      } catch {
        // The choice still holds for this visit through the in-memory override.
      }
      // Every provider (and the bootstrap) reads through the snapshot, so notifying is enough to repaint.
      notify();
    },
    [storageKey],
  );

  // Keep the document class in sync with what React rendered. This runs after hydration too, applying the stored
  // preference the server could not know about.
  React.useEffect(() => {
    applyTheme(resolvedTheme);
  }, [resolvedTheme]);

  React.useEffect(() => {
    const query = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!query) return;
    const update = () => notify();
    query.addEventListener?.("change", update);
    return () => query.removeEventListener?.("change", update);
  }, []);

  // Another tab changed the choice.
  React.useEffect(() => {
    const onStorage = (event: StorageEvent) => {
      if (event.key !== storageKey) return;
      inMemoryChoices.delete(storageKey);
      notify();
    };
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [storageKey]);

  const value = React.useMemo(() => ({ theme, resolvedTheme, setTheme }), [theme, resolvedTheme, setTheme]);
  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>;
}

const FALLBACK_THEME: ThemeContextValue = {
  theme: "system",
  resolvedTheme: "light",
  setTheme: () => undefined,
};

/** Safe outside a provider: the Toaster and a preview card do not require the shell. */
export function useTheme(): ThemeContextValue {
  return React.useContext(ThemeContext) ?? FALLBACK_THEME;
}
