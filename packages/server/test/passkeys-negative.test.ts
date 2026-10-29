import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { PublicKeyCredentialCreationOptionsJSON } from "@simplewebauthn/server";
import * as schema from "../src/db/schema";
import { first } from "../src/lib/db";
import { errorsOf, setup, signUpUser, testClient } from "./core/helpers";
import {
  APP_ORIGIN, attemptPasskey, createSignIn, enablePasskeys, newAuthenticator, passkeyRow, preparePasskey, registerPasskey,
  signInWithPasskey,
} from "./passkeys-helpers";

const errorCode = async (res: Response) => errorsOf(await res.json())[0]?.code;

describe("passkey sign-in negative cases", () => {
  it("rejects an assertion produced for another origin", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    const assertion = authenticator.authenticate(options, { origin: "https://evil.example" });
    const res = await attemptPasskey(client, created.response.id, assertion);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("passkey_authentication_failure");
  });

  it("rejects an assertion whose rpIdHash is a different relying party", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    const assertion = authenticator.authenticate(options, { rpID: "evil.example" });
    const res = await attemptPasskey(client, created.response.id, assertion);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("passkey_authentication_failure");
  });

  it("rejects a tampered clientData challenge", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    const assertion = authenticator.authenticate(options);
    // Re-encode clientDataJSON with a challenge the server never issued (signature now stale too).
    const clientData = JSON.parse(Buffer.from(assertion.response.clientDataJSON, "base64url").toString());
    clientData.challenge = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
    assertion.response.clientDataJSON = Buffer.from(JSON.stringify(clientData)).toString("base64url");
    const res = await attemptPasskey(client, created.response.id, assertion);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("passkey_authentication_failure");
  });

  it("rejects a replayed assertion: the same challenge cannot complete two sign-ins", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    const assertion = authenticator.authenticate(options);

    const first = await attemptPasskey(client, created.response.id, assertion);
    expect(first.status).toBe(200);
    // The attempt is complete, so a replay cannot touch it again.
    const replay = await attemptPasskey(client, created.response.id, assertion);
    expect(replay.status).toBe(400);
    expect(await errorCode(replay)).toBe("client_state_invalid");
  });

  it("only lets one of two concurrent uses of the same assertion create a session", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    const assertion = authenticator.authenticate(options);

    const [a, b] = await Promise.all([
      attemptPasskey(client, created.response.id, assertion),
      attemptPasskey(client, created.response.id, assertion),
    ]);
    const issued = [a, b].filter((res) => res.status === 200);
    expect(issued).toHaveLength(1);
    // One assertion must never produce two sessions for the user.
    const sessions = await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.userId, user.userId));
    expect(sessions.filter((s) => s.authMethod === "passkey")).toHaveLength(1);
  });

  it("only lets one of two concurrent registrations spend the same challenge", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const begin = await user.client.json<{ response: { id: string; public_key_credential_creation_options: never } }>(
      "/v1/client/me/passkeys", { body: {}, headers: { origin: APP_ORIGIN } },
    );
    const credential = newAuthenticator().register(begin.response.public_key_credential_creation_options);
    const send = () => user.client.request(`/v1/client/me/passkeys/${begin.response.id}/attempt_verification`, {
      body: { public_key_credential: credential }, headers: { origin: APP_ORIGIN },
    });
    const [a, b] = await Promise.all([send(), send()]);
    expect([a.status, b.status].filter((status) => status === 200)).toHaveLength(1);
    const loser = a.status === 200 ? b : a;
    expect(await errorCode(loser)).toBe("verification_expired");
    const rows = await ctx.db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, user.userId));
    expect(rows).toHaveLength(1);
  });

  it("verifies a registration against the origin the ceremony started on", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    // A second origin the instance trusts, e.g. a whitelabel front end.
    await ctx.settings.update({ application: { allowedOrigins: ["https://other.example"] } });
    const user = await signUpUser(app);

    const begin = await user.client.json<{ response: { id: string; public_key_credential_creation_options: never } }>(
      "/v1/client/me/passkeys", { body: {}, headers: { origin: APP_ORIGIN } },
    );
    // The attestation claims another origin entirely and the follow-up request says so too.
    const credential = newAuthenticator().register(begin.response.public_key_credential_creation_options, {
      origin: "https://other.example", rpID: "other.example",
    });
    const res = await user.client.request(`/v1/client/me/passkeys/${begin.response.id}/attempt_verification`, {
      body: { public_key_credential: credential }, headers: { origin: "https://other.example" },
    });
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("passkey_registration_failure");
    expect(await ctx.db.select().from(schema.passkeys).where(eq(schema.passkeys.userId, user.userId))).toHaveLength(0);
  });

  it("verifies an assertion against the origin the ceremony started on", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    await ctx.settings.update({ application: { allowedOrigins: ["https://other.example"] } });
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    // Signed for another trusted origin, and presented as if the request came from there.
    const assertion = authenticator.authenticate(options, { origin: "https://other.example", rpID: "other.example" });
    const res = await attemptPasskey(client, created.response.id, assertion, "https://other.example");
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("passkey_authentication_failure");
  });

  it("rejects a counter regression from a cloned authenticator", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator, passkeyId } = await registerPasskey(user.client);

    const first = await signInWithPasskey(testClient(app), authenticator);
    expect(first.res.status).toBe(200);
    expect((await passkeyRow(ctx, passkeyId))!.counter).toBe(1);

    // The clone replays an older counter with a fresh challenge.
    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    const cloneAssertion = authenticator.authenticate(options, { counter: 1 });
    const res = await attemptPasskey(client, created.response.id, cloneAssertion);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("passkey_authentication_failure");
    expect((await passkeyRow(ctx, passkeyId))!.counter).toBe(1);
  });

  it("rejects an assertion signed by a different key for the same credential id", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);
    const impostor = newAuthenticator();
    impostor.credentialId = authenticator.credentialId;

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    const forged = impostor.authenticate(options);
    const res = await attemptPasskey(client, created.response.id, forged);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("passkey_authentication_failure");
  });

  it("refuses an assertion for another account's credential in an identifier-first sign-in", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const alice = await signUpUser(app);
    const bob = await signUpUser(app);
    await registerPasskey(alice.client);
    const { authenticator: bobAuthenticator } = await registerPasskey(bob.client);

    const client = testClient(app);
    const created = await createSignIn(client, { identifier: alice.email, strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    // Alice's request options list only Alice's credentials; Bob's authenticator signs anyway.
    const assertion = bobAuthenticator.authenticate(options, { credentialId: bobAuthenticator.credentialId });
    const res = await attemptPasskey(client, created.response.id, assertion);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("passkey_authentication_failure");
  });

  it("requires the user-verification flag on registration and sign-in", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);

    // Registration without UV is refused.
    const authenticator = newAuthenticator({ userVerification: false });
    const begin = await user.client.json<{ response: { id: string; public_key_credential_creation_options: never } }>(
      "/v1/client/me/passkeys", { body: {}, headers: { origin: "http://localhost:3000" } },
    );
    const credential = authenticator.register(begin.response.public_key_credential_creation_options);
    const registration = await user.client.request(`/v1/client/me/passkeys/${begin.response.id}/attempt_verification`, {
      body: { public_key_credential: credential }, headers: { origin: "http://localhost:3000" },
    });
    expect(registration.status).toBe(400);
    expect(await errorCode(registration)).toBe("passkey_registration_failure");

    // An authenticator that stops reporting UV at assertion time is refused too.
    const uvAuthenticator = newAuthenticator();
    await registerPasskey(user.client, { authenticator: uvAuthenticator });
    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    const res = await attemptPasskey(client, created.response.id, uvAuthenticator.authenticate(options, { userVerified: false }));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("passkey_authentication_failure");
  });

  it("rejects an expired challenge", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    const assertion = authenticator.authenticate(options);
    await ctx.db.update(schema.verifications).set({ expiresAt: Date.now() - 1 })
      .where(and(eq(schema.verifications.purpose, "passkey_authentication"), eq(schema.verifications.ownerId, created.response.id)));

    const res = await attemptPasskey(client, created.response.id, assertion);
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("verification_expired");
  });

  it("rejects a challenge issued for a different sign-in attempt", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    const client = testClient(app);
    const first = await createSignIn(client, { strategy: "passkey" });
    const { options: firstOptions } = await preparePasskey(client, first.response.id);
    // Starting a new sign-in abandons the old one, but the old challenge must not satisfy the new attempt.
    const second = await createSignIn(client, { strategy: "passkey" });
    const { options: secondOptions } = await preparePasskey(client, second.response.id);
    const assertion = authenticator.authenticate(firstOptions);
    const res = await attemptPasskey(client, second.response.id, assertion);
    expect(res.status).toBe(400);
    void secondOptions;
  });

  it("refuses to register the same credential id twice", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    const begin = await user.client.json<{ response: { id: string; public_key_credential_creation_options: never } }>(
      "/v1/client/me/passkeys", { body: {}, headers: { origin: "http://localhost:3000" } },
    );
    const duplicate = authenticator.register(begin.response.public_key_credential_creation_options, {
      credentialId: authenticator.credentialId,
    });
    const res = await user.client.request(`/v1/client/me/passkeys/${begin.response.id}/attempt_verification`, {
      body: { public_key_credential: duplicate }, headers: { origin: "http://localhost:3000" },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("passkey_registration_failure");
  });

  it("refuses the same credential registered under two different challenges", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    // A second begin() creates a second challenge; presenting the already-registered credential fails cleanly.
    const begin = await user.client.json<{ response: { id: string; public_key_credential_creation_options: PublicKeyCredentialCreationOptionsJSON } }>(
      "/v1/client/me/passkeys", { body: {}, headers: { origin: APP_ORIGIN } },
    );
    const duplicate = authenticator.register(begin.response.public_key_credential_creation_options, {
      credentialId: authenticator.credentialId,
    });
    const res = await user.client.request(`/v1/client/me/passkeys/${begin.response.id}/attempt_verification`, {
      body: { public_key_credential: duplicate }, headers: { origin: APP_ORIGIN },
    });
    expect(res.status).toBe(409);
    expect(await errorCode(res)).toBe("passkey_registration_failure");
  });

  it("refuses to register a passkey twice via excludeCredentials on the second begin", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);
    const second = await user.client.json<{ response: { public_key_credential_creation_options: { excludeCredentials: { id: string }[] } } }>(
      "/v1/client/me/passkeys", { body: {}, headers: { origin: "http://localhost:3000" } },
    );
    expect(second.response.public_key_credential_creation_options.excludeCredentials.map((c) => c.id))
      .toContain(authenticator.credentialId);
  });

  it("refuses a deleted passkey", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator, passkeyId } = await registerPasskey(user.client);
    await user.client.json(`/v1/client/me/passkeys/${passkeyId}`, { method: "DELETE" });

    const client = testClient(app);
    const created = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    const res = await attemptPasskey(client, created.response.id, authenticator.authenticate(options));
    expect(res.status).toBe(400);
    expect(await errorCode(res)).toBe("passkey_authentication_failure");
  });

  it("refuses a banned user's passkey and creates no session", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);
    await ctx.db.update(schema.users).set({ banned: true }).where(eq(schema.users.id, user.userId));

    const discoverable = await signInWithPasskey(testClient(app), authenticator);
    expect(discoverable.res.status).toBe(403);
    expect(await errorCode(discoverable.res)).toBe("user_banned");

    // With an identifier the user is checked before any WebAuthn work happens.
    const identifierFirst = await createSignIn(testClient(app), { identifier: user.email, strategy: "passkey" });
    const items = errorsOf(identifierFirst).map((item) => item.code);
    expect(items).toContain("user_banned");
    expect(first(await ctx.db.select().from(schema.sessions).where(and(eq(schema.sessions.userId, user.userId), eq(schema.sessions.authMethod, "passkey"))))).toBeUndefined();
  });

  it("refuses a locked user's passkey", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);
    await ctx.db.update(schema.users).set({ locked: true, lockoutExpiresAt: Date.now() + 60_000 }).where(eq(schema.users.id, user.userId));

    const { res } = await signInWithPasskey(testClient(app), authenticator);
    expect(res.status).toBe(403);
    expect(await errorCode(res)).toBe("user_locked");
  });

  it("refuses passkey sign-in when passkeys are enabled but not allowed as a first factor", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);
    await ctx.settings.update({ attributes: { passkey: { enabled: true, usedForFirstFactor: false } } });

    const client = testClient(app);
    // Even starting the attempt is refused: a discoverable sign-in has no user to check later.
    const created = await client.request("/v1/client/sign_ins", { body: { strategy: "passkey" }, headers: { origin: APP_ORIGIN } });
    expect(created.status).toBe(400);
    expect(await errorCode(created)).toBe("strategy_for_user_invalid");

    // And a prepared challenge from before the setting changed cannot complete a session either.
    await ctx.settings.update({ attributes: { passkey: { enabled: true, usedForFirstFactor: true } } });
    const inFlight = await createSignIn(client, { strategy: "passkey" });
    const { options } = await preparePasskey(client, inFlight.response.id);
    await ctx.settings.update({ attributes: { passkey: { enabled: true, usedForFirstFactor: false } } });
    const res = await attemptPasskey(client, inFlight.response.id, authenticator.authenticate(options));
    expect(res.status).toBe(400);
    expect(first(await ctx.db.select().from(schema.sessions).where(and(eq(schema.sessions.userId, user.userId), eq(schema.sessions.authMethod, "passkey"))))).toBeUndefined();
  });

  it("hides passkey from the environment's first factors when it is not allowed as one", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    await ctx.settings.update({ attributes: { passkey: { enabled: true, usedForFirstFactor: false } } });
    const env = await testClient(app).json<{ auth_config: { first_factors: string[] } }>("/v1/client/environment");
    expect(env.auth_config.first_factors).not.toContain("passkey");
  });

  it("refuses passkey registration and sign-in while passkeys are disabled in settings", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    await registerPasskey(user.client);
    await ctx.settings.update({ attributes: { passkey: { enabled: false } } });

    const begin = await user.client.request("/v1/client/me/passkeys", {
      body: {}, headers: { origin: APP_ORIGIN },
    });
    expect(begin.status).toBe(400);
    expect(await errorCode(begin)).toBe("webauthn_not_supported");

    const client = testClient(app);
    const created = await client.request("/v1/client/sign_ins", { body: { strategy: "passkey" }, headers: { origin: APP_ORIGIN } });
    expect(created.status).toBe(400);
    expect(await errorCode(created)).toBe("strategy_for_user_invalid");
  });
});
