// OWNER: worker "admin" (W3). Persist event to webhook_events, fan out webhook_deliveries rows for matching endpoints, deliver asynchronously with retries.
import type { WebhookEventType } from "@orbitid/shared";
import type { AppContext } from "../context";

/** Fire-and-forget. MUST NOT throw. `data` is the wire JSON of the affected resource (UserJSON etc. – use backend=true serializers). */
export async function emitEvent(_ctx: AppContext, _type: WebhookEventType, _data: unknown): Promise<void> {
  // TODO(W3)
}
/** Start background delivery loop; returns stop(). Called once by startServer. */
export function startWebhookWorker(_ctx: AppContext): () => void {
  return () => {};
}
