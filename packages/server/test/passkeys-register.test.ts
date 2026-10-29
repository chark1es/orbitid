import { describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as schema from "../src/db/schema";
import { errorsOf, setup, signUpUser } from "./core/helpers";
import { APP_ORIGIN, beginRegistration, enablePasskeys, newAuthenticator, passkeyRow, registerPasskey } from "./passkeys-helpers";

describe("passkey registration (real authenticator)", () => {
  it("registers an ES256 passkey and stores its counter, transports and backup flags", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);

    const { credential, finished, passkeyId, authenticator } = await registerPasskey(user.client, { name: "Laptop" });
    expect(finished.response.id).toBe(passkeyId);
    expect(finished.response.name).toBe("Laptop");

    const row = (await passkeyRow(ctx, passkeyId))!;
    expect(row.credentialId).toBe(authenticator.credentialId);
    expect(row.credentialId).toBe(credential.id);
    expect(row.counter).toBe(0);
    expect(row.transports).toEqual(["internal", "hybrid"]);
    expect(row.deviceType).toBe("multiDevice");
    expect(row.backedUp).toBe(true);
    // The stored key is the COSE key from the attestation, not the raw public key.
    expect(Buffer.from(row.publicKey, "base64url").length).toBeGreaterThan(0);
    expect(row.publicKey).not.toBe(credential.response.publicKey);

    const listed = await user.client.json<{ response: { id: string; name: string }[] }>("/v1/client/me/passkeys");
    expect(listed.response.map((p) => p.id)).toEqual([passkeyId]);
  });

  it("registers an RS256 security key", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const authenticator = newAuthenticator({ alg: "RS256" });
    const { passkeyId } = await registerPasskey(user.client, { authenticator, body: { authenticator_type: "cross-platform" } });
    const row = (await passkeyRow(ctx, passkeyId))!;
    expect(row.transports).toEqual(["usb", "nfc"]);
    expect(row.deviceType).toBe("multiDevice");
  });

  it("does not create a passkey row before the attestation verifies", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const begin = await beginRegistration(user.client, { name: "Pending" });
    expect(await passkeyRow(ctx, begin.response.id)).toBeUndefined();
    const listed = await user.client.json<{ response: unknown[] }>("/v1/client/me/passkeys");
    expect(listed.response).toHaveLength(0);
  });

  it("uses the name from the begin call when the finish call omits one", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { passkeyId } = await registerPasskey(user.client, { name: "YubiKey" });
    expect((await passkeyRow(ctx, passkeyId))!.name).toBe("YubiKey");

    // And the finish call can supply a name of its own.
    const second = await beginRegistration(user.client);
    const credential = newAuthenticator().register(second.response.public_key_credential_creation_options);
    const finished = await user.client.json<{ response: { name: string } }>(
      `/v1/client/me/passkeys/${second.response.id}/attempt_verification`,
      { body: { public_key_credential: credential, name: "Phone" }, headers: { origin: APP_ORIGIN } },
    );
    expect(finished.response.name).toBe("Phone");
  });

  it("lists, renames and deletes a passkey", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const { passkeyId } = await registerPasskey(user.client, { name: "Laptop" });

    const renamed = await user.client.json<{ response: { id: string; name: string; updated_at: number } }>(
      `/v1/client/me/passkeys/${passkeyId}`, { method: "PATCH", body: { name: "Work laptop" } },
    );
    expect(renamed.response.name).toBe("Work laptop");

    const deleted = await user.client.json<{ response: { id: string; deleted: boolean } }>(
      `/v1/client/me/passkeys/${passkeyId}`, { method: "DELETE" },
    );
    expect(deleted.response.deleted).toBe(true);
    expect(await passkeyRow(ctx, passkeyId)).toBeUndefined();
    const listed = await user.client.json<{ response: unknown[] }>("/v1/client/me/passkeys");
    expect(listed.response).toHaveLength(0);
  });

  it("does not let one user rename or delete another user's passkey", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const owner = await signUpUser(app);
    const other = await signUpUser(app);
    const { passkeyId } = await registerPasskey(owner.client);

    const rename = await other.client.request(`/v1/client/me/passkeys/${passkeyId}`, { method: "PATCH", body: { name: "Mine now" } });
    expect(rename.status).toBe(404);
    const remove = await other.client.request(`/v1/client/me/passkeys/${passkeyId}`, { method: "DELETE" });
    expect(remove.status).toBe(404);
    expect((await passkeyRow(ctx, passkeyId))!.name).not.toBe("Mine now");
  });

  it("rejects an attestation whose challenge is not the one the server issued", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const begin = await beginRegistration(user.client);
    const credential = newAuthenticator().register(begin.response.public_key_credential_creation_options, {
      challenge: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    });
    const res = await user.client.request(`/v1/client/me/passkeys/${begin.response.id}/attempt_verification`, {
      body: { public_key_credential: credential }, headers: { origin: APP_ORIGIN },
    });
    expect(res.status).toBe(400);
    expect(errorsOf(await res.json())[0]?.code).toBe("passkey_registration_failure");
  });

  it("rejects an attestation whose rpIdHash belongs to another relying party", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const begin = await beginRegistration(user.client);
    const credential = newAuthenticator().register(begin.response.public_key_credential_creation_options, { rpID: "evil.example" });
    const res = await user.client.request(`/v1/client/me/passkeys/${begin.response.id}/attempt_verification`, {
      body: { public_key_credential: credential }, headers: { origin: APP_ORIGIN },
    });
    expect(res.status).toBe(400);
    expect(errorsOf(await res.json())[0]?.code).toBe("passkey_registration_failure");
  });

  it("rejects an attestation whose origin is not the app origin", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const begin = await beginRegistration(user.client);
    const credential = newAuthenticator().register(begin.response.public_key_credential_creation_options, { origin: "https://evil.example" });
    const res = await user.client.request(`/v1/client/me/passkeys/${begin.response.id}/attempt_verification`, {
      body: { public_key_credential: credential }, headers: { origin: APP_ORIGIN },
    });
    expect(res.status).toBe(400);
    expect(errorsOf(await res.json())[0]?.code).toBe("passkey_registration_failure");
  });

  it("rejects an expired or already-used registration challenge", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);

    const expired = await beginRegistration(user.client);
    await ctx.db.update(schema.verifications).set({ expiresAt: Date.now() - 1 })
      .where(and(eq(schema.verifications.purpose, "passkey_registration"), eq(schema.verifications.ownerId, expired.response.id)));
    const credential = newAuthenticator().register(expired.response.public_key_credential_creation_options);
    const res = await user.client.request(`/v1/client/me/passkeys/${expired.response.id}/attempt_verification`, {
      body: { public_key_credential: credential }, headers: { origin: APP_ORIGIN },
    });
    expect(res.status).toBe(400);
    expect(errorsOf(await res.json())[0]?.code).toBe("verification_expired");

    // A completed ceremony cannot be presented again.
    const used = await beginRegistration(user.client);
    const auth = newAuthenticator();
    const usedCredential = auth.register(used.response.public_key_credential_creation_options);
    const first = await user.client.request(`/v1/client/me/passkeys/${used.response.id}/attempt_verification`, {
      body: { public_key_credential: usedCredential }, headers: { origin: APP_ORIGIN },
    });
    expect(first.status).toBe(200);
    const replay = await user.client.request(`/v1/client/me/passkeys/${used.response.id}/attempt_verification`, {
      body: { public_key_credential: usedCredential }, headers: { origin: APP_ORIGIN },
    });
    expect(replay.status).toBe(400);
    expect(errorsOf(await replay.json())[0]?.code).toBe("verification_expired");
  });

  it("rejects a registration for another user's challenge", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const owner = await signUpUser(app);
    const other = await signUpUser(app);
    const begin = await beginRegistration(owner.client);
    const credential = newAuthenticator().register(begin.response.public_key_credential_creation_options);
    const res = await other.client.request(`/v1/client/me/passkeys/${begin.response.id}/attempt_verification`, {
      body: { public_key_credential: credential }, headers: { origin: APP_ORIGIN },
    });
    expect(res.status).toBe(400);
    expect(errorsOf(await res.json())[0]?.code).toBe("verification_expired");
    expect(await ctx.db.select().from(schema.passkeys)).toHaveLength(0);
  });

  it("requires user verification at registration", async () => {
    const { app, ctx } = await setup();
    await enablePasskeys(ctx);
    const user = await signUpUser(app);
    const begin = await beginRegistration(user.client);
    const credential = newAuthenticator({ userVerification: false }).register(begin.response.public_key_credential_creation_options);
    const res = await user.client.request(`/v1/client/me/passkeys/${begin.response.id}/attempt_verification`, {
      body: { public_key_credential: credential }, headers: { origin: APP_ORIGIN },
    });
    expect(res.status).toBe(400);
    expect(errorsOf(await res.json())[0]?.code).toBe("passkey_registration_failure");
  });
});
