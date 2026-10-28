import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createServer } from "node:net";
import { NextRequest } from "next/server";
import { orbitIdMiddleware } from "../../../nextjs/src/middleware";
import { startServer } from "../../src/index";
import type { AppContext } from "../../src/context";

/**
 * End-to-end: a real server on an ephemeral port and the real middleware running against it.
 * The app origin is `http://localhost:<port>`: Next normalizes `127.0.0.1` to `localhost`, and the app
 * origin must be the API's own origin (always an allowed return target) for the browser flow to work.
 */
const APP_PATH = "/dashboard";
const HOST = "localhost";

let server: Awaited<ReturnType<typeof startServer>>;
let ctx: AppContext;
let baseUrl: string;
let appUrl: string;

async function freePort(): Promise<number> {
  return await new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once("error", reject);
    probe.listen(0, HOST, () => {
      const address = probe.address();
      const port = typeof address === "object" && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}

beforeAll(async () => {
  const port = await freePort();
  baseUrl = `http://${HOST}:${port}`;
  server = await startServer({ port, databaseUrl: ":memory:", baseUrl, nodeEnv: "test" });
  ctx = server.ctx;
  appUrl = baseUrl;
  await ctx.settings.update({
    application: { homeUrl: appUrl, allowedOrigins: [appUrl], allowedRedirectOrigins: [], developmentMode: false },
  });
});

afterAll(async () => {
  await server?.close();
});

interface Browser {
  cookie: string;
}

/** Replays the browser cookie jar for requests to the API. */
async function apiCall(browser: Browser, path: string, body?: unknown): Promise<Response> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(browser.cookie ? { cookie: browser.cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: "manual",
  });
  for (const line of response.headers.getSetCookie()) {
    const pair = line.split(";")[0]!;
    if (pair.startsWith("__client=")) browser.cookie = pair;
  }
  return response;
}

/** Signs a user up over HTTP and returns the browser holding the `__client` cookie. */
async function signedUpBrowser(): Promise<Browser> {
  const email = `handshake${Math.random().toString(36).slice(2, 10)}@example.com`;
  const browser: Browser = { cookie: "" };
  const created = (await (await apiCall(browser, "/v1/client/sign_ups", {
    email_address: email,
    password: "Sup3rSecret!",
  })).json()) as { response: { id: string } };
  await apiCall(browser, `/v1/client/sign_ups/${created.response.id}/prepare_verification`, { strategy: "email_code" });
  const { latestCodeFor } = await import("../../src/services/mail");
  const code = latestCodeFor(email);
  if (!code) throw new Error("no verification code was captured");
  const verified = (await (await apiCall(browser, `/v1/client/sign_ups/${created.response.id}/attempt_verification`, {
    strategy: "email_code",
    code,
  })).json()) as { response: { status: string; created_session_id: string } };
  if (verified.response.status !== "complete") throw new Error(`sign-up did not complete: ${JSON.stringify(verified)}`);
  return browser;
}

function uat(): number {
  return Math.floor(Date.now() / 1000);
}

describe("handshake end to end (real server + middleware)", () => {
  it("restores __session for a hard navigation carrying a dead token", async () => {
    const browser = await signedUpBrowser();
    const middleware = orbitIdMiddleware({ apiUrl: baseUrl });

    // 1. Hard navigation: live `__client_uat`, dead `__session`, `__client` cookie for the API host.
    const first = await middleware(new NextRequest(`${appUrl}${APP_PATH}`, {
      headers: {
        cookie: `__session=dead.token.value; __client_uat=${uat()}; ${browser.cookie}`,
        "sec-fetch-mode": "navigate",
        accept: "text/html",
      },
    }));
    expect(first.status).toBe(307);
    const handshakeUrl = first.headers.get("location")!;
    expect(handshakeUrl.startsWith(`${baseUrl}/v1/client/handshake?redirect_url=`)).toBe(true);
    const markerCookie = first.headers.getSetCookie()
      .find((line) => line.startsWith("__orbit_handshake_pending="))!
      .split(";")[0]!;

    // 2. The API turns the client cookie into a fresh session token.
    const api = await fetch(handshakeUrl, { headers: { cookie: browser.cookie, accept: "text/html" }, redirect: "manual" });
    expect(api.status).toBe(302);
    expect(api.headers.get("cache-control")).toBe("no-store");
    expect(api.headers.get("referrer-policy")).toBe("no-referrer");
    const backToApp = new URL(api.headers.get("location")!);
    expect(backToApp.origin).toBe(appUrl);
    const handshakeToken = backToApp.searchParams.get("__orbit_handshake")!;
    expect(handshakeToken).not.toBe("signed_out");

    // 3. Back on the app: the middleware verifies the token, writes the cookies and strips the param.
    const second = await middleware(new NextRequest(backToApp.toString(), {
      headers: { cookie: `__client_uat=${uat()}; ${markerCookie}`, "sec-fetch-mode": "navigate", accept: "text/html" },
    }));
    expect(second.status).toBe(307);
    const clean = new URL(second.headers.get("location")!);
    expect(clean.origin + clean.pathname).toBe(`${appUrl}${APP_PATH}`);
    expect(clean.searchParams.has("__orbit_handshake")).toBe(false);
    const sessionCookie = second.headers.getSetCookie().find((line) => line.startsWith("__session="))!;
    expect(decodeURIComponent(sessionCookie.split(";")[0]!.slice("__session=".length))).toBe(handshakeToken);
    expect(second.headers.getSetCookie().some((line) => line.startsWith("__client_uat="))).toBe(true);

    // 4. The next navigation with the fresh cookie goes straight through, signed in.
    const third = await middleware(new NextRequest(`${appUrl}${APP_PATH}`, {
      headers: {
        cookie: `__session=${encodeURIComponent(handshakeToken)}; __client_uat=${uat()}; ${browser.cookie}`,
        "sec-fetch-mode": "navigate",
        accept: "text/html",
      },
    }));
    expect(third.status).toBe(200);
    expect(third.headers.get("x-middleware-request-x-orbitid-auth-status")).toBe("signed-in");
  });

  it("sends the browser back signed out when the client has no live session", async () => {
    const created = await fetch(`${baseUrl}/v1/client`);
    const cookie = created.headers.getSetCookie().find((line) => line.startsWith("__client="))!.split(";")[0]!;
    const api = await fetch(`${baseUrl}/v1/client/handshake?redirect_url=${encodeURIComponent(`${appUrl}${APP_PATH}`)}`, {
      headers: { cookie },
      redirect: "manual",
    });
    expect(api.status).toBe(302);
    const back = new URL(api.headers.get("location")!);
    expect(back.origin).toBe(appUrl);
    expect(back.searchParams.get("__orbit_handshake")).toBe("signed_out");
  });

  it("refuses a redirect_url on another origin", async () => {
    const response = await fetch(
      `${baseUrl}/v1/client/handshake?redirect_url=${encodeURIComponent("https://evil.example/x")}`,
      { redirect: "manual" },
    );
    expect(response.status).toBe(400);
    expect(response.headers.get("location")).toBeNull();
  });
});
