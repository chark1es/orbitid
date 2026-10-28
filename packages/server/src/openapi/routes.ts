/**
 * Route inventory for the drift guard.
 *
 * `app.routes` is what the server actually answers, including the `ALL` wildcards that middleware mounts add
 * (`/*` for CORS, `/v1/*` for the secret-key gate). Those are not endpoints and are dropped here. The dashboard's
 * `GET /*` SPA fallback is the only wildcard left, and the drift test allowlists it explicitly.
 */
import type { Hono } from "hono";

export interface RouteEntry {
  method: string;
  /** Hono path with `:param` segments rewritten to OpenAPI `{param}`. */
  path: string;
}

export const toOpenApiPath = (path: string): string => path.replace(/:([A-Za-z0-9_]+)/g, "{$1}");

export const canonical = (method: string, path: string): string => `${method.toUpperCase()} ${toOpenApiPath(path)}`;

/**
 * Every method/path pair the Hono app answers, normalised and de-duplicated (a path can be registered twice when two
 * modules mount the same route).
 */
export function listRoutes(app: Hono): RouteEntry[] {
  const seen = new Set<string>();
  const routes: RouteEntry[] = [];
  for (const route of app.routes) {
    if (route.method === "ALL") continue;
    const path = toOpenApiPath(route.path);
    const key = canonical(route.method, path);
    if (seen.has(key)) continue;
    seen.add(key);
    routes.push({ method: route.method, path });
  }
  return routes.sort((a, b) => canonical(a.method, a.path).localeCompare(canonical(b.method, b.path)));
}

export const routeKey = (route: { method: string; path: string }): string => canonical(route.method, route.path);
