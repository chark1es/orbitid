import { describe, it, expect, vi } from "vitest";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
import { sendEmail, setMailTransport, clearMailOutbox } from "../../src/services/mail";
import * as s from "../../src/db/schema";
import { errorsOf, signUpUser } from "../core/helpers";

/**
 * Nothing about a sign-in is printed.
 *
 * Operator consoles, container logs and crash reporters are read by more people, and kept longer, than any
 * database row. The requirement is that the server emits no auth diagnostics and no credential material to the
 * console on its own: not the secret key, not a rejected-key warning naming the caller, not a delivery error that
 * quotes a code or a recipient, not an uncaught error object from an auth route.
 */

const SECRET = "sk_test_silent_auth_secret_0123456789abcdef";

/** Captures every console call made while `run` executes. */
async function captureConsole<T>(run: () => Promise<T>): Promise<{ result: T; output: string }> {
  const calls: unknown[][] = [];
  const spies = (["log", "info", "warn", "error", "debug"] as const).map((level) =>
    vi.spyOn(console, level).mockImplementation((...args: unknown[]) => { calls.push(args); }),
  );
  try {
    const result = await run();
    return { result, output: calls.flat().map((value) => (typeof value === "string" ? value : JSON.stringify(value))).join("\n") };
  } finally {
    for (const spy of spies) spy.mockRestore();
  }
}

async function instance(overrides: Parameters<typeof createContext>[0] = {}) {
  const ctx = await createContext({
    databaseUrl: ":memory:",
    secretKey: SECRET,
    baseUrl: "http://localhost:4000",
    nodeEnv: "test",
    ...overrides,
  });
  clearMailOutbox();
  return { ctx, app: createApp(ctx) };
}

describe("auth requests are silent", () => {
  it("says nothing on a rejected secret key, a missing key or a dashboard key exchange", async () => {
    const { app } = await instance();
    const { output } = await captureConsole(async () => {
      // Wrong key, missing key, key in the query string, and a wrong dashboard exchange.
      await app.request("/v1/users", { headers: { authorization: `Bearer ${SECRET}_wrong` } });
      await app.request("/v1/users");
      await app.request(`/v1/users?secret_key=${SECRET}`);
      await app.request("/v1/operator_sessions", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ secret_key: "sk_test_do_not_log_me" }),
      });
    });
    expect(output).toBe("");
  });

  it("says nothing about sign-in, sign-up, codes, failed passwords or unknown accounts", async () => {
    const { app } = await instance();
    const user = await signUpUser(app, { email: "quiet@example.com" });
    const client = user.client;

    const { output } = await captureConsole(async () => {
      // A wrong password, an unknown identifier, a fresh sign-in and a revertification attempt.
      await client.request("/v1/client/sign_ins", { body: { identifier: user.email, strategy: "password", password: "wrong-password" } });
      await client.request("/v1/client/sign_ins", { body: { identifier: "nobody@example.com", strategy: "password", password: "whatever" } });
      await client.request("/v1/client/sign_ins", { body: { identifier: user.email, password: user.password } });
      await client.request(`/v1/client/sessions/${user.sessionId}/verify/prepare_first_factor`, { body: { strategy: "email_code" } });
    });
    expect(output).toBe("");
  });

  it("says nothing when an email or SMS cannot be delivered, and records a recipient-free audit entry", async () => {
    const { ctx, app } = await instance({ nodeEnv: "production", encryptionKey: "k".repeat(40), baseUrl: "https://auth.example.com" });
    // `console` is the "no provider configured" state. Delivery fails; the failure must not be narrated.
    await ctx.settings.update({ email: { provider: "console" }, sms: { provider: "console" } });

    const { output } = await captureConsole(async () => {
      await sendEmail(ctx, { to: "ada@example.com", template: "verification_code", vars: { code: "424242" } });
      // A request that reaches a send path (password reset preparation) is silent too.
      await app.request("/v1/client/sign_ins", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ identifier: "unknown@example.com", strategy: "reset_password_email_code" }),
      });
    });
    expect(output).not.toContain("424242");
    expect(output).not.toContain("ada@example.com");
    expect(output).toBe("");

    const auditRows = await ctx.db.select().from(s.auditLogs);
    const failures = auditRows.filter((row) => row.action === "email.delivery_failed");
    expect(failures.length).toBeGreaterThan(0);
    // The record names the template and the reason, never the recipient or the message body.
    expect(failures[0]!.metadata).toMatchObject({ template: "verification_code" });
    expect(JSON.stringify(failures)).not.toContain("ada@example.com");
    expect(JSON.stringify(failures)).not.toContain("424242");
  });

  it("does not dump an unexpected error object or its message", async () => {
    const { app } = await instance();
    // A route that throws an Error carrying a code-like secret in a property, as a provider or crypto failure might.
    const boom = Object.assign(new Error("provider rejected code 424242"), { code: "E_SECRET", secret: "424242" });
    (app as unknown as { get(path: string, handler: () => never): void }).get("/v1/__boom", () => { throw boom; });
    (app as unknown as { get(path: string, handler: () => never): void }).get("/v1/operator_sessions/__boom", () => { throw boom; });

    const { result, output } = await captureConsole(async () =>
      app.request("/v1/__boom", { headers: { authorization: `Bearer ${SECRET}` } }),
    );
    expect(result.status).toBe(500);
    // The response carries a trace id and the log gets a fixed diagnostic, never provider messages.
    const payload = (await result.json()) as { errors: { code: string }[]; trace_id: string };
    expect(payload.errors[0]!.code).toBe("internal_server_error");
    expect(payload.trace_id).toMatch(/^[\w-]+$/);
    expect(output).toContain("Unexpected server error");
    expect(output).not.toContain("provider rejected");
    expect(output).not.toContain("424242");
    expect(output).not.toContain("E_SECRET");
    const authFailure = await captureConsole(async () => app.request("/v1/operator_sessions/__boom", { headers: { authorization: `Bearer ${SECRET}` } }));
    expect(authFailure.result.status).toBe(500);
    expect(authFailure.output).toBe("");
  });

  it("never writes a delivered sign-in code to the console", async () => {
    const { ctx } = await instance();
    const sent: string[] = [];
    setMailTransport(async (email) => { sent.push(email.text); });
    try {
      const { output } = await captureConsole(async () => {
        await sendEmail(ctx, { to: "ada@example.com", template: "verification_code", vars: { code: "918273" } });
      });
      expect(sent.join("\n")).toContain("918273");
      expect(output).toBe("");
    } finally {
      setMailTransport(null);
    }
  });

  it("returns typed delivery failures instead of throwing into the auth flow", async () => {
    const { ctx } = await instance();
    const result = await sendEmail(ctx, { to: "ada@example.com", template: "verification_code", vars: { code: "424242" } });
    expect(result.delivered).toBe(false);
    expect(errorsOf({ errors: [{ code: result.error?.code, message: result.error?.message }] })[0]!.code).toBe("email_not_configured");
  });
});

describe("session tokens require possession", () => {
  it("refuses to mint a user's session from a secret key plus a session id, and accepts the browser path", async () => {
    const { app } = await instance();
    const user = await signUpUser(app, { email: "possess@example.com" });

    // The browser mint works: it authenticates its own __client cookie, which is the possession proof.
    const fromBrowser = await user.client.request(`/v1/client/sessions/${user.sessionId}/tokens`, { body: {} });
    expect(fromBrowser.status).toBe(200);
    const { jwt } = (await fromBrowser.json()) as { jwt: string };
    expect(jwt.split(".")).toHaveLength(3);

    // The Backend API does not: a session id and the secret key are not enough.
    const backend = await app.request(`/v1/sessions/${user.sessionId}/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(backend.status).toBe(403);
    const payload = (await backend.json()) as { errors: { code: string }[] };
    expect(payload.errors[0]!.code).toBe("not_allowed_access");

    // A server-side caller that holds the user's token can refresh it, proving possession.
    const refreshed = await app.request(`/v1/sessions/${user.sessionId}/tokens`, {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "x-orbitid-session-token": jwt },
    });
    expect(refreshed.status).toBe(200);
    expect(((await refreshed.json()) as { jwt: string }).jwt.split(".")).toHaveLength(3);
  });
});
