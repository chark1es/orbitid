import { NextResponse } from "next/server";
import { resolveApiUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "x-demo-check": "secret key required" };

/**
 * Sends one real message through the resolved transport and reports which provider it used.
 * The secret key stays on this server: the browser never sees it, and no key is echoed back.
 */
export async function POST(request: Request) {
  const secretKey = process.env.ORBITID_SECRET_KEY?.trim();
  if (!secretKey) {
    return NextResponse.json(
      {
        error: "ORBITID_SECRET_KEY is not set",
        detail: "The endpoint needs the secret key. Add it to playground/.env.local and restart the dev server.",
      },
      { status: 501, headers: HEADERS },
    );
  }

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    body = {};
  }
  const to = typeof body.to === "string" ? body.to.trim() : "";
  if (!to) {
    return NextResponse.json(
      {
        error: "to is required",
        detail: "Enter the address that should receive the test message.",
      },
      { status: 422, headers: HEADERS },
    );
  }

  const apiUrl = resolveApiUrl();
  try {
    const response = await fetch(`${apiUrl}/v1/instance/email_test`, {
      method: "POST",
      cache: "no-store",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ to }),
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
