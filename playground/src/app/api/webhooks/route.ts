import { WebhookVerificationError, verifyWebhook } from "@orbitid/backend/webhooks";
import type { WebhookEvent } from "@orbitid/shared";
import { readSecretKey, resolveApiUrl } from "@/lib/env";
import { getEndpoint, listWebhookEvents, recordWebhookEvent, verificationSecret } from "@/lib/webhook-store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
}

/** Svix-compatible receiver. Verifies with ORBITID_WEBHOOK_SECRET, a pasted secret, or the endpoint registered here. */
export async function POST(request: Request) {
  const { secret, source } = verificationSecret();
  if (!secret) {
    return json(
      {
        error: "no-verification-secret",
        detail:
          "Register this receiver on the Webhooks page, paste the endpoint secret there, or set ORBITID_WEBHOOK_SECRET.",
      },
      400,
    );
  }

  const body = await request.text();
  try {
    const event = await verifyWebhook<unknown>(
      { body, headers: request.headers },
      { signingSecret: secret },
    );
    recordWebhookEvent(event as WebhookEvent);
    return json({ received: true, id: event.id, type: event.type, verifiedWith: source });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return json({ error: error.reason, message: error.message }, 400);
    }
    return json(
      { error: "verification-failed", message: error instanceof Error ? error.message : "Unknown verification error" },
      400,
    );
  }
}

interface DeliverySummary {
  id: string;
  eventType: string;
  status: string;
  attempt: number;
  responseCode: number | null;
  nextAttemptAt: number | null;
  createdAt: number;
}

/** State for the page poll: received events, the registered endpoint, and its recent deliveries. */
export async function GET() {
  const endpoint = getEndpoint();
  const secret = verificationSecret();
  let deliveries: DeliverySummary[] | null = null;
  let deliveryError: string | null = null;
  const secretKey = readSecretKey();

  if (!secretKey) {
    deliveryError = "Set ORBITID_SECRET_KEY in playground/.env.local to read deliveries from the Backend API.";
  } else if (!endpoint) {
    deliveryError = "Register the receiver on this page to read its deliveries. The Backend API lists deliveries per endpoint.";
  } else {
    const url = `${resolveApiUrl()}/v1/webhooks/endpoints/${endpoint.id}/deliveries?limit=25`;
    try {
      const response = await fetch(url, {
        cache: "no-store",
        headers: { Authorization: `Bearer ${secretKey}`, Accept: "application/json" },
      });
      if (!response.ok) {
        deliveryError = `The Backend API answered ${response.status} for ${url}. Check the server log and the key on the Setup page.`;
      } else {
        const payload = (await response.json()) as { data?: Array<Record<string, unknown>> };
        deliveries = (payload.data ?? []).map((item) => ({
          id: String(item.id ?? ""),
          eventType: String(item.event_type ?? ""),
          status: String(item.status ?? "pending"),
          attempt: Number(item.attempt ?? 0),
          responseCode: typeof item.response_code === "number" ? item.response_code : null,
          nextAttemptAt: typeof item.next_attempt_at === "number" ? item.next_attempt_at : null,
          createdAt: Number(item.created_at ?? 0),
        }));
      }
    } catch (error) {
      deliveryError =
        error instanceof Error
          ? `${error.message} Check ORBITID_API_URL on the Setup page.`
          : "The Backend API did not answer.";
    }
  }

  return json({
    events: listWebhookEvents(),
    endpoint: endpoint ? { id: endpoint.id, url: endpoint.url } : null,
    secretSource: secret.source,
    deliveries,
    deliveryError,
    checkedAt: Date.now(),
  });
}
