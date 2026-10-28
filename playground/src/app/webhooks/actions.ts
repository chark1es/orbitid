"use server";

import { revalidatePath } from "next/cache";
import { WEBHOOK_EVENT_TYPES } from "@orbitid/shared";
import type { ActionResult } from "@/lib/action-state";
import { createBackend, currentOrigin, readSecretKey, resolveApiUrl } from "@/lib/env";
import { describeError } from "@/lib/errors";
import {
  clearWebhookEvents,
  getEndpoint,
  rememberEndpoint,
  setManualSecret,
} from "@/lib/webhook-store";

const NO_SECRET: ActionResult = {
  ok: false,
  message: "ORBITID_SECRET_KEY is not set.",
  detail: "Add it to playground/.env.local, restart the dev server, then reload this page.",
};

export async function registerReceiver(_previous: ActionResult, _formData: FormData): Promise<ActionResult> {
  if (!readSecretKey()) return NO_SECRET;
  try {
    const receiverUrl = `${await currentOrigin()}/api/webhooks`;
    const endpoint = await createBackend().webhooks.createWebhookEndpoint({
      url: receiverUrl,
      description: "OrbitID playground receiver",
      eventTypes: [...WEBHOOK_EVENT_TYPES],
    });
    rememberEndpoint({
      id: endpoint.id,
      url: endpoint.url,
      secret: endpoint.secret ?? null,
      eventTypes: endpoint.eventTypes,
      registeredAt: Date.now(),
    });
    revalidatePath("/webhooks");
    return {
      ok: true,
      message: `Registered this site as an endpoint for ${endpoint.eventTypes.length} event types.`,
      detail: endpoint.secret
        ? "The signing secret is stored in the dev server memory and verifies incoming events. It is shown once below."
        : "The endpoint was created without a returned secret. Set ORBITID_WEBHOOK_SECRET or paste the secret.",
      secret: endpoint.secret,
    };
  } catch (error) {
    return { ok: false, message: describeError(error), detail: "Check the server log and the key on the Setup page." };
  }
}

export async function sendTestEvent(_previous: ActionResult, _formData: FormData): Promise<ActionResult> {
  const endpoint = getEndpoint();
  const secretKey = readSecretKey();
  if (!secretKey) return NO_SECRET;
  if (!endpoint) {
    return {
      ok: false,
      message: "No receiver is registered from this page.",
      detail: "Register the receiver first, or use an endpoint you created in the dashboard.",
    };
  }
  try {
    // The Backend API exposes this per endpoint. The SDK helper posts to a different path.
    const response = await fetch(`${resolveApiUrl()}/v1/webhooks/endpoints/${endpoint.id}/test`, {
      method: "POST",
      cache: "no-store",
      headers: { Authorization: `Bearer ${secretKey}`, Accept: "application/json" },
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const errors = (body as { errors?: Array<{ message?: string; code?: string }> } | null)?.errors;
      const first = Array.isArray(errors) && errors.length ? errors[0] : null;
      return {
        ok: false,
        message: `${response.status}: ${first?.message ?? first?.code ?? "The test event was rejected."}`,
        detail: "The endpoint still exists on the instance. Check the server log.",
      };
    }
    const status = (body as { status?: string } | null)?.status;
    revalidatePath("/webhooks");
    return {
      ok: true,
      message: `Test event sent to ${endpoint.url}.`,
      detail: status ? `Delivery status ${status}.` : "The receiver should show the event within one poll.",
    };
  } catch (error) {
    return { ok: false, message: describeError(error), detail: "Check that the OrbitID server is running." };
  }
}

export async function saveWebhookSecret(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const value = String(formData.get("secret") ?? "").trim();
  if (!value) {
    setManualSecret(null);
    revalidatePath("/webhooks");
    return {
      ok: true,
      message: "Cleared the pasted secret.",
      detail: "Verification falls back to ORBITID_WEBHOOK_SECRET, then to the endpoint registered here.",
    };
  }
  if (!value.startsWith("whsec_") && value.length < 16) {
    return {
      ok: false,
      message: "That does not look like an endpoint secret.",
      detail: "Secrets start with whsec_ and are longer than 16 characters. Copy it from the dashboard.",
    };
  }
  setManualSecret(value);
  revalidatePath("/webhooks");
  return {
    ok: true,
    message: "The receiver will verify signatures with the pasted secret.",
    detail: "This lives in dev server memory only and is lost on restart.",
  };
}

export async function clearReceivedEvents(_previous: ActionResult, _formData: FormData): Promise<ActionResult> {
  clearWebhookEvents();
  revalidatePath("/webhooks");
  return { ok: true, message: "Cleared the received event list." };
}
