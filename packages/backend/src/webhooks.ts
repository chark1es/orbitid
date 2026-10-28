import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import type { WebhookEvent } from "@orbitid/shared";
import { isRecord } from "./object";

export type WebhookVerificationErrorReason = "missing-headers" | "invalid-secret" | "invalid-signature" | "timestamp-out-of-tolerance" | "invalid-payload";

export class WebhookVerificationError extends Error {
  constructor(
    public readonly reason: WebhookVerificationErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "WebhookVerificationError";
  }
}

export interface VerifyWebhookOptions {
  signingSecret: string;
  toleranceInSeconds?: number;
  now?: () => number;
}

export interface WebhookRequestLike {
  body: string;
  headers: Headers | Record<string, string | undefined>;
}

export interface SignWebhookOptions {
  id?: string;
  timestamp?: number;
  now?: () => number;
}

export interface SignedWebhook {
  headers: Record<string, string>;
  body: string;
}

const DEFAULT_TOLERANCE_SECONDS = 300;

function readHeader(headers: Headers | Record<string, string | undefined>, name: string): string | null {
  if (headers instanceof Headers) return headers.get(name);
  return headers[name] ?? headers[name.toLowerCase()] ?? null;
}

function secretBytes(signingSecret: string): Buffer {
  const encoded = signingSecret.startsWith("whsec_") ? signingSecret.slice("whsec_".length) : signingSecret;
  const bytes = Buffer.from(encoded, "base64");
  if (!bytes.length) throw new WebhookVerificationError("invalid-secret", "Webhook signing secret is empty");
  return bytes;
}

function signatureFor(secret: Buffer, id: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${id}.${timestamp}.${body}`).digest("base64");
}

function matches(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, "base64");
  let providedBytes: Buffer;
  try {
    providedBytes = Buffer.from(provided, "base64");
  } catch {
    return false;
  }
  return expectedBytes.length === providedBytes.length && timingSafeEqual(expectedBytes, providedBytes);
}

function isRequestLike(value: Request | WebhookRequestLike): value is Request {
  return "text" in value && typeof value.text === "function";
}

/** Svix-compatible webhook verification (`svix-id`, `svix-timestamp`, `svix-signature`). */
export async function verifyWebhook<T = unknown>(
  request: Request | WebhookRequestLike,
  options: VerifyWebhookOptions,
): Promise<WebhookEvent<T>> {
  const headers = request.headers;
  const id = readHeader(headers, "svix-id");
  const timestamp = readHeader(headers, "svix-timestamp");
  const signatureHeader = readHeader(headers, "svix-signature");
  if (!id || !timestamp || !signatureHeader) {
    throw new WebhookVerificationError("missing-headers", "Missing svix-id, svix-timestamp or svix-signature header");
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    throw new WebhookVerificationError("timestamp-out-of-tolerance", "Invalid svix-timestamp header");
  }
  const nowSeconds = Math.floor((options.now?.() ?? Date.now()) / 1000);
  const tolerance = options.toleranceInSeconds ?? DEFAULT_TOLERANCE_SECONDS;
  if (Math.abs(nowSeconds - timestampSeconds) > tolerance) {
    throw new WebhookVerificationError("timestamp-out-of-tolerance", "Webhook timestamp is outside the tolerance window");
  }

  const body = isRequestLike(request) ? await request.text() : request.body;
  const secret = secretBytes(options.signingSecret);
  const expected = signatureFor(secret, id, timestamp, body);
  const valid = signatureHeader
    .split(" ")
    .filter(Boolean)
    .some((entry) => {
      const [version, provided] = entry.split(",", 2);
      return version === "v1" && !!provided && matches(expected, provided);
    });
  if (!valid) throw new WebhookVerificationError("invalid-signature", "Webhook signature does not match");

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new WebhookVerificationError("invalid-payload", "Webhook body is not valid JSON");
  }
  if (!isRecord(payload) || typeof payload.type !== "string") {
    throw new WebhookVerificationError("invalid-payload", "Webhook body is missing the event type");
  }
  return payload as unknown as WebhookEvent<T>;
}

/** Signs a webhook payload (tests, local replay tools). */
export function signWebhook(payload: unknown, options: VerifyWebhookOptions & SignWebhookOptions): SignedWebhook {
  const body = typeof payload === "string" ? payload : JSON.stringify(payload);
  const secret = secretBytes(options.signingSecret);
  const id = options.id ?? `msg_${randomUUID().replace(/-/g, "")}`;
  const timestamp = String(options.timestamp ?? Math.floor((options.now?.() ?? Date.now()) / 1000));
  return {
    headers: { "svix-id": id, "svix-timestamp": timestamp, "svix-signature": `v1,${signatureFor(secret, id, timestamp, body)}` },
    body,
  };
}
