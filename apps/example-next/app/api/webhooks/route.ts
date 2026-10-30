import { NextResponse } from "next/server";
import { verifyWebhook, WebhookVerificationError } from "@orbitid/nextjs/webhooks";

export async function POST(request: Request) {
  try {
    const event = await verifyWebhook(request);
    // Log the envelope only. `event.data` carries user emails, metadata and session details, so echoing it
    // would copy personal data into the server log on every delivery.
    const id = typeof (event.data as { id?: unknown } | null)?.id === "string" ? (event.data as { id: string }).id : undefined;
    console.log(`[webhook] ${event.type}${id ? ` ${id}` : ""}`);
    return NextResponse.json({ received: true, type: event.type });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return NextResponse.json({ error: error.reason }, { status: 400 });
    }
    throw error;
  }
}
