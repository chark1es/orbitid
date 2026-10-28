import { useCallback, useContext, useMemo, useSyncExternalStore } from "react";
import { OrbitIDOptionsContext } from "../provider/contexts";

/**
 * - `path` — the component's step lives in the URL path below `path` (e.g. `/sign-in/factor-one`).
 * - `hash` — the step lives in `location.hash` (e.g. `#/factor-one`).
 * - `virtual` — the step is kept in memory (default); nothing touches the URL.
 */
export type RoutingMode = "path" | "hash" | "virtual";

export interface RouterOptions {
  routing?: RoutingMode;
  /** Base path for `path`/`hash` routing. Ignored by `virtual`. */
  path?: string;
  /** Step shown by `virtual` routing before the user navigates. */
  startPath?: string;
}

export interface Router {
  /** Step relative to the base path, always starting with `/`. */
  path: string;
  basePath: string;
  routing: RoutingMode;
  navigate(to: string, options?: { replace?: boolean }): void;
  /** Exact match, with `:param` and trailing `*` support: `match('/verify/:id')`. */
  match(pattern: string): boolean;
}

const normalizePath = (path: string): string => {
  const trimmed = path.trim();
  if (!trimmed || trimmed === "/") return "/";
  const withLeading = trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
  return withLeading.endsWith("/") ? withLeading.slice(0, -1) : withLeading;
};

/** Join a base path and a step without duplicating or dropping slashes. */
export function joinPath(basePath: string, step: string): string {
  const base = normalizePath(basePath) === "/" ? "" : normalizePath(basePath);
  const suffix = normalizePath(step);
  return `${base}${suffix === "/" ? "/" : suffix}`;
}

/** Exact segment match; `:name` matches one segment, a trailing `*` matches the rest. */
export function matchPath(current: string, pattern: string): boolean {
  const currentSegments = normalizePath(current).split("/").filter(Boolean);
  const patternSegments = normalizePath(pattern).split("/").filter(Boolean);
  for (let i = 0; i < patternSegments.length; i++) {
    const expected = patternSegments[i]!;
    if (expected === "*") return true;
    const actual = currentSegments[i];
    if (actual === undefined) return false;
    if (expected.startsWith(":")) continue;
    if (expected !== actual) return false;
  }
  return currentSegments.length === patternSegments.length;
}

/** Shared, module-scoped store so several components can drive one virtual router. */
export interface VirtualRouterStore {
  get(): string;
  set(next: string): void;
  subscribe(listener: () => void): () => void;
}

function createVirtualStore(initialPath: string): VirtualRouterStore {
  let path = normalizePath(initialPath);
  const listeners = new Set<() => void>();
  return {
    get: () => path,
    set(next) {
      const normalized = normalizePath(next);
      if (normalized === path) return;
      path = normalized;
      listeners.forEach((listener) => listener());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const virtualStores = new Map<string, VirtualRouterStore>();
function getVirtualStore(initialPath: string): VirtualRouterStore {
  let store = virtualStores.get(initialPath);
  if (!store) {
    store = createVirtualStore(initialPath);
    virtualStores.set(initialPath, store);
  }
  return store;
}

/** Test hook: forget virtual router state. */
export function resetVirtualRouter(): void {
  virtualStores.clear();
}

/**
 * Component-local router, mirroring Clerk's `routing="path" | "hash" | "virtual"` prop.
 * Navigation goes through the provider's `routerPush`/`routerReplace` when supplied.
 */
export function useRouter(options: RouterOptions = {}): Router {
  const { routing = "virtual", path: configuredBasePath, startPath = "/" } = options;
  const { routerPush, routerReplace } = useContext(OrbitIDOptionsContext);
  const basePath = routing === "virtual" ? "" : normalizePath(configuredBasePath ?? "/");
  const store = useMemo(
    () => (routing === "virtual" ? getVirtualStore(startPath) : null),
    [routing, startPath],
  );

  const readPath = useCallback((): string => {
    if (store) return store.get();
    if (!canUseWindow()) return normalizePath(startPath);
    if (routing === "hash") {
      const raw = window.location.hash.replace(/^#/, "");
      return normalizePath(stripBase(raw, basePath));
    }
    return normalizePath(stripBase(window.location.pathname, basePath));
  }, [routing, store, basePath, startPath]);

  const subscribe = useCallback(
    (onChange: () => void) => {
      if (store) return store.subscribe(onChange);
      if (!canUseWindow()) return () => {};
      const events = routing === "hash" ? ["hashchange", "popstate"] : ["popstate"];
      events.forEach((event) => window.addEventListener(event, onChange));
      return () => events.forEach((event) => window.removeEventListener(event, onChange));
    },
    [routing, store],
  );

  const currentPath = useSyncExternalStore(subscribe, readPath, () => normalizePath(startPath));

  const navigate = useCallback(
    (to: string, { replace = false }: { replace?: boolean } = {}) => {
      const target = normalizePath(to);
      if (store) {
        store.set(target);
        return;
      }
      if (!canUseWindow()) return;
      if (routing === "hash") {
        const hashTarget = joinPath(basePath, target);
        if (replace) {
          window.history.replaceState(
            null,
            "",
            `${window.location.pathname}${window.location.search}#${hashTarget}`,
          );
          window.dispatchEvent(new Event("hashchange"));
        } else if (routerPush) {
          routerPush(`${window.location.pathname}${window.location.search}#${hashTarget}`);
        } else {
          window.location.hash = hashTarget;
        }
        return;
      }
      const url = joinPath(basePath, target);
      if (replace) {
        if (routerReplace) routerReplace(url);
        else {
          window.history.replaceState(null, "", url);
          window.dispatchEvent(new PopStateEvent("popstate"));
        }
        return;
      }
      if (routerPush) routerPush(url);
      else {
        window.history.pushState(null, "", url);
        window.dispatchEvent(new PopStateEvent("popstate"));
      }
    },
    [routing, store, basePath, routerPush, routerReplace],
  );

  const match = useCallback((pattern: string) => matchPath(currentPath, pattern), [currentPath]);

  return useMemo(
    () => ({
      path: currentPath,
      basePath,
      routing,
      navigate,
      match,
    }),
    [currentPath, basePath, routing, navigate, match],
  );
}

/** Alias kept for readability at call sites that configure routing explicitly. */
export const usePathRouting = useRouter;

function canUseWindow(): boolean {
  return typeof window !== "undefined" && typeof window.location !== "undefined";
}

function stripBase(pathname: string, basePath: string): string {
  if (!basePath || basePath === "/") return pathname;
  if (pathname === basePath) return "/";
  if (pathname.startsWith(`${basePath}/`)) return pathname.slice(basePath.length);
  return pathname;
}
