import { NextResponse } from "next/server";
import { resolveApiUrl } from "@/lib/env";

export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store", "x-demo-check": "redirect rules" };

/**
 * The handshake answers with a 302, so this handler reports the redirect instead of following it.
 * `redirect_url` is validated by the instance (its own origin, the home URL or an allowed origin).
 */
export async function GET(request: Request) {
  const apiUrl = resolveApiUrl();
  const origin = new URL(request.url).origin;
  const target = `${apiUrl}/v1/client/handshake?redirect_url=${encodeURIComponent(origin)}`;
  try {
    const response = await fetch(target, {
      redirect: "manual",
      cache: "no-store",
      headers: { Accept: "application/json" },
    });
    const location = response.headers.get("location");
    let outcome = "no redirect";
    if (location) {
      const parsed = new URL(location, target);
      const token = parsed.searchParams.get("__orbit_handshake");
      outcome = token === "signed_out" ? "signed out" : token ? "token minted" : "redirect without a token parameter";
    }
    return NextResponse.json(
      {
        endpoint: "handshake",
        request: `${apiUrl}/v1/client/handshake`,
        redirectUrl: origin,
        status: response.status,
        location: location ?? null,
        outcome,
        detail:
          response.status === 302
            ? outcome === "token minted"
              ? "The instance minted a session token for the live client cookie on this API host."
              : "No live __client cookie reached the instance from this handler, so it answered signed_out."
            : "A 400 means redirect_url was rejected: use the instance origin, its home URL or an allowed origin.",
        cacheControl: response.headers.get("cache-control"),
        referrerPolicy: response.headers.get("referrer-policy"),
      },
      { status: 200, headers: HEADERS },
    );
  } catch (error) {
    return NextResponse.json(
      {
        endpoint: "handshake",
        error: error instanceof Error ? error.message : "The request could not be made.",
        detail: "Start the OrbitID server or set ORBITID_API_URL.",
      },
      { status: 502, headers: HEADERS },
    );
  }
}
