import { NextResponse } from "next/server";
import { verifyWebhook, WebhookVerificationError } from "@orbitid/nextjs/webhooks";

export async function POST(request: Request) {
  try {
    const event = await verifyWebhook(request);
    console.log(`[webhook] ${event.type}`, event.data);
    return NextResponse.json({ received: true, type: event.type });
  } catch (error) {
    if (error instanceof WebhookVerificationError) {
      return NextResponse.json({ error: error.reason }, { status: 400 });
    }
    throw error;
  }
}
