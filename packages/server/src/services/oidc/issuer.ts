// Public origin used as the OIDC `issuer` and as the base of every advertised endpoint.
//
// ORBITID_BASE_URL (ctx.env.baseUrl) is the stable, canonical answer and wins everywhere. Only when the operator
// did not set it *and* explicitly trusts a reverse proxy (`ORBITID_TRUST_PROXY`) do we read the forwarded scheme and
// host. That keeps the issuer stable across discovery and token requests while still working behind a proxy that
// terminates TLS: the proxy must set X-Forwarded-Proto/Host on every request (see docs/OIDC.md).
import type { AppContext } from "../../context";

export type HeaderReader = (name: string) => string | null | undefined;

const firstValue = (value: string | null | undefined) => (value ?? "").split(",")[0]!.trim();
const stripSlash = (value: string) => value.replace(/\/+$/, "");

/** Absolute public origin, never with a trailing slash. */
export function issuerFor(ctx: AppContext, headers: HeaderReader): string {
  if (ctx.env.baseUrlExplicit || ctx.env.trustProxy < 1) return stripSlash(ctx.env.baseUrl);
  const proto = firstValue(headers("x-forwarded-proto")).toLowerCase();
  const host = firstValue(headers("x-forwarded-host"));
  if ((proto !== "https" && proto !== "http") || !host) return stripSlash(ctx.env.baseUrl);
  const port = firstValue(headers("x-forwarded-port"));
  const authority = /:\d+$/.test(host) || port === "" ? host : `${host}:${port}`;
  try {
    const url = new URL(`${proto}://${authority}`);
    // Reject credentials, paths or query strings smuggled into the forwarded host.
    if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) return stripSlash(ctx.env.baseUrl);
    return url.origin;
  } catch {
    return stripSlash(ctx.env.baseUrl);
  }
}

/** Builds an absolute URL below the public issuer. `path` must start with `/`. */
export function issuerUrl(ctx: AppContext, headers: HeaderReader, path: string, params?: Record<string, string | null | undefined>): string {
  const url = new URL(`${issuerFor(ctx, headers)}${path}`);
  for (const [key, value] of Object.entries(params ?? {})) if (value != null && value !== "") url.searchParams.set(key, value);
  return url.toString();
}

/** True when the loopback redirect URI matches on scheme/host/path and only the port differs (RFC 8252 §7.3). */
export function loopbackRedirectMatch(registered: string, requested: string): boolean {
  const isLoopback = (host: string) => host === "localhost" || host === "127.0.0.1" || host === "[::1]";
  try {
    const a = new URL(registered);
    const b = new URL(requested);
    if (a.protocol !== "http:" || b.protocol !== "http:") return false;
    if (!isLoopback(a.hostname) || a.hostname !== b.hostname) return false;
    return a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}
