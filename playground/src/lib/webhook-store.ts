import type { WebhookEvent } from "@orbitid/shared";

export interface StoredWebhookEvent {
  id: string;
  type: string;
  receivedAt: number;
  payload: WebhookEvent;
}

export interface ReceiverEndpoint {
  id: string;
  url: string;
  secret: string | null;
  eventTypes: string[];
  registeredAt: number;
}

interface WebhookState {
  events: StoredWebhookEvent[];
  endpoint: ReceiverEndpoint | null;
  manualSecret: string | null;
}

const MAX_EVENTS = 100;

function state(): WebhookState {
  const scope = globalThis as unknown as Record<string, WebhookState | undefined>;
  scope.__orbitidPlaygroundWebhookState ??= { events: [], endpoint: null, manualSecret: null };
  return scope.__orbitidPlaygroundWebhookState;
}

export function recordWebhookEvent(event: WebhookEvent): StoredWebhookEvent {
  const stored: StoredWebhookEvent = {
    id: event.id,
    type: event.type,
    receivedAt: Date.now(),
    payload: event,
  };
  const current = state();
  const duplicate = current.events.some((item) => item.id === event.id);
  if (!duplicate) current.events = [stored, ...current.events].slice(0, MAX_EVENTS);
  return stored;
}

export function listWebhookEvents(): StoredWebhookEvent[] {
  return state().events;
}

export function clearWebhookEvents(): void {
  state().events = [];
}

export function rememberEndpoint(endpoint: ReceiverEndpoint): void {
  state().endpoint = endpoint;
}

export function getEndpoint(): ReceiverEndpoint | null {
  return state().endpoint;
}

export function forgetEndpoint(): void {
  state().endpoint = null;
}

export function setManualSecret(secret: string | null): void {
  state().manualSecret = secret;
}

export type SecretSource = "env" | "form" | "endpoint" | "none";

export function verificationSecret(): { secret: string | null; source: SecretSource } {
  const fromEnv = process.env.ORBITID_WEBHOOK_SECRET?.trim();
  if (fromEnv) return { secret: fromEnv, source: "env" };
  const manual = state().manualSecret;
  if (manual) return { secret: manual, source: "form" };
  const endpointSecret = state().endpoint?.secret;
  if (endpointSecret) return { secret: endpointSecret, source: "endpoint" };
  return { secret: null, source: "none" };
}
