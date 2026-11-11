import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { latestCodeFor, latestEmail } from "../../src/services/mail";
import { errorsOf, getClient, setup, signInWithPassword, signUpUser, testClient } from "./helpers";
import { first } from "../../src/lib/db";

describe("environment", () => {
  it("returns the public environment without secrets", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({
      application: { name: "Acme Auth" },
      social: { google: { enabled: true, clientId: "google-id", clientSecret: "super-secret-value", scopes: ["openid", "email"] } },
      security: { captchaProvider: "turnstile", captchaSecret: "captcha-secret-value", captchaSiteKey: "site-key" },
    });
    const res = await app.request("/v1/client/environment");
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("super-secret-value");
    expect(text).not.toContain("captcha-secret-value");

    const env = JSON.parse(text) as {
      display_config: { application_name: string; captcha_enabled: boolean; captcha_site_key: string };
      user_settings: { social: Record<string, { strategy: string; name: string }> };
      auth_config: { first_factors: string[]; single_session_mode: boolean };
    };
    expect(env.display_config.application_name).toBe("Acme Auth");
    expect(env.display_config.captcha_enabled).toBe(true);
    expect(env.display_config.captcha_site_key).toBe("site-key");
    expect(env.user_settings.social.google!.strategy).toBe("oauth_google");
    expect(env.auth_config.first_factors).toEqual(expect.arrayContaining(["email_code", "password", "oauth_google"]));
    // Multi-session is the default; a single-session mode is an explicit operator choice.
    expect(env.auth_config.single_session_mode).toBe(false);
  });
});

describe("profile", () => {
  it("updates names, username and unsafe metadata", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ attributes: { username: { enabled: true, usedForFirstFactor: true } } });
    const user = await signUpUser(app);
    const updated = await user.client.json<{ response: { first_name: string; last_name: string; username: string; unsafe_metadata: Record<string, unknown> } }>("/v1/client/me", {
      method: "PATCH",
      body: { first_name: "Grace", last_name: "Hopper", username: "ghopper", unsafe_metadata: { plan: "pro" } },
    });
    expect(updated.response.first_name).toBe("Grace");
    expect(updated.response.last_name).toBe("Hopper");
    expect(updated.response.username).toBe("ghopper");
    expect(updated.response.unsafe_metadata).toEqual({ plan: "pro" });

    const me = await user.client.json<{ response: { first_name: string } }>("/v1/client/me");
    expect(me.response.first_name).toBe("Grace");
  });

  it("adds, verifies and promotes an email address", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const created = await user.client.json<{ response: { id: string; verification: { status: string } } }>("/v1/client/me/email_addresses", {
      body: { email_address: "Second@Example.com" },
    });
    expect(created.response.verification.status).toBe("unverified");

    const prepared = await user.client.json<{ response: { verification: { status: string } } }>(`/v1/client/me/email_addresses/${created.response.id}/prepare_verification`, { body: {} });
    expect(prepared.response.verification.status).toBe("unverified");
    const code = latestCodeFor("second@example.com")!;
    const verified = await user.client.json<{ response: { verification: { status: string }; email_address: string } }>(`/v1/client/me/email_addresses/${created.response.id}/attempt_verification`, {
      body: { code },
    });
    expect(verified.response.verification.status).toBe("verified");
    expect(verified.response.email_address).toBe("second@example.com");

    const listed = await user.client.json<{ response: { id: string }[] }>("/v1/client/me/email_addresses");
    expect(listed.response).toHaveLength(2);

    const promoted = await user.client.json<{ response: { primary_email_address_id: string } }>("/v1/client/me", {
      method: "PATCH",
      body: { primary_email_address_id: created.response.id },
    });
    expect(promoted.response.primary_email_address_id).toBe(created.response.id);
  });

  it("refuses to remove the last identification", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const me = await user.client.json<{ response: { primary_email_address_id: string } }>("/v1/client/me");
    const res = await user.client.json(`/v1/client/me/email_addresses/${me.response.primary_email_address_id}`, { method: "DELETE" });
    expect(errorsOf(res)[0]?.code).toBe("last_identification_cannot_be_removed");
  });

  it("changes the password and signs out other sessions", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ session: { multiSession: true } });
    const user = await signUpUser(app);
    const other = await user.client.json<{ response: { created_session_id: string } }>("/v1/client/sign_ins", { body: { identifier: user.email, password: user.password } });

    const wrong = await user.client.json("/v1/client/me/change_password", {
      method: "POST",
      body: { current_password: "not-it", new_password: "N3wPassword!" },
    });
    expect(errorsOf(wrong)[0]?.code).toBe("form_password_incorrect");

    const changed = await user.client.json<{ response: { id: string } }>("/v1/client/me/change_password", {
      method: "POST",
      body: { current_password: user.password, new_password: "N3wPassword!", sign_out_of_other_sessions: true },
    });
    expect(changed.response.id).toBe(user.userId);
    expect(latestEmail(user.email, "password_changed")).toBeDefined();

    // The session used for the request stays; every other session is revoked.
    const revoked = first(await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, user.sessionId)))!;
    expect(revoked.status).toBe("revoked");
    const current = first(await ctx.db.select().from(schema.sessions).where(eq(schema.sessions.id, other.response.created_session_id)))!;
    expect(current.status).toBe("active");

    const { state } = await signInWithPassword(app, user.email, "N3wPassword!");
    expect(state.response.sessions.filter((s) => s.status === "active")).toHaveLength(1);
  });

  it("generates passkey registration options and hides pending passkeys", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ attributes: { passkey: { enabled: true, usedForFirstFactor: true } } });
    const user = await signUpUser(app);
    const created = await user.client.json<{ response: { id: string; public_key_credential_creation_options: { challenge: string; rp: { id: string }; user: { id: string } } } }>(
      "/v1/client/me/passkeys",
      { body: {}, headers: { origin: "http://localhost:3000" } },
    );
    expect(created.response.id).toMatch(/^pkey_/);
    expect(created.response.public_key_credential_creation_options.challenge.length).toBeGreaterThan(10);
    expect(created.response.public_key_credential_creation_options.rp.id).toBe("localhost");

    const listed = await user.client.json<{ response: unknown[] }>("/v1/client/me/passkeys");
    expect(listed.response).toHaveLength(0);
    // The passkey row is created only after the attestation is verified.
    expect(first(await ctx.db.select().from(schema.passkeys).where(eq(schema.passkeys.id, created.response.id)))).toBeUndefined();

    // Discoverable passkey sign-in: prepare returns full WebAuthn request options in `nonce`.
    const signInClient = testClient(app);
    const signIn = await signInClient.json<{ response: { id: string; status: string } }>("/v1/client/sign_ins", { body: { strategy: "passkey" } });
    expect(signIn.response.status).toBe("needs_first_factor");
    const prepared = await signInClient.json<{ response: { first_factor_verification: { strategy: string; nonce: string } } }>(
      `/v1/client/sign_ins/${signIn.response.id}/prepare_first_factor`,
      { body: { strategy: "passkey" }, headers: { origin: "http://localhost:3000" } },
    );
    expect(prepared.response.first_factor_verification.strategy).toBe("passkey");
    const options = JSON.parse(prepared.response.first_factor_verification.nonce) as { challenge: string; rpId: string };
    expect(options.challenge.length).toBeGreaterThan(10);
    expect(options.rpId).toBe("localhost");
  });

  it("lists and revokes other active sessions", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ session: { multiSession: true } });
    const user = await signUpUser(app);
    const other = await user.client.json<{ response: { created_session_id: string } }>("/v1/client/sign_ins", { body: { identifier: user.email, password: user.password } });
    const active = await user.client.json<{ response: { id: string }[] }>("/v1/client/me/sessions/active");
    // The request's own (latest) session is excluded; the older one is listed.
    expect(active.response.some((s) => s.id === other.response.created_session_id)).toBe(false);
    const older = active.response.find((s) => s.id === user.sessionId)!;
    expect(older).toBeDefined();
    const revoked = await user.client.json<{ response: { status: string } }>(`/v1/client/me/sessions/${older.id}/revoke`, { method: "POST", body: {} });
    expect(revoked.response.status).toBe("revoked");
    const after = await user.client.json<{ response: { id: string }[] }>("/v1/client/me/sessions/active");
    expect(after.response.some((s) => s.id === older.id)).toBe(false);
  });

  it("renames and deletes a registered passkey", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ attributes: { passkey: { enabled: true, usedForFirstFactor: true } } });
    const user = await signUpUser(app);
    const now = Date.now();
    await ctx.db.insert(schema.passkeys).values({
                  id: "pkey_test", userId: user.userId, name: "Laptop", credentialId: "cred_test", publicKey: "pk_test",
                  counter: 0, createdAt: now, updatedAt: now,
                });
    const renamed = await user.client.json<{ response: { name: string } }>("/v1/client/me/passkeys/pkey_test", { method: "PATCH", body: { name: "Work laptop" } });
    expect(renamed.response.name).toBe("Work laptop");
    const deleted = await user.client.json<{ response: { deleted: boolean } }>("/v1/client/me/passkeys/pkey_test", { method: "DELETE" });
    expect(deleted.response.deleted).toBe(true);
    const listed = await user.client.json<{ response: unknown[] }>("/v1/client/me/passkeys");
    expect(listed.response).toHaveLength(0);
  });

  it("uploads and serves a profile image", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const uploaded = await user.client.json<{ response: { has_image: boolean; image_url: string } }>("/v1/client/me/profile_image", {
      body: { file: `data:image/png;base64,${png}` },
    });
    expect(uploaded.response.has_image).toBe(true);
    expect(uploaded.response.image_url).toMatch(/\/v1\/client\/images\/.+\.png$/);

    const path = new URL(uploaded.response.image_url).pathname;
    const served = await app.request(path);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");

    // The SDK uploads multipart FormData with a `file` field.
    const form = new FormData();
    form.append("file", new File([Buffer.from(png, "base64")], "avatar.png", { type: "image/png" }));
    const multipart = await user.client.request("/v1/client/me/profile_image", { method: "POST", body: form });
    expect(multipart.status).toBe(200);
    const multipartJson = (await multipart.json()) as { response: { has_image: boolean } };
    expect(multipartJson.response.has_image).toBe(true);

    const removed = await user.client.json<{ response: { has_image: boolean } }>("/v1/client/me/profile_image", { method: "DELETE" });
    expect(removed.response.has_image).toBe(false);
  });

  it("deletes the account when self-deletion is enabled", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const res = await user.client.json<{ response: { deleted: boolean; id: string } }>("/v1/client/me", { method: "DELETE" });
    expect(res.response.deleted).toBe(true);
    expect(first(await ctx.db.select().from(schema.users).where(eq(schema.users.id, user.userId)))).toBeUndefined();
    const state = await getClient(user.client);
    expect(state.response.sessions).toHaveLength(0);
  });
});
