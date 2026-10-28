// Outbound HTTP for user/admin-controlled URLs: one place that refuses internal targets.
//
// The danger is server-side request forgery: an operator (or an attacker who can set a webhook/OIDC URL)
// points a URL at the loopback interface, a private network or the cloud metadata service. We therefore
// resolve the hostname ourselves, judge every address, connect to the judged address (so a second DNS
// answer cannot redirect us), follow redirects by hand re-validating each hop, and bound time and size.
import { isIP } from "node:net";
import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { createLocalJWKSet, type JSONWebKeySet } from "jose";
import { OrbitError, ErrorCodes } from "@orbitid/shared";
import type { AppContext } from "../context";

export interface SafeFetchOptions {
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer | URLSearchParams;
  /** Total time budget for the whole chain, in ms. */
  timeoutMs?: number;
  /** Maximum number of manual redirects to follow. */
  maxRedirects?: number;
  /** Maximum response body size in bytes; larger responses are refused. */
  maxBytes?: number;
}

export interface SafeFetchResult {
  status: number;
  ok: boolean;
  headers: Headers;
  body: string;
  json<T = unknown>(): T;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_REDIRECTS = 3;
const DEFAULT_MAX_BYTES = 1024 * 1024;

/** Private networks are only reachable when the operator opted in (local development, test fixtures). */
export function privateNetworksAllowed(ctx?: AppContext | null): boolean {
  if (process.env.ORBITID_ALLOW_PRIVATE_NETWORKS === "true") return true;
  try {
    return ctx?.settings.get().application.developmentMode === true;
  } catch {
    return false;
  }
}

export class SafeFetchError extends OrbitError {
  constructor(message: string) {
    super(400, ErrorCodes.form_param_format_invalid, message);
  }
}

const ipv4Parts = (address: string): number[] | null => {
  const parts = address.split(".");
  if (parts.length !== 4) return null;
  const nums = parts.map((p) => (/^\d{1,3}$/.test(p) ? Number(p) : NaN));
  return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
};

const inV4 = (parts: number[], prefix: number[], bits: number): boolean => {
  const a = (parts[0]! << 24) >>> 0 | (parts[1]! << 16) | (parts[2]! << 8) | parts[3]!;
  const b = (prefix[0]! << 24) >>> 0 | (prefix[1]! << 16) | (prefix[2]! << 8) | prefix[3]!;
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return ((a & mask) >>> 0) === ((b & mask) >>> 0);
};

/** Every non-public IPv4 range we care about, including the cloud metadata endpoint (169.254.169.254). */
const V4_BLOCKS: { parts: number[]; bits: number; label: string }[] = [
  { parts: [0, 0, 0, 0], bits: 8, label: "this network" },
  { parts: [10, 0, 0, 0], bits: 8, label: "private network" },
  { parts: [100, 64, 0, 0], bits: 10, label: "carrier-grade NAT" },
  { parts: [127, 0, 0, 0], bits: 8, label: "loopback" },
  { parts: [169, 254, 0, 0], bits: 16, label: "link-local / cloud metadata" },
  { parts: [172, 16, 0, 0], bits: 12, label: "private network" },
  { parts: [192, 0, 0, 0], bits: 24, label: "IETF protocol assignment" },
  { parts: [192, 0, 2, 0], bits: 24, label: "documentation" },
  { parts: [192, 168, 0, 0], bits: 16, label: "private network" },
  { parts: [198, 18, 0, 0], bits: 15, label: "benchmarking" },
  { parts: [198, 51, 100, 0], bits: 24, label: "documentation" },
  { parts: [203, 0, 113, 0], bits: 24, label: "documentation" },
  { parts: [224, 0, 0, 0], bits: 4, label: "multicast" },
  { parts: [240, 0, 0, 0], bits: 4, label: "reserved" },
];

/** True when this address must not be contacted for a user-supplied URL. */
export function isPrivateAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const parts = ipv4Parts(address);
    if (!parts) return true;
    return V4_BLOCKS.some((block) => inV4(parts, block.parts, block.bits));
  }
  if (family === 6) {
    const lower = address.toLowerCase().split("%")[0]!;
    // IPv4-mapped (::ffff:127.0.0.1) and IPv4-compatible addresses inherit the IPv4 verdict.
    const mapped = /^(?:::ffff:|::)((?:\d{1,3}\.){3}\d{1,3})$/.exec(lower);
    if (mapped) return isPrivateAddress(mapped[1]!);
    if (lower === "::" || lower === "::1") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // unique local fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // link-local fe80::/10
    if (/^ff[0-9a-f]{2}:/.test(lower)) return true; // multicast
    return false;
  }
  // Not an IP at all: callers resolve first, so this is defensive.
  return true;
}

/** Parses + vets a URL: only http(s), no embedded credentials, hostname present. */
export function parseExternalUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SafeFetchError("URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SafeFetchError("URL must use http or https");
  if (url.username || url.password) throw new SafeFetchError("URLs must not contain credentials");
  if (!url.hostname) throw new SafeFetchError("URL must name a host");
  return url;
}

/** Resolves and judges the target. Throws when the destination is not allowed. */
export async function resolvePublicAddress(url: URL, allowPrivate: boolean): Promise<{ address: string; family: 4 | 6 }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  let addresses: { address: string; family: number }[];
  if (isIP(host)) addresses = [{ address: host, family: isIP(host) }];
  else {
    try {
      addresses = await lookup(host, { all: true, verbatim: true });
    } catch {
      throw new SafeFetchError(`Could not resolve ${host}`);
    }
  }
  if (!addresses.length) throw new SafeFetchError(`Could not resolve ${host}`);
  const blocked = allowPrivate ? undefined : addresses.find((entry) => isPrivateAddress(entry.address));
  if (blocked) throw new SafeFetchError(`${host} resolves to a non-public address (${blocked.address}); this is not allowed`);
  const chosen = addresses[0]!;
  return { address: chosen.address, family: chosen.family === 6 ? 6 : 4 };
}

/**
 * Validates an operator-provided URL (webhook endpoint, SSO discovery, …) at write time: http(s) only, no
 * embedded credentials, and no literal private/loopback IP. Hostnames are not resolved here (an IdP may
 * live on internal DNS and still be legitimate); the real guard is at request time in `safeFetch`, which
 * resolves and pins the address. Throws an OrbitError naming the field so the API returns a 422.
 */
export async function assertPublicUrl(ctx: AppContext | null, raw: string, paramName = "url"): Promise<URL> {
  let url: URL;
  try {
    url = parseExternalUrl(raw);
  } catch (err) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, (err as Error).message, { param_name: paramName });
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host) && !privateNetworksAllowed(ctx) && isPrivateAddress(host)) {
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `${url.hostname} is a private or loopback address; this is not allowed`, { param_name: paramName });
  }
  return url;
}

/**
 * A JWKS verifier built from a set fetched through `safeFetch`, so a custom provider's `jwks_uri` cannot
 * point at an internal host. `jose`'s own remote set bypasses this module, hence the manual fetch + cache.
 */
const jwksCache = new Map<string, { set: ReturnType<typeof createLocalJWKSet>; expiresAt: number }>();
export async function remoteJwks(ctx: AppContext | null, uri: string, opts: { ttlMs?: number } = {}) {
  const cached = jwksCache.get(uri);
  if (cached && cached.expiresAt > Date.now()) return cached.set;
  const res = await safeFetch(ctx, uri, { timeoutMs: 5_000, maxBytes: 256 * 1024 });
  if (!res.ok) throw new SafeFetchError(`Could not load the key set from ${new URL(uri).host} (${res.status})`);
  let jwks: JSONWebKeySet;
  try {
    jwks = JSON.parse(res.body) as JSONWebKeySet;
  } catch {
    throw new SafeFetchError(`The key set at ${new URL(uri).host} is not JSON`);
  }
  if (!jwks || !Array.isArray(jwks.keys)) throw new SafeFetchError(`The key set at ${new URL(uri).host} has no keys`);
  const set = createLocalJWKSet(jwks);
  jwksCache.set(uri, { set, expiresAt: Date.now() + (opts.ttlMs ?? 5 * 60_000) });
  return set;
}

/** Forgets cached key sets (tests change providers between cases). */
export function resetJwksCache() {
  jwksCache.clear();
}

function sendOnce(url: URL, address: string, family: 4 | 6, opts: SafeFetchOptions, signal: AbortSignal): Promise<{ status: number; headers: Headers; body: string }> {
  const method = (opts.method ?? "GET").toUpperCase();
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  headers.host = url.host;
  let body: Buffer | undefined;
  if (opts.body !== undefined && method !== "GET" && method !== "HEAD") {
    body = Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body instanceof URLSearchParams ? opts.body.toString() : opts.body);
  }
  const maxBytes = opts.maxBytes ?? DEFAULT_MAX_BYTES;
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const req = transport({
      protocol: url.protocol,
      host: address,
      family,
      port: url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80,
      path: `${url.pathname}${url.search}`,
      method,
      headers,
      // Pinning the address means the TLS certificate must still be valid for the URL's hostname.
      servername: url.protocol === "https:" ? url.hostname.replace(/^\[|\]$/g, "") : undefined,
      signal,
    }, (res) => {
      const chunks: Buffer[] = [];
      let size = 0;
      res.on("data", (chunk: Buffer) => {
        if (settled) return;
        size += chunk.length;
        if (size > maxBytes) {
          // Destroy without an error argument: the verdict is reported through `fail`, and the socket
          // teardown must not raise a second, unhandled error on the response stream.
          fail(new SafeFetchError(`Response from ${url.host} exceeds ${maxBytes} bytes`));
          res.destroy();
          req.destroy();
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        if (settled) return;
        settled = true;
        const responseHeaders = new Headers();
        for (const [key, value] of Object.entries(res.headers)) {
          if (Array.isArray(value)) for (const item of value) responseHeaders.append(key, item);
          else if (value !== undefined) responseHeaders.set(key, String(value));
        }
        resolve({ status: res.statusCode ?? 0, headers: responseHeaders, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", fail);
    });
    req.on("error", fail);
    if (body) req.write(body);
    req.end();
  });
}

/**
 * Convenience wrapper: performs the request and parses JSON, converting every failure into an OrbitError
 * the caller can surface. `errorCode` defaults to a generic provider error.
 */
export async function safeFetchJson<T = unknown>(
  ctx: AppContext | null,
  rawUrl: string,
  options: SafeFetchOptions & { errorCode?: string; errorStatus?: number } = {},
): Promise<T> {
  const res = await safeFetch(ctx, rawUrl, options);
  if (!res.ok) throw new OrbitError(options.errorStatus ?? 502, options.errorCode ?? ErrorCodes.request_body_invalid, `Request to ${new URL(rawUrl).host} failed (${res.status})`);
  try {
    return JSON.parse(res.body) as T;
  } catch {
    throw new OrbitError(options.errorStatus ?? 502, options.errorCode ?? ErrorCodes.request_body_invalid, `Request to ${new URL(rawUrl).host} did not return JSON`);
  }
}

/**
 * `fetch` for URLs a user or admin controls. Same call/response shape as the global `fetch` for the
 * parts this server uses, but: http(s) only, credentials stripped, DNS resolved and vetted here, the
 * connection pinned to the vetted address, at most `maxRedirects` hops re-validated one by one, and a
 * bounded time budget and response size.
 */
export async function safeFetch(ctx: AppContext | null, rawUrl: string, options: SafeFetchOptions = {}): Promise<SafeFetchResult> {
  const allowPrivate = privateNetworksAllowed(ctx);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_REDIRECTS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    let url = parseExternalUrl(rawUrl);
    for (let hop = 0; ; hop++) {
      const { address, family } = await resolvePublicAddress(url, allowPrivate);
      const res = await sendOnce(url, address, family, options, controller.signal);
      const location = res.headers.get("location");
      if (res.status >= 300 && res.status < 400 && location) {
        if (hop >= maxRedirects) throw new SafeFetchError(`Too many redirects (more than ${maxRedirects})`);
        url = parseExternalUrl(new URL(location, url).toString());
        continue;
      }
      return {
        status: res.status,
        ok: res.status >= 200 && res.status < 300,
        headers: res.headers,
        body: res.body,
        json<T = unknown>() {
          try {
            return JSON.parse(res.body) as T;
          } catch {
            throw new SafeFetchError(`${url.host} did not return JSON`);
          }
        },
      };
    }
  } catch (err) {
    if (err instanceof OrbitError) throw err;
    if ((err as Error)?.name === "AbortError") throw new SafeFetchError(`Request to ${new URL(rawUrl).host} timed out`);
    throw new SafeFetchError((err as Error)?.message || "Outbound request failed");
  } finally {
    clearTimeout(timer);
  }
}
