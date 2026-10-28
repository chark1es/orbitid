import type { WebhookEvent } from "@orbitid/shared";
import { getWebhookSecret } from "./env";

/**
 * Svix-compatible webhook verification for route handlers, implemented with Web Crypto so it can
 * also be re-exported from `server.ts` without breaking the Edge middleware bundle.
 * Same scheme and error reasons as `@orbitid/backend/webhooks`.
 */

export const WEBHOOK_HEADERS = {
  id: "svix-id",
  timestamp: "svix-timestamp",
  signature: "svix-signature",
} as const;

export const WEBHOOK_TOLERANCE_SECONDS = 5 * 60;

export type WebhookVerificationErrorReason =
  | "missing-headers"
  | "invalid-secret"
  | "invalid-signature"
  | "timestamp-out-of-tolerance"
  | "invalid-payload";

export class WebhookVerificationError extends Error {
  constructor(
    readonly reason: WebhookVerificationErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface WebhookRequestLike {
  body: string | Uint8Array | Record<string, unknown>;
  headers: Headers | Record<string, string | string[] | undefined>;
}

export type VerifyWebhookInput = Request | WebhookRequestLike;

export interface VerifyWebhookOptions {
  /** Overrides `ORBITID_WEBHOOK_SECRET`. */
  secret?: string;
  /** Allowed clock skew for `svix-timestamp` (seconds). Defaults to 5 minutes. */
  toleranceSeconds?: number;
  /** Current unix time in milliseconds; injectable for tests. */
  now?: () => number;
}

function headerValue(
  headers: Headers | Record<string, string | string[] | undefined>,
  name: string,
): string | null {
  if (headers instanceof Headers) return headers.get(name);
  const value = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(value)) return value[0] ?? null;
  return value ?? null;
}

function decodeBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function secretBytes(secret: string): Uint8Array {
  const raw = secret.startsWith("whsec_") ? secret.slice("whsec_".length) : secret;
  try {
    const decoded = decodeBase64(raw);
    if (decoded.length > 0) return decoded;
  } catch {
    // Not base64: use the raw UTF-8 bytes.
  }
  return new TextEncoder().encode(secret);
}

function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) mismatch |= a[i]! ^ b[i]!;
  return mismatch === 0;
}

async function readBody(input: VerifyWebhookInput): Promise<string> {
  if (input instanceof Request) return input.text();
  if (typeof input.body === "string") return input.body;
  if (input.body instanceof Uint8Array) return new TextDecoder().decode(input.body);
  return JSON.stringify(input.body);
}

async function hmacSha256(secret: Uint8Array, message: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    secret as unknown as BufferSource,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message));
  return new Uint8Array(signature);
}

/**
 * Verify an incoming webhook and return the parsed event.
 *
 * ```ts
 * // app/api/webhooks/route.ts
 * import { verifyWebhook } from '@orbitid/nextjs/webhooks';
 *
 * export async function POST(req: Request) {
 *   const event = await verifyWebhook(req);
 *   return Response.json({ received: true, type: event.type });
 * }
 * ```
 */
export async function verifyWebhook<T = unknown>(
  input: VerifyWebhookInput,
  secretOrOptions: string | VerifyWebhookOptions = {},
): Promise<WebhookEvent<T>> {
  const options: VerifyWebhookOptions =
    typeof secretOrOptions === "string" ? { secret: secretOrOptions } : secretOrOptions;
  const secret = options.secret ?? getWebhookSecret();
  if (!secret) {
    throw new WebhookVerificationError(
      "invalid-secret",
      "Missing webhook secret: pass it as the second argument or set ORBITID_WEBHOOK_SECRET",
    );
  }

  const headers = input.headers;
  const id = headerValue(headers, WEBHOOK_HEADERS.id);
  const timestamp = headerValue(headers, WEBHOOK_HEADERS.timestamp);
  const signatureHeader = headerValue(headers, WEBHOOK_HEADERS.signature);
  if (!id || !timestamp || !signatureHeader) {
    throw new WebhookVerificationError(
      "missing-headers",
      "Missing svix-id, svix-timestamp or svix-signature header",
    );
  }

  const timestampSeconds = Number(timestamp);
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const tolerance = options.toleranceSeconds ?? WEBHOOK_TOLERANCE_SECONDS;
  if (!Number.isFinite(timestampSeconds) || Math.abs(nowSeconds - timestampSeconds) > tolerance) {
    throw new WebhookVerificationError(
      "timestamp-out-of-tolerance",
      "Webhook timestamp is outside the tolerance window",
    );
  }

  const body = await readBody(input);
  const expected = await hmacSha256(secretBytes(secret), `${id}.${timestamp}.${body}`);

  const valid = signatureHeader
    .split(" ")
    .filter(Boolean)
    .some((entry) => {
      const comma = entry.indexOf(",");
      if (comma === -1 || entry.slice(0, comma) !== "v1") return false;
      try {
        return equalBytes(expected, decodeBase64(entry.slice(comma + 1)));
      } catch {
        return false;
      }
    });
  if (!valid) {
    throw new WebhookVerificationError("invalid-signature", "Webhook signature does not match");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new WebhookVerificationError("invalid-payload", "Webhook body is not valid JSON");
  }
  if (
    typeof payload !== "object" ||
    payload === null ||
    !("type" in payload) ||
    typeof payload.type !== "string"
  ) {
    throw new WebhookVerificationError("invalid-payload", "Webhook body is missing the event type");
  }
  return payload as WebhookEvent<T>;
}
