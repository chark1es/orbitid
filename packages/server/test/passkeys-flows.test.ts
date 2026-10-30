import { describe, expect, it } from "vitest";
import { authenticator as totp } from "otplib";
import { eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { relyingParty } from "../src/services/passkeys";
import { errorsOf, setup, signUpUser, testClient } from "./core/helpers";
import {
  APP_ORIGIN, attemptPasskey, createSignIn, enablePasskeys, newAuthenticator, preparePasskey, registerPasskey,
  sessionRow, signInWithPasskey,
} from "./passkeys-helpers";

const errorCode = async (res: Response) => errorsOf(await res.json())[0]?.code;

describe("relying party derivation", () => {
  it("uses the page origin from a trusted Origin header", async () => {
    const { ctx } = await setup();
    await ctx.settings.update({ application: { homeUrl: "https://app.example.com" } });
    expect(relyingParty(ctx, "https://app.example.com")).toEqual({ rpID: "app.example.com", origin: "https://app.example.com" });
  });

  it("drops the port from the RP ID but keeps it in the origin", async () => {
    const { ctx } = await setup({ baseUrl: "https://app.example.com:8443", encryptionKey: "k".repeat(40) });
    await ctx.settings.update({ application: { homeUrl: "https://app.example.com:8443" } });
    expect(relyingParty(ctx, "https://app.example.com:8443")).toEqual({ rpID: "app.example.com", origin: "https://app.example.com:8443" });
  });

  it("uses localhost for local development, on any port", async () => {
    const { ctx } = await setup();
    await ctx.settings.update({ application: { homeUrl: "http://localhost:3000" } });
    expect(relyingParty(ctx, "http://localhost:3000")).toEqual({ rpID: "localhost", origin: "http://localhost:3000" });
    // Development mode trusts any localhost port, so a Vite dev server on another port still works.
    expect(relyingParty(ctx, "http://localhost:5173")).toEqual({ rpID: "localhost", origin: "http://localhost:5173" });
    expect(relyingParty(ctx, "http://127.0.0.1:3000")).toEqual({ rpID: "127.0.0.1", origin: "http://127.0.0.1:3000" });
  });

  it("falls back to the configured app URL for an untrusted Origin", async () => {
    const { ctx } = await setup({ baseUrl: "https://api.example.com", nodeEnv: "production", secretKey: "sk_test_production_0123456789abcdef", encryptionKey: "k".repeat(40) });
    await ctx.settings.update({ application: { homeUrl: "https://app.example.com", developmentMode: false, allowedOrigins: [] } });
    expect(relyingParty(ctx, "https://evil.example")).toEqual({ rpID: "app.example.com", origin: "https://app.example.com" });
    expect(relyingParty(ctx, null)).toEqual({ rpID: "app.example.com", origin: "https://app.example.com" });
  });

  it("accepts a configured additional app origin", async () => {
    const { ctx } = await setup();
    await ctx.settings.update({ application: { homeUrl: "https://app.example.com", allowedOrigins: ["https://admin.example.com"] } });
    expect(relyingParty(ctx, "https://admin.example.com")).toEqual({ rpID: "admin.example.com", origin: "https://admin.example.com" });
  });

  it("ignores a malformed Origin header instead of throwing", async () => {
    const { ctx } = await setup();
    await ctx.settings.update({ application: { homeUrl: "http://localhost:3000" } });
    expect(relyingParty(ctx, "not a url")).toEqual({ rpID: "localhost", origin: "http://localhost:3000" });
  });

  it("keeps an API host distinct from the app host when the browser sends the app origin", async () => {
    const { ctx } = await setup({ baseUrl: "https://api.example.com", encryptionKey: "k".repeat(40) });
    await ctx.settings.update({ application: { homeUrl: "https://app.example.com" } });
    // The browser talks to the API cross-origin but the page (and therefore the credential) is on the app host.
    expect(relyingParty(ctx, "https://app.example.com")).toEqual({ rpID: "app.example.com", origin: "https://app.example.com" });
  });
});

describe("passkey retries within one challenge", () => {
  it("lets the user retry a failed assertion on the same challenge, up to the attempt limit", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);
    const impostor = newAuthenticator();
    impostor.credentialId = authenticator.credentialId;

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);

    const wrong = await attemptPasskey(client, created.response.id, impostor.authenticate(options));
    expect(wrong.status).toBe(400);
    // A bad signature does not burn the whole challenge: the real authenticator still works.
    const right = await attemptPasskey(client, created.response.id, authenticator.authenticate(options));
    expect(right.status).toBe(200);
    expect(((await right.json()) as { response: { status: string } }).response.status).toBe("complete");
  });

  it("stops after maxAttempts failed assertions on one challenge", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator, passkeyId } = await registerPasskey(user.client);

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);

    // A cloned/foreign key that names the real credential id fails verification each time.
    const impostor = newAuthenticator();
    impostor.credentialId = authenticator.credentialId;
    for (let i = 0; i < 5; i += 1) {
      const res = await attemptPasskey(client, created.response.id, impostor.authenticate(options));
      expect(res.status).toBe(400);
      expect(await errorCode(res)).toBe("passkey_authentication_failure");
    }
    // The sixth is refused before any crypto work.
    const exhausted = await attemptPasskey(client, created.response.id, authenticator.authenticate(options));
    expect(exhausted.status).toBe(400);
    expect(await errorCode(exhausted)).toBe("verification_expired");
    // No session was created and the counter never moved.
    expect((await ctx.db.select().from(schema.passkeys).where(eq(schema.passkeys.id, passkeyId)))[0]!.counter).toBe(0);
  });
});

describe("passkey sign-in with MFA required", () => {
  it("still asks for the second factor after a valid passkey", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);
    // Enrol TOTP so the user has a real second factor (a passkey is never a second factor)…
    const setupTotp = await user.client.json<{ response: { secret: string } }>("/v1/client/me/totp", { body: {} });
    await user.client.json("/v1/client/me/totp/attempt_verification", { body: { code: totp.generate(setupTotp.response.secret) } });
    // …then switch required MFA on.
    await ctx.settings.update({ mfa: { required: true }, attributes: { authenticatorApp: { enabled: true } } });

    const client = testClient(app);
    const { res } = await signInWithPasskey(client, authenticator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { response: { status: string; created_session_id: string | null; supported_second_factors: { strategy: string }[] } };
    expect(body.response.status).toBe("needs_second_factor");
    expect(body.response.created_session_id).toBeNull();
    expect(body.response.supported_second_factors.map((f) => f.strategy)).toContain("totp");
  });

  it("gives a pending session when required MFA has nothing enrolled yet", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);
    // The user still has no second factor; the instance now demands one.
    await ctx.settings.update({ mfa: { required: true }, attributes: { authenticatorApp: { enabled: true } } });

    const client = testClient(app);
    const { res } = await signInWithPasskey(client, authenticator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { response: { status: string; created_session_id: string } };
    expect(body.response.status).toBe("complete");
    const session = (await sessionRow(ctx, body.response.created_session_id))!;
    expect(session.status).toBe("pending");
    expect(session.authMethod).toBe("passkey");
  });

  it("keeps the passkey counter moving even when the session is only pending", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator, passkeyId } = await registerPasskey(user.client);
    await ctx.settings.update({ mfa: { required: true }, attributes: { authenticatorApp: { enabled: true } } });
    await signInWithPasskey(testClient(app), authenticator);
    const row = (await ctx.db.select().from(schema.passkeys).where(eq(schema.passkeys.id, passkeyId)))[0]!;
    expect(row.counter).toBe(1);
    expect(row.lastUsedAt).not.toBeNull();
  });
});
