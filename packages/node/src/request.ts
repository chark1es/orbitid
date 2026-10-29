import { parseCookie } from "@orbitid/backend";
import { COOKIES } from "@orbitid/shared";

export type HeaderValue = string | string[] | undefined | null;
export type HeaderLike = Headers | Record<string, HeaderValue> | null | undefined;

/** Anything with headers: a Fetch `Request`, a Node `IncomingMessage`, or a framework request. */
export interface RequestLike {
  headers?: HeaderLike;
}

/** Header access that works for Fetch `Headers`, Node header bags and Fastify/Hono wrappers. */
export function readHeader(headers: HeaderLike, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get(name);
  }
  const bag = headers as Record<string, HeaderValue>;
  const lower = name.toLowerCase();
  let value = bag[lower];
  if (value === undefined) {
    // Node lowercases header names, but duck-typed request objects and test fixtures may not.
    for (const key of Object.keys(bag)) {
      if (key.toLowerCase() === lower) {
        value = bag[key];
        break;
      }
    }
  }
  if (Array.isArray(value)) return value.length ? value.join(", ") : null;
  return value ?? null;
}

export function headersOf(request: RequestLike): HeaderLike {
  return request.headers;
}

/**
 * Reads the session JWT from `Authorization: Bearer` first, then the `__session` cookie.
 * A malformed `Authorization` header (wrong scheme, empty) falls through to the cookie.
 */
export function tokenFromRequest(request: RequestLike): string | null {
  const headers = headersOf(request);
  const authorization = readHeader(headers, "authorization");
  if (authorization) {
    const match = /^Bearer\s+(.+)$/i.exec(authorization.trim());
    if (match?.[1]) return match[1].trim();
  }
  return parseCookie(readHeader(headers, "cookie"), COOKIES.session);
}

/** True when the value looks like a Fetch `Request` rather than a Node request object. */
export function isFetchRequest(value: unknown): value is Request {
  return !!value && typeof value === "object" && typeof (value as Request).headers?.get === "function";
}
