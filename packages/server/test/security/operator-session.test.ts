import { describe, expect, it } from "vitest";
import { COOKIES } from "@orbitid/shared";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import { operatorCookieOriginAllowed, keyFingerprint, OPERATOR_SESSION_TTL_MS } from "../../src/services/operator-session";
import { safeEqual } from "../../src/lib/crypto";

const SECRET = "sk_test_operator_session_secret";
const BASE = "http://localhost:4000";

async function boot(overrides: { baseUrl?: string; secretKey?: string } = {}) {
  const ctx = await createContext({
    databaseUrl: ":memory:",
    secretKey: overrides.secretKey ?? SECRET,
    baseUrl: overrides.baseUrl ?? BASE,
    encryptionKey: "d".repeat(40),
  });
  const app = createApp(ctx);
  return { ctx, app };
}

/** Extracts the `__orbit_operator` cookie pair and its attributes from a response. */
function operatorCookie(res: Response) {
  const raw = res.headers.getSetCookie().find((value) => value.startsWith(`${COOKIES.operator}=`));
  if (!raw) throw new Error("response did not set the operator cookie");
  const [pair, ...attributes] = raw.split(";").map((part) => part.trim());
  return { pair: pair!, attributes, raw };
}

async function signIn(app: ReturnType<typeof createApp>, secretKey = SECRET) {
  const res = await app.request("/v1/operator_sessions", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ secret_key: secretKey }),
  });
  return { res, cookie: res.status === 201 ? operatorCookie(res).pair : "" };
}

describe("dashboard operator session: key exchange", () => {
  it("exchanges the secret key for an httpOnly, SameSite=Strict, /v1-scoped cookie and never returns the key", async () => {
    const { app } = await boot();
    const { res, cookie } = await signIn(app);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.object).toBe("operator_session");
    expect(body.id).toMatch(/^osess_/);
    expect(Math.abs(body.expires_at - (Date.now() + OPERATOR_SESSION_TTL_MS))).toBeLessThan(5_000);
    const text = JSON.stringify(body);
    expect(text).not.toContain(SECRET);
    expect(Object.keys(body).sort()).toEqual(["expires_at", "id", "object"]);

    const { attributes } = operatorCookie(res);
    const lower = attributes.map((value) => value.toLowerCase());
    expect(lower).toContain("httponly");
    expect(lower).toContain("samesite=strict");
    expect(lower).toContain("path=/v1");
    // http, locally: Secure would make the browser drop the cookie on localhost's http origin.
    expect(lower.some((value) => value.startsWith("secure"))).toBe(false);
    expect(cookie).toMatch(/^__orbit_operator=/);
  });

  it("adds Secure when the instance is served over https", async () => {
    const { app } = await boot({ baseUrl: "https://auth.example.com" });
    const { res } = await signIn(app);
    const lower = operatorCookie(res).attributes.map((value) => value.toLowerCase());
    expect(lower.some((value) => value === "secure")).toBe(true);
  });

  it("refuses the wrong key and does not set a cookie", async () => {
    const { app } = await boot();
    const res = await app.request("/v1/operator_sessions", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ secret_key: "sk_test_not_the_key" }),
    });
    expect(res.status).toBe(401);
    expect((await res.json()).errors[0].code).toBe("secret_key_invalid");
    expect(res.headers.getSetCookie().some((value) => value.startsWith(`${COOKIES.operator}=`))).toBe(false);
  });

  it("rate limits failed exchanges per address and still lets the right key through", async () => {
    const { app } = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) {
      statuses.push(
        (await app.request("/v1/operator_sessions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret_key: `sk_test_wrong_${i}` }),
        })).status,
      );
    }
    expect(statuses.filter((status) => status === 401).length).toBeGreaterThan(0);
    expect(statuses).toContain(429);
    // The lockout is per address, not a lock on the instance: the correct key still signs in.
    expect((await signIn(app)).res.status).toBe(201);
  });

  it("never logs the presented key", async () => {
    const { app } = await boot();
    const seen: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => { seen.push(args.map(String).join(" ")); };
    try {
      await app.request("/v1/operator_sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret_key: "sk_test_do_not_log_me" }),
      });
    } finally {
      console.warn = original;
    }
    expect(seen.join("\n")).not.toContain("sk_test_do_not_log_me");
  });

  it("refuses a cross-origin exchange and a literal Origin: null", async () => {
    const { app } = await boot();
    for (const origin of ["https://evil.example", "null"]) {
      const res = await app.request("/v1/operator_sessions", {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ secret_key: SECRET }),
      });
      expect(res.status, origin).toBe(403);
      expect(res.headers.getSetCookie()).toEqual([]);
    }
  });

  it("accepts an exchange from this instance's own origin", async () => {
    const { app } = await boot();
    const res = await app.request("/v1/operator_sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: BASE, "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ secret_key: SECRET }),
    });
    expect(res.status).toBe(201);
  });

  it("refuses a development server on another port, so the Vite proxy must rewrite the origin", async () => {
    // `apps/dashboard/vite.config.ts` proxies /v1 and rewrites Origin to the API target. Without that, the
    // browser's own 5173 origin is not this instance and must be refused — locally as well as in production.
    const { app } = await boot();
    const res = await app.request("/v1/operator_sessions", {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://localhost:5173", "sec-fetch-site": "same-origin" },
      body: JSON.stringify({ secret_key: SECRET }),
    });
    expect(res.status).toBe(403);
    expect(res.headers.getSetCookie()).toEqual([]);
  });
});

describe("dashboard operator session: Backend API access", () => {
  it("accepts the cookie for reads and writes on this origin", async () => {
    const { app } = await boot();
    const { cookie } = await signIn(app);

    const read = await app.request("/v1/instance", { headers: { cookie } });
    expect(read.status).toBe(200);
    expect((await read.json()).publishable_key).toMatch(/^pk_test_/);

    const write = await app.request("/v1/users", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ email_address: ["cookie-user@example.com"], password: "Sup3r-secret!" }),
    });
    expect(write.status).toBe(200);
  });

  it("keeps the bearer secret key working unchanged", async () => {
    const { app } = await boot();
    const res = await app.request("/v1/instance", { headers: { authorization: `Bearer ${SECRET}` } });
    expect(res.status).toBe(200);
  });

  it("applies the same origin rule to the session check and the sign-out", async () => {
    const { app } = await boot();
    const { cookie } = await signIn(app);
    for (const path of ["/v1/operator_sessions/current"]) {
      expect((await app.request(path, { headers: { cookie, origin: "https://evil.example" } })).status, path).toBe(403);
      const deleted = await app.request(path, { method: "DELETE", headers: { cookie, origin: "https://evil.example" } });
      expect(deleted.status, path).toBe(403);
    }
    // The session is untouched by the refused requests.
    expect((await app.request("/v1/instance", { headers: { cookie } })).status).toBe(200);
  });

  it("refuses the cookie with no session, an unknown token, or a malformed one", async () => {
    const { app } = await boot();
    for (const cookie of [`${COOKIES.operator}=`, `${COOKIES.operator}=not-a-real-token`]) {
      const res = await app.request("/v1/instance", { headers: { cookie } });
      expect(res.status, cookie).toBe(401);
    }
  });

  it("refuses the cookie on a state-changing request from another origin", async () => {
    const { app } = await boot();
    const { cookie } = await signIn(app);
    const res = await app.request("/v1/settings", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ application: { name: "Owned" } }),
    });
    // The CSRF guard refuses it before the route (or its 404) is reached.
    expect(res.status).toBe(403);
  });

  it("treats a literal Origin: null as a refused origin for writes and reads", async () => {
    const { app } = await boot();
    const { cookie } = await signIn(app);
    const write = await app.request("/v1/instance", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", origin: "null" },
      body: JSON.stringify({ application: { name: "Owned" } }),
    });
    expect(write.status).toBe(403);
    const read = await app.request("/v1/instance", { headers: { cookie, origin: "null" } });
    expect(read.status).toBe(403);
  });

  it("never falls back to a trusted Referer when an explicit Origin was refused", async () => {
    const { app } = await boot();
    const { cookie } = await signIn(app);
    const res = await app.request("/v1/instance", {
      headers: { cookie, origin: "https://evil.example", referer: `${BASE}/users` },
    });
    expect(res.status).toBe(403);
  });

  it("refuses the cookie on a state-changing request flagged as cross-site", async () => {
    const { app } = await boot();
    const { cookie } = await signIn(app);
    const res = await app.request("/v1/instance", {
      method: "PATCH",
      headers: { cookie, "content-type": "application/json", "sec-fetch-site": "cross-site" },
      body: JSON.stringify({ application: { name: "Owned" } }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses the cookie when it is presented as a cross-site read", async () => {
    const { app } = await boot();
    const { cookie } = await signIn(app);
    const res = await app.request("/v1/users", {
      headers: { cookie, "sec-fetch-site": "cross-site" },
    });
    expect(res.status).toBe(403);
  });

  it("does not accept the dashboard cookie on a different origin", async () => {
    const { app } = await boot({ baseUrl: "https://auth.example.com" });
    const { cookie } = await signIn(app);
    const res = await app.request("/v1/instance", {
      headers: { cookie, origin: "https://dashboard.other.example" },
    });
    expect(res.status).toBe(403);
  });

  it("refuses the secret key in the query string even with a valid session", async () => {
    const { app } = await boot();
    const { cookie } = await signIn(app);
    const res = await app.request(`/v1/instance?secret_key=${SECRET}`, { headers: { cookie } });
    expect(res.status).toBe(401);
  });
});

describe("dashboard operator session: expiry and revocation", () => {
  it("reports the current session and its expiry", async () => {
    const { app } = await boot();
    const { cookie } = await signIn(app);
    const res = await app.request("/v1/operator_sessions/current", { headers: { cookie } });
    expect(res.status).toBe(200);
    expect((await res.json()).object).toBe("operator_session");
  });

  it("signs out by revoking the row and clearing the cookie", async () => {
    const { app } = await boot();
    const { cookie } = await signIn(app);

    const out = await app.request("/v1/operator_sessions/current", { method: "DELETE", headers: { cookie } });
    expect(out.status).toBe(204);
    const cleared = out.headers.getSetCookie().find((value) => value.startsWith(`${COOKIES.operator}=`))!;
    expect(cleared).toMatch(/Max-Age=0|Expires=Thu, 01 Jan 1970/i);

    // Replaying the old token fails even though it was valid a moment ago.
    expect((await app.request("/v1/instance", { headers: { cookie } })).status).toBe(401);
  });

  it("refuses an expired session", async () => {
    const { app, ctx } = await boot();
    const { cookie } = await signIn(app);
    const { operatorSessions } = await import("../../src/db/schema");
    await ctx.db.update(operatorSessions).set({ expiresAt: Date.now() - 1 });
    expect((await app.request("/v1/instance", { headers: { cookie } })).status).toBe(401);
  });

  it("ends every session when the secret key is rotated", async () => {
    const { app, ctx } = await boot();
    const { cookie } = await signIn(app);
    expect((await app.request("/v1/instance", { headers: { cookie } })).status).toBe(200);

    // A new context with the same database but a different key is what a restart after rotation looks like.
    const rotated = createApp({ ...ctx, env: { ...ctx.env, secretKey: "sk_test_rotated_key" } });
    expect((await rotated.request("/v1/instance", { headers: { cookie } })).status).toBe(401);
    expect((await rotated.request("/v1/instance", { headers: { authorization: "Bearer sk_test_rotated_key" } })).status).toBe(200);
  });

  it("does not survive a database transfer, because logins are not part of an export", async () => {
    // `orbitid export` skips `operator_sessions` (see services/transfer.ts), which is what an import into a
    // new database looks like: same secret key, no session rows. A cookie from the source must not work.
    const source = await boot();
    const target = await boot();
    const { cookie } = await signIn(source.app);
    expect((await source.app.request("/v1/instance", { headers: { cookie } })).status).toBe(200);
    expect((await target.app.request("/v1/instance", { headers: { cookie } })).status).toBe(401);
    const { SKIPPED_TABLES } = await import("../../src/services/transfer");
    expect(SKIPPED_TABLES.has("operatorSessions")).toBe(true);
  });

  it("stores only a hash of the session token", async () => {
    const { app, ctx } = await boot();
    const { cookie } = await signIn(app);
    const token = cookie.slice(`${COOKIES.operator}=`.length);
    const rows = await ctx.db.select().from((await import("../../src/db/schema")).operatorSessions);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]!.keyFingerprint).toBe(keyFingerprint(SECRET));
  });
});

describe("operator cookie origin helper", () => {
  const req = (headers: Record<string, string>) => ({ req: { header: (name: string) => headers[name.toLowerCase()] } });
  const ctx = { env: { baseUrl: BASE }, settings: { get: () => ({ application: { developmentMode: true } }) } } as never;

  it("allows same-origin requests and no-header requests, refuses cross-site ones", () => {
    expect(operatorCookieOriginAllowed(ctx, req({ origin: BASE }))).toBe(true);
    expect(operatorCookieOriginAllowed(ctx, req({ "sec-fetch-site": "same-origin" }))).toBe(true);
    expect(operatorCookieOriginAllowed(ctx, req({}))).toBe(true);
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "https://evil.example" }))).toBe(false);
    expect(operatorCookieOriginAllowed(ctx, req({ "sec-fetch-site": "cross-site", origin: BASE }))).toBe(false);
    expect(operatorCookieOriginAllowed(ctx, req({ referer: "https://evil.example/page" }))).toBe(false);
  });

  it("treats an explicit Origin as authoritative, even when it is null or malformed", () => {
    // `Origin: null` comes from sandboxed frames and some redirects. It is never this instance.
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "null" }))).toBe(false);
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "" }))).toBe(false);
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "not a url" }))).toBe(false);
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "http://localhost:4000.example" }))).toBe(false);
    // A trusted Referer never overrides an explicit, rejected Origin.
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "https://evil.example", referer: `${BASE}/users` }))).toBe(false);
    // A rejected Origin is refused even without fetch metadata.
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "https://evil.example", "sec-fetch-site": "same-origin" }))).toBe(false);
  });

  it("matches the scheme and port, not just the host", () => {
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "https://localhost:4000" }))).toBe(false);
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "http://localhost:4001" }))).toBe(false);
  });

  it("does not treat an arbitrary loopback origin as the dashboard, in development or production", () => {
    // The Vite dev server is a separate origin; the supported development setup proxies the API so the
    // browser's Origin is this server's origin. A bare localhost origin is never trusted.
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "http://localhost:5173" }))).toBe(false);
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "http://127.0.0.1:5173" }))).toBe(false);
    const production = { env: { baseUrl: BASE }, settings: { get: () => ({ application: { developmentMode: false } }) } } as never;
    expect(operatorCookieOriginAllowed(production, req({ origin: "http://localhost:5173" }))).toBe(false);
  });

  it("does not let an allowed application origin use the operator cookie", () => {
    // `settings.application.allowedOrigins` governs CORS for the Frontend API; the operator cookie is
    // stricter and stays on this server's own origin.
    expect(operatorCookieOriginAllowed(ctx, req({ origin: "http://localhost:3000" }))).toBe(false);
  });
});

describe("constant-time key comparison", () => {
  it("uses safeEqual for the exchange, like the bearer gate", async () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
  });
});
