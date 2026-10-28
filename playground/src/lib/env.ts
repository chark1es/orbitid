import { createOrbitIdClient, type OrbitIdClient } from "@orbitid/backend";
import { decodePublishableKey } from "@orbitid/shared";
import type { EnvironmentJSON } from "@orbitid/shared";
import { headers } from "next/headers";
import type { InstanceSnapshot } from "./feature-matrix";

const DEFAULT_API_URL = "http://localhost:4000";

export interface InstanceStatus {
  publishableKey: string | null;
  publishableKeyValid: boolean;
  publishableKeyEnv: "test" | "live" | null;
  frontendApi: string | null;
  apiUrl: string;
  apiUrlFromKey: boolean;
  secretKeyPresent: boolean;
  webhookSecretPresent: boolean;
  health: {
    reachable: boolean;
    status: number | null;
    database: string | null;
    latencyMs: number | null;
    keyMatches: boolean | null;
    error: string | null;
    checkedAt: number;
  };
}

export function readPublishableKey(): string | null {
  const value = process.env.NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY?.trim();
  return value || null;
}

export function readSecretKey(): string | null {
  const value = process.env.ORBITID_SECRET_KEY?.trim();
  return value || null;
}

export function readWebhookSecret(): string | null {
  const value = process.env.ORBITID_WEBHOOK_SECRET?.trim();
  return value || null;
}

export function decodeKey(): { frontendApi: string; env: "test" | "live" } | null {
  const key = readPublishableKey();
  if (!key) return null;
  try {
    return decodePublishableKey(key);
  } catch {
    return null;
  }
}

export function resolveApiUrl(): string {
  const explicit = process.env.ORBITID_API_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  return decodeKey()?.frontendApi.replace(/\/+$/, "") ?? DEFAULT_API_URL;
}

export function createBackend(): OrbitIdClient {
  const secretKey = readSecretKey();
  if (!secretKey) throw new Error("ORBITID_SECRET_KEY is not set in playground/.env.local");
  return createOrbitIdClient({ secretKey, apiUrl: resolveApiUrl() });
}

interface HealthPayload {
  status?: string;
  database?: string;
  publishable_key?: string;
}

async function fetchJson<T>(url: string, timeoutMs: number): Promise<{ status: number; body: T | null }> {
  const response = await fetch(url, {
    cache: "no-store",
    signal: AbortSignal.timeout(timeoutMs),
    headers: { Accept: "application/json" },
  });
  let body: T | null = null;
  try {
    body = (await response.json()) as T;
  } catch {
    body = null;
  }
  return { status: response.status, body };
}

function fetchError(error: unknown, apiUrl: string): string {
  if (error instanceof Error && error.name === "TimeoutError") {
    return `No answer from ${apiUrl} within 4 seconds. Start the server or check ORBITID_API_URL.`;
  }
  if (error instanceof Error) {
    return `${apiUrl} could not be reached (${error.message}). Start the server or check ORBITID_API_URL.`;
  }
  return `${apiUrl} could not be reached.`;
}

export async function getInstanceStatus(): Promise<InstanceStatus> {
  const publishableKey = readPublishableKey();
  const decoded = decodeKey();
  const explicitApiUrl = process.env.ORBITID_API_URL?.trim();
  const apiUrl = resolveApiUrl();
  const started = Date.now();
  const base: InstanceStatus = {
    publishableKey,
    publishableKeyValid: Boolean(decoded),
    publishableKeyEnv: decoded?.env ?? null,
    frontendApi: decoded?.frontendApi.replace(/\/+$/, "") ?? null,
    apiUrl,
    apiUrlFromKey: !explicitApiUrl && Boolean(decoded),
    secretKeyPresent: Boolean(readSecretKey()),
    webhookSecretPresent: Boolean(readWebhookSecret()),
    health: {
      reachable: false,
      status: null,
      database: null,
      latencyMs: null,
      keyMatches: null,
      error: "Set NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY to check the instance.",
      checkedAt: Date.now(),
    },
  };

  if (!decoded) return base;

  try {
    const { status, body } = await fetchJson<HealthPayload>(`${apiUrl}/health`, 4000);
    const latencyMs = Date.now() - started;
    const serverKey = typeof body?.publishable_key === "string" ? body.publishable_key : null;
    return {
      ...base,
      health: {
        reachable: status >= 200 && status < 300,
        status,
        database: typeof body?.database === "string" ? body.database : null,
        latencyMs,
        keyMatches: serverKey && publishableKey ? serverKey === publishableKey : null,
        error: status >= 200 && status < 300 ? null : `The health check answered ${status}.`,
        checkedAt: Date.now(),
      },
    };
  } catch (error) {
    return {
      ...base,
      health: { ...base.health, error: fetchError(error, apiUrl) },
    };
  }
}

export type EnvironmentLoad =
  | { ok: true; environment: EnvironmentJSON }
  | { ok: false; error: string; status: number | null };

export async function loadEnvironment(): Promise<EnvironmentLoad> {
  const decoded = decodeKey();
  if (!decoded) {
    return {
      ok: false,
      status: null,
      error: readPublishableKey()
        ? "NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY is not a valid OrbitID publishable key."
        : "NEXT_PUBLIC_ORBITID_PUBLISHABLE_KEY is not set.",
    };
  }
  const url = `${decoded.frontendApi.replace(/\/+$/, "")}/v1/client/environment`;
  try {
    const { status, body } = await fetchJson<EnvironmentJSON>(url, 5000);
    if (status < 200 || status >= 300 || !body) {
      return { ok: false, status, error: `${url} answered ${status}. The instance may still be starting.` };
    }
    return { ok: true, environment: body };
  } catch (error) {
    return { ok: false, status: null, error: fetchError(error, url) };
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** Session and MFA settings come from the Backend API and need the secret key. */
export async function loadInstanceSnapshot(): Promise<InstanceSnapshot | undefined> {
  if (!readSecretKey()) return undefined;
  try {
    const instance = asRecord(await createBackend().instance.getInstance());
    const session = asRecord(instance?.session);
    const mfa = asRecord(instance?.mfa);
    return {
      session: {
        lifetimeSeconds: typeof session?.lifetimeSeconds === "number" ? session.lifetimeSeconds : undefined,
        tokenLifetimeSeconds:
          typeof session?.tokenLifetimeSeconds === "number" ? session.tokenLifetimeSeconds : undefined,
        multiSession: typeof session?.multiSession === "boolean" ? session.multiSession : undefined,
      },
      mfa: { required: typeof mfa?.required === "boolean" ? mfa.required : undefined },
    };
  } catch {
    return undefined;
  }
}

/** Origin of the running playground, used for webhook receiver URLs and ticket links. */
export async function currentOrigin(): Promise<string> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host") ?? "localhost:3300";
  const proto = requestHeaders.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
