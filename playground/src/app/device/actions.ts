"use server";

import { revalidatePath } from "next/cache";
import type { ActionResult } from "@/lib/action-state";
import { describeError } from "@/lib/errors";
import { createBackend, currentOrigin, readSecretKey, resolveApiUrl } from "@/lib/env";
import {
  clearDeviceFlow,
  getDeviceFlow,
  parseDeviceAuthorization,
  readPollOutcome,
  recordDevicePoll,
  rememberDeviceFlow,
  type DeviceFlowRecord,
} from "@/lib/device-flow";

const NO_SECRET: ActionResult = {
  ok: false,
  message: "ORBITID_SECRET_KEY is not set.",
  detail: "Add it to playground/.env.local, restart the dev server, then reload this page.",
};

export interface DeviceApplicationSummary {
  id: string;
  name: string;
  clientId: string;
  public: boolean;
  scopes: string;
}

/** Device-flow tries are the only calls that need an application, so they need the secret key too. */
export async function listDeviceApplications(): Promise<{
  ok: boolean;
  applications: DeviceApplicationSummary[];
  error?: string;
}> {
  if (!readSecretKey()) {
    return { ok: false, applications: [], error: "ORBITID_SECRET_KEY is not set." };
  }
  try {
    const result = await createBackend().oauthApplications.getOAuthApplicationList({ limit: 100 });
    return {
      ok: true,
      applications: result.data.map((application) => ({
        id: application.id,
        name: application.name,
        clientId: application.clientId,
        public: application.public,
        scopes: application.scopes,
      })),
    };
  } catch (error) {
    return { ok: false, applications: [], error: describeError(error) };
  }
}

/**
 * Registers a public application for this site and returns its client id. Public means no secret, and the
 * device grant does not use PKCE, so the browser can poll with client_id alone.
 */
export async function createDeviceApplication(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  if (!readSecretKey()) return NO_SECRET;
  const name = String(formData.get("name") ?? "").trim() || "Playground device flow";
  try {
    const application = await createBackend().oauthApplications.createOAuthApplication({
      name,
      redirectUris: [`${await currentOrigin()}/device`],
      scopes: "openid profile email offline_access",
      public: true,
      consentScreenEnabled: true,
      pkceRequired: false,
    });
    revalidatePath("/device");
    return {
      ok: true,
      message: `Created application ${application.name}.`,
      detail: `client_id ${application.clientId}. It is a public client, so it has no secret.`,
    };
  } catch (error) {
    return { ok: false, message: describeError(error), detail: "Check the server log and the secret key." };
  }
}

/**
 * Starts the grant from the server: `POST /oauth/device_authorization` with the application's client id.
 * The device code stays in dev-server memory; only the user code and the link go to the page.
 */
export async function startDeviceFlow(_previous: ActionResult, formData: FormData): Promise<ActionResult> {
  const clientId = String(formData.get("clientId") ?? "").trim();
  const applicationId = String(formData.get("applicationId") ?? "").trim();
  const applicationName = String(formData.get("applicationName") ?? "").trim() || "Device flow";
  const scopes = String(formData.get("scopes") ?? "").trim() || "openid profile email";
  if (!clientId) {
    return {
      ok: false,
      message: "Choose an application first.",
      detail: "Register one below, or pick an existing public application from the list.",
    };
  }

  const url = `${resolveApiUrl()}/oauth/device_authorization`;
  try {
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, scope: scopes }).toString(),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    if (!response.ok) {
      const error = (body as { error?: string; error_description?: string } | null) ?? null;
      if (response.status === 404) {
        return {
          ok: false,
          message: "The device grant is off on this instance.",
          detail: "Turn on the device authorization grant in the dashboard under OAuth apps, then reload.",
        };
      }
      return {
        ok: false,
        message: `${response.status}: ${error?.error_description ?? error?.error ?? "The request was rejected."}`,
        detail: "Check that the application exists and that the scopes are allowed on it.",
      };
    }
    const parsed = parseDeviceAuthorization(body);
    if (!parsed) {
      return {
        ok: false,
        message: "The instance answered without a device code.",
        detail: `${url} returned an unexpected body.`,
      };
    }
    const flow: DeviceFlowRecord = {
      ...parsed,
      applicationId,
      clientId,
      applicationName,
      scopes,
      startedAt: Date.now(),
      polls: [],
    };
    rememberDeviceFlow(flow);
    revalidatePath("/device");
    return {
      ok: true,
      message: `Code ${parsed.userCode} for ${applicationName}.`,
      detail: `Open ${parsed.verificationUriComplete} and approve it. The code expires in ${parsed.expiresIn} seconds.`,
      href: parsed.verificationUriComplete,
    };
  } catch (error) {
    return { ok: false, message: describeError(error), detail: "Check that the OrbitID server is running." };
  }
}

/**
 * One poll of `POST /oauth/token` with `grant_type=urn:ietf:params:oauth:grant-type:device_code`.
 * Every answer is recorded so the page can show pending, slow_down, denial and the final token set.
 */
export async function pollDeviceFlow(_previous: ActionResult, _formData: FormData): Promise<ActionResult> {
  const flow = getDeviceFlow();
  if (!flow) {
    return {
      ok: false,
      message: "No device request is in progress.",
      detail: "Start one above; the device code lives in dev-server memory and is lost on restart.",
    };
  }
  const url = `${resolveApiUrl()}/oauth/token`;
  try {
    const response = await fetch(url, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        device_code: flow.deviceCode,
        client_id: flow.clientId,
      }).toString(),
    });
    const text = await response.text();
    let body: unknown = null;
    try {
      body = JSON.parse(text);
    } catch {
      body = null;
    }
    const outcome = readPollOutcome(response.status, body);
    recordDevicePoll({ at: Date.now(), state: outcome.state, message: outcome.message });
    revalidatePath("/device");

    if (outcome.state === "complete") {
      const tokens = outcome.tokens;
      const lines = [
        tokens?.expiresIn !== null && tokens?.expiresIn !== undefined ? `Expires in ${tokens.expiresIn} seconds.` : null,
        tokens?.scope ? `Scope ${tokens.scope}.` : null,
        tokens?.hasRefreshToken ? "A refresh token came with it." : null,
        tokens?.hasIdToken ? "An ID token came with it." : null,
      ].filter(Boolean);
      return {
        ok: true,
        message: "Approved. The device received a token set.",
        detail: lines.join(" "),
        // The access token is shown once on this page so it can be pasted into /oauth/userinfo.
        secret: tokens?.accessToken ?? undefined,
      };
    }
    return {
      ok: outcome.state === "pending" || outcome.state === "slow-down",
      message: outcome.message,
      detail:
        outcome.state === "pending"
          ? "Approve the code at the verification page, then poll again."
          : outcome.state === "slow-down"
            ? `Wait ${outcome.retryAfterSeconds ?? flow.interval} seconds before polling again.`
            : "Start a new request to try again.",
    };
  } catch (error) {
    return { ok: false, message: describeError(error), detail: "Check that the OrbitID server is running." };
  }
}

export async function resetDeviceFlow(_previous: ActionResult, _formData: FormData): Promise<ActionResult> {
  clearDeviceFlow();
  revalidatePath("/device");
  return { ok: true, message: "Cleared the device request from this dev server." };
}
