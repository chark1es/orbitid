import { NextResponse } from "next/server";
import { resolveApiUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "x-demo-check": "OIDC discovery + device grant" };

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * Reads the discovery document and probes the device grant. Probing uses a made-up client id on purpose:
 * while the grant is off the endpoint answers 404, and while it is on the answer is a client error —
 * so the status tells you which, without needing a secret key or creating anything.
 */
export async function GET() {
  const apiUrl = resolveApiUrl();
  try {
    const discoveryResponse = await fetch(`${apiUrl}/.well-known/openid-configuration`, {
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const discovery = asRecord(await discoveryResponse.json().catch(() => null));

    const probe = await fetch(`${apiUrl}/oauth/device_authorization`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: "oa_probe", scope: "openid" }).toString(),
    });
    const probeBody = asRecord(await probe.json().catch(() => null));

    return NextResponse.json(
      {
        endpoint: "device",
        apiUrl,
        discovery: {
          status: discoveryResponse.status,
          issuer: discovery?.issuer ?? null,
          deviceAuthorizationEndpoint: discovery?.device_authorization_endpoint ?? null,
          tokenEndpoint: discovery?.token_endpoint ?? null,
        },
        grant: {
          // 404 means the grant is off; anything else means the route exists and rejected the probe.
          enabled: probe.status !== 404,
          probeStatus: probe.status,
          probeError: probeBody?.error ?? null,
        },
        calls: {
          authorization: `POST ${apiUrl}/oauth/device_authorization  (client_id, scope)`,
          token: `POST ${apiUrl}/oauth/token  (grant_type=urn:ietf:params:oauth:grant-type:device_code, device_code, client_id)`,
          verification: `GET ${apiUrl}/oauth/device?user_code=…`,
        },
        detail:
          probe.status === 404
            ? "The device grant is off: turn it on under OAuth apps in the dashboard. The endpoints answer 404 while it is off."
            : "The grant is on. Use the Device flow page to start a real request, which needs an application's client id.",
      },
      { headers: HEADERS },
    );
  } catch (error) {
    return NextResponse.json(
      {
        endpoint: "device",
        apiUrl,
        error: error instanceof Error ? error.message : "The request could not be made.",
        detail: "Start the OrbitID server or set ORBITID_API_URL.",
      },
      { status: 502, headers: HEADERS },
    );
  }
}

/**
 * Starts a real device authorization for a client id you supply, so the API lab can show the raw response.
 * The device code is returned here on purpose: this is a test console, not an application.
 */
export async function POST(request: Request) {
  const apiUrl = resolveApiUrl();
  let body: Record<string, unknown> = {};
  try {
    body = asRecord(await request.json()) ?? {};
  } catch {
    body = {};
  }
  const clientId = typeof body.client_id === "string" ? body.client_id.trim() : "";
  const scope = typeof body.scope === "string" && body.scope.trim() ? body.scope.trim() : "openid profile email";
  if (!clientId) {
    return NextResponse.json(
      {
        error: "client_id is required",
        detail: "Register an application on the Device flow page, or paste a client_id from the dashboard.",
      },
      { status: 422, headers: HEADERS },
    );
  }
  try {
    const response = await fetch(`${apiUrl}/oauth/device_authorization`, {
      method: "POST",
      cache: "no-store",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({ client_id: clientId, scope }).toString(),
    });
    const payload = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return NextResponse.json(payload ?? { error: "empty response" }, {
      status: response.status,
      headers: HEADERS,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error: error instanceof Error ? error.message : "The request could not be made.",
        detail: "Start the OrbitID server or set ORBITID_API_URL.",
      },
      { status: 502, headers: HEADERS },
    );
  }
}
