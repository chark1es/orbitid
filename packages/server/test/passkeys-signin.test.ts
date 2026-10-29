import { describe, expect, it } from "vitest";
import { errorsOf, setup, signUpUser, testClient } from "./core/helpers";
import {
  APP_ORIGIN, attemptPasskey, createSignIn, enablePasskeys, passkeyRow, preparePasskey, registerPasskey, sessionRow,
  signInWithPasskey, signInWithPasskeyForIdentifier,
} from "./passkeys-helpers";

describe("passkey sign-in (real authenticator)", () => {
  it("signs in discoverably without an identifier and records auth_method=passkey", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator, passkeyId } = await registerPasskey(user.client);

    const client = testClient(app);
    const { requestOptions, res } = await signInWithPasskey(client, authenticator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { response: { status: string; created_session_id: string } };
    expect(body.response.status).toBe("complete");
    const sessionId = body.response.created_session_id;
    expect(sessionId).toMatch(/^sess_/);

    const session = (await sessionRow(ctx, sessionId))!;
    expect(session.userId).toBe(user.userId);
    expect(session.authMethod).toBe("passkey");

    // Discoverable flow lets the browser pick: no allowCredentials list is pushed at it.
    expect(requestOptions.rpId).toBe("localhost");
    expect(requestOptions.allowCredentials ?? []).toHaveLength(0);

    // The counter moved past zero and was persisted.
    expect(authenticator.counter).toBe(1);
    expect((await passkeyRow(ctx, passkeyId))!.counter).toBe(1);
    expect((await passkeyRow(ctx, passkeyId))!.lastUsedAt).not.toBeNull();
  });

  it("increments the stored counter on every sign-in", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator, passkeyId } = await registerPasskey(user.client);

    for (const expected of [1, 2, 3]) {
      const { res } = await signInWithPasskey(testClient(app), authenticator);
      expect(res.status).toBe(200);
      expect((await passkeyRow(ctx, passkeyId))!.counter).toBe(expected);
    }
  });

  it("signs in identifier-first and limits the request to that user's credentials", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator, passkeyId } = await registerPasskey(user.client);

    const client = testClient(app);
    const { requestOptions, res } = await signInWithPasskeyForIdentifier(client, user.email, authenticator);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { response: { status: string; created_session_id: string } };
    expect(body.response.status).toBe("complete");

    const stored = (await passkeyRow(ctx, passkeyId))!;
    expect(requestOptions.allowCredentials?.map((c) => c.id)).toEqual([stored.credentialId]);
    expect((await sessionRow(ctx, body.response.created_session_id!))!.authMethod).toBe("passkey");
  });

  it("signs in with an RS256 security key", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client, { authenticator: (await import("./passkeys-helpers")).newAuthenticator({ alg: "RS256" }) });
    const { res } = await signInWithPasskey(testClient(app), authenticator);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { response: { status: string } }).response.status).toBe("complete");
  });

  it("supports the conditional-UI shape: create a sign-in, then prepare with no prior identifier", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { authenticator } = await registerPasskey(user.client);

    const client = testClient(app);
    // Conditional UI (autofill) creates the attempt from the sign-in page with no identifier and no strategy.
    const created = await createSignIn(client, {});
    expect(created.response.status).toBe("needs_identifier");
    const { options } = await preparePasskey(client, created.response.id, APP_ORIGIN);
    const assertion = authenticator.authenticate(options);
    const res = await attemptPasskey(client, created.response.id, assertion);
    expect(res.status).toBe(200);
    expect(((await res.json()) as { response: { status: string } }).response.status).toBe("complete");
  });

  it("refuses passkey sign-in for an identifier that has no passkey", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    void user;
    const other = await signUpUser(app);

    const client = testClient(app);
    const created = await createSignIn(client, { identifier: other.email, strategy: "passkey" });
    const { options } = await preparePasskey(client, created.response.id);
    expect(options.allowCredentials).toEqual([]);
    const stray = (await import("./passkeys-helpers")).newAuthenticator();
    const res = await attemptPasskey(client, created.response.id, stray.authenticate(options));
    expect(res.status).toBe(400);
    expect(errorsOf(await res.json())[0]?.code).toBe("passkey_authentication_failure");
  });
});
