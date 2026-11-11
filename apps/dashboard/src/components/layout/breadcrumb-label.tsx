import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "react-router-dom";

interface Entry {
  path: string;
  label: string | null;
}

interface BreadcrumbLabelContextValue {
  entry: Entry | null;
  register: (path: string, label: string | null) => void;
}

const NOOP = () => {};
const BreadcrumbLabelContext = createContext<BreadcrumbLabelContextValue>({ entry: null, register: NOOP });

/**
 * A detail page knows the display name of the record it shows, the URL only carries its id. Pages
 * register the name here and the top bar replaces the raw id with it, with a short id as the loading
 * fallback. The entry is keyed by pathname so a stale name from the previous page cannot leak.
 */
export function BreadcrumbLabelProvider({ children }: { children: ReactNode }) {
  const [entry, setEntry] = useState<Entry | null>(null);
  const register = useCallback((path: string, label: string | null) => {
    setEntry((current) => {
      if (label === null) return current?.path === path ? null : current;
      if (current?.path === path && current.label === label) return current;
      return { path, label };
    });
  }, []);
  const value = useMemo(() => ({ entry, register }), [entry, register]);
  return <BreadcrumbLabelContext.Provider value={value}>{children}</BreadcrumbLabelContext.Provider>;
}

/** Registers the current record's display name for the last breadcrumb. Call with `null` while loading. */
export function useBreadcrumbLabel(label: string | null | undefined): void {
  const { pathname } = useLocation();
  const { register } = useContext(BreadcrumbLabelContext);
  const value = label?.trim() ? label.trim() : null;

  useEffect(() => {
    register(pathname, value);
  }, [pathname, value, register]);

  // Navigating away clears the name even if the next page does not register one.
  useEffect(() => () => register(pathname, null), [pathname, register]);
}

/** The registered name for `pathname`, or `null` when the page has not registered one yet. */
export function useRegisteredBreadcrumbLabel(pathname: string): string | null {
  const { entry } = useContext(BreadcrumbLabelContext);
  return entry?.path === pathname ? entry.label : null;
}

/** A readable stand-in for an id while the record loads: `org_AsiNef7hCMCif…` becomes `org_AsiNef7hC…`. */
export function shortId(segment: string, length = 14): string {
  if (segment.length <= length) return segment;
  return `${segment.slice(0, length)}…`;
}
