import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { getSmsOutbox, latestCodeFor } from "../../src/services/mail";
import { setCaptchaVerifierForTests } from "../../src/services/captcha";
import { sha256 } from "../../src/lib/crypto";
import * as schema from "../../src/db/schema";
import { errorsOf, getClient, lastLink, setup, signInWithPassword, signUpUser, testClient } from "./helpers";

describe("sign-up", () => {
  it("creates an account from email + password, verifies the email code and returns a session", async () => {
    const { app, ctx } = await setup();
    const client = testClient(app);
    const email = "new@example.com";
    const created = await client.json<{ response: { status: string; missing_fields: string[]; unverified_fields: string[]; id: string } }>("/v1/client/sign_ups", {
      body: { email_address: email, password: "Sup3rSecret!", first_name: "Ada", last_name: "Lovelace" },
    });
    expect(created.response.status).toBe("missing_requirements");
    expect(created.response.missing_fields).toEqual([]);
    expect(created.response.unverified_fields).toEqual(["email_address"]);

    const prepared = await client.json<{ response: { verifications: { email_address: { status: string } } } }>(
      `/v1/client/sign_ups/${created.response.id}/prepare_verification`,
      { body: { strategy: "email_code" } },
    );
    expect(prepared.response.verifications.email_address.status).toBe("unverified");
    const code = latestCodeFor(email)!;
    expect(code).toMatch(/^\d{6}$/);

    const completed = await client.json<{ response: { status: string; created_session_id: string; created_user_id: string }; client: { sessions: { user: { id: string; email_addresses: { email_address: string; verification: { status: string } }[] } }[] } }>(
      `/v1/client/sign_ups/${created.response.id}/attempt_verification`,
      { body: { strategy: "email_code", code } },
    );
    expect(completed.response.status).toBe("complete");
    expect(completed.response.created_session_id).toMatch(/^sess_/);
    expect(completed.client.sessions).toHaveLength(1);
    expect(completed.client.sessions[0]!.user.email_addresses[0]!.verification.status).toBe("verified");

    const state = await getClient(client);
    expect(state.response.sessions[0]!.user!.id).toBe(completed.response.created_user_id);
    expect(state.response.sign_up).toBeNull();

    const events = ctx.db.select().from(schema.webhookEvents).all().filter((e) => e.type === "user.created");
    expect(events.length).toBeGreaterThan(0);

    const user = ctx.db.select().from(schema.users).where(eq(schema.users.id, completed.response.created_user_id)).get();
    expect(user?.passwordHash).not.toBe("Sup3rSecret!");
    expect(user?.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("verifies a sign-up email with a magic link", async () => {
    const { app } = await setup();
    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ups", {
      body: { email_address: "magic-signup@example.com", password: "Sup3rSecret!" },
    });
    await client.json(`/v1/client/sign_ups/${created.response.id}/prepare_verification`, { body: { strategy: "email_link" } });
    const link = lastLink("magic-signup@example.com")!;
    const landing = await app.request(link, { redirect: "manual" });
    expect(landing.status).toBe(302);

    const completed = await client.json<{ response: { status: string; unverified_fields: string[]; created_session_id: string } }>(`/v1/client/sign_ups/${created.response.id}`);
    expect(completed.response.status).toBe("complete");
    expect(completed.response.unverified_fields).toEqual([]);
    expect(completed.response.created_session_id).toMatch(/^sess_/);
    const state = await getClient(client);
    expect(state.response.sessions).toHaveLength(1);

    const again = await client.json(`/v1/client/sign_ups/${created.response.id}/prepare_verification`, { body: { strategy: "email_code" } });
    expect(errorsOf(again)[0]?.code).toBe("client_state_invalid");
  });

  it("rejects duplicate emails and weak passwords", async () => {
    const { app } = await setup();
    await signUpUser(app, { email: "taken@example.com" });
    const client = testClient(app);
    const duplicate = await client.json("/v1/client/sign_ups", { body: { email_address: "taken@example.com", password: "Sup3rSecret!" } });
    expect(errorsOf(duplicate)[0]?.code).toBe("form_identifier_exists");
    const weak = await client.json("/v1/client/sign_ups", { body: { email_address: "fresh@example.com", password: "short" } });
    expect(errorsOf(weak)[0]?.code).toBe("form_password_length_too_short");
  });

  it("honours username uniqueness and the instance username rules", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ attributes: { username: { enabled: true, required: false, usedForFirstFactor: true } }, username: { minLength: 4, maxLength: 16 } });
    await signUpUser(app, { email: "u1@example.com", username: "taken1" });
    const client = testClient(app);
    const short = await client.json("/v1/client/sign_ups", { body: { email_address: "u2@example.com", password: "Sup3rSecret!", username: "ab" } });
    expect(errorsOf(short)[0]?.code).toBe("form_username_invalid_length");
    const duplicate = await client.json("/v1/client/sign_ups", { body: { email_address: "u3@example.com", password: "Sup3rSecret!", username: "taken1" } });
    expect(errorsOf(duplicate)[0]?.code).toBe("form_identifier_exists");
  });

  it("enforces the allowlist for sign-ups", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ restrictions: { allowlistEnabled: true } });
    const now = Date.now();
    ctx.db.insert(schema.allowlistIdentifiers).values({
      id: "alid_test", identifier: "allowed@example.com", identifierType: "email_address", createdAt: now, updatedAt: now,
    }).run();
    const blocked = await testClient(app).json("/v1/client/sign_ups", { body: { email_address: "blocked@example.com", password: "Sup3rSecret!" } });
    expect(errorsOf(blocked)[0]?.code).toBe("sign_up_restricted");
    const allowed = await testClient(app).json<{ response: { status: string } }>("/v1/client/sign_ups", {
      body: { email_address: "allowed@example.com", password: "Sup3rSecret!" },
    });
    expect(allowed.response.status).toBe("missing_requirements");
  });

  it("signs up with an invitation ticket and marks the invitation accepted", async () => {
    const { app, ctx } = await setup();
    const ticket = "invite-ticket-123";
    const now = Date.now();
    ctx.db.insert(schema.invitations).values({
      id: "inv_test", email: "invitee@example.com", status: "pending", tokenHash: sha256(ticket), createdAt: now, updatedAt: now,
    }).run();
    await ctx.settings.update({ signUp: { mode: "restricted" } });

    const client = testClient(app);
    const created = await client.json<{ response: { id: string; email_address: string; status: string } }>("/v1/client/sign_ups", {
      body: { ticket, password: "Sup3rSecret!" },
    });
    expect(created.response.email_address).toBe("invitee@example.com");
    expect(created.response.status).toBe("missing_requirements");

    const mismatched = await testClient(app).json("/v1/client/sign_ups", {
      body: { ticket, email_address: "someone-else@example.com", password: "Sup3rSecret!" },
    });
    expect(errorsOf(mismatched)[0]?.code).toBe("form_param_value_invalid");

    await client.json(`/v1/client/sign_ups/${created.response.id}/prepare_verification`, { body: { strategy: "email_code" } });
    const code = latestCodeFor("invitee@example.com")!;
    const completed = await client.json<{ response: { status: string; created_user_id: string } }>(`/v1/client/sign_ups/${created.response.id}/attempt_verification`, {
      body: { strategy: "email_code", code },
    });
    expect(completed.response.status).toBe("complete");
    const invitation = ctx.db.select().from(schema.invitations).where(eq(schema.invitations.id, "inv_test")).get()!;
    expect(invitation.status).toBe("accepted");
  });

  it("requires legal consent when the instance asks for it", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ signUp: { legalConsentRequired: true } });
    const client = testClient(app);
    const missing = await client.json("/v1/client/sign_ups", { body: { email_address: "legal@example.com", password: "Sup3rSecret!" } });
    expect(errorsOf(missing)[0]?.code).toBe("form_param_missing");
    expect(errorsOf(missing)[0]?.meta).toMatchObject({ param_name: "legal_accepted" });

    const created = await client.json<{ response: { id: string; missing_fields: string[]; legal_accepted_at: number | null } }>("/v1/client/sign_ups", {
      body: { email_address: "legal@example.com", password: "Sup3rSecret!", legal_accepted: true },
    });
    expect(created.response.missing_fields).not.toContain("legal_accepted");
    expect(created.response.legal_accepted_at).toBeGreaterThan(0);
    await client.json(`/v1/client/sign_ups/${created.response.id}/prepare_verification`, { body: { strategy: "email_code" } });
    const completed = await client.json<{ response: { status: string; created_user_id: string } }>(`/v1/client/sign_ups/${created.response.id}/attempt_verification`, {
      body: { strategy: "email_code", code: latestCodeFor("legal@example.com") },
    });
    expect(completed.response.status).toBe("complete");
    const user = ctx.db.select().from(schema.users).where(eq(schema.users.id, completed.response.created_user_id)).get()!;
    expect(user.legalAcceptedAt).toBeGreaterThan(0);
  });

  it("rejects sign-ups when the instance is in restricted mode", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ signUp: { mode: "restricted" } });
    const client = testClient(app);
    const res = await client.json("/v1/client/sign_ups", { body: { email_address: "nope@example.com", password: "Sup3rSecret!" } });
    expect(errorsOf(res)[0]?.code).toBe("sign_up_restricted");
  });
});

describe("sign-in", () => {
  it("signs in with email + password and mints a session", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const { client, sessionId } = await signInWithPassword(app, user.email, user.password);
    const state = await getClient(client);
    expect(state.response.last_active_session_id).toBe(sessionId);
    expect(state.response.sessions[0]!.status).toBe("active");
    expect(state.response.sessions[0]!.last_active_token!.jwt).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
  });

  it("signs in with a username and refuses banned users", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ attributes: { username: { enabled: true, required: false, usedForFirstFactor: true } } });
    const user = await signUpUser(app, { username: "alice99" });
    const byUsername = await testClient(app).json<{ response: { status: string; created_session_id: string } }>("/v1/client/sign_ins", {
      body: { identifier: "alice99", password: user.password },
    });
    expect(byUsername.response.status).toBe("complete");

    ctx.db.update(schema.users).set({ banned: true }).where(eq(schema.users.id, user.userId)).run();
    const banned = await testClient(app).json("/v1/client/sign_ins", { body: { identifier: user.email, password: user.password } });
    expect(errorsOf(banned)[0]?.code).toBe("user_banned");
  });

  it("rejects a wrong password", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const client = testClient(app);
    const res = await client.json("/v1/client/sign_ins", { body: { identifier: user.email, password: "WrongPassword1!" } });
    expect(errorsOf(res)[0]?.code).toBe("form_password_incorrect");
  });

  it("signs in with an email code", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const client = testClient(app);
    const created = await client.json<{ response: { id: string; status: string; supported_first_factors: { strategy: string }[] } }>("/v1/client/sign_ins", {
      body: { identifier: user.email },
    });
    expect(created.response.status).toBe("needs_first_factor");
    expect(created.response.supported_first_factors.map((f) => f.strategy)).toContain("email_code");
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_code" } });
    const code = latestCodeFor(user.email)!;
    const done = await client.json<{ response: { status: string; created_session_id: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
      body: { strategy: "email_code", code },
    });
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);
  });

  it("limits incorrect verification-code attempts", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", { body: { identifier: user.email } });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_code" } });
    let last: unknown;
    for (let i = 0; i < 5; i++) {
      last = await client.json(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, { body: { strategy: "email_code", code: "000000" } });
    }
    expect(errorsOf(last)[0]?.code).toBe("too_many_attempts");
    const correct = await client.json(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
      body: { strategy: "email_code", code: latestCodeFor(user.email) },
    });
    expect(errorsOf(correct)[0]?.code).toBe("too_many_attempts");
  });

  it("completes a magic-link sign-in across devices by polling the attempt", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, strategy: "email_link", redirect_url: "http://localhost:3000/app" },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_link" } });
    const link = lastLink(user.email)!;
    expect(link).toContain("/v1/verify?token=");

    // Not clicked yet: polling returns the pending state.
    const pending = await client.json<{ response: { status: string; first_factor_verification: { status: string } } }>(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
      body: { strategy: "email_link" },
    });
    expect(pending.response.status).toBe("needs_first_factor");
    expect(pending.response.first_factor_verification.status).toBe("unverified");

    // Open the link in another browser (no cookie).
    const landing = await app.request(link, { redirect: "manual" });
    expect(landing.status).toBe(302);
    expect(landing.headers.get("location")).toContain("__orbit_status=verified");

    const done = await client.json<{ response: { status: string; created_session_id: string } }>(`/v1/client/sign_ins/${created.response.id}`);
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);
    expect((await getClient(client)).response.sessions).toHaveLength(1);
  });

  it("resets a password through a reset code", async () => {
    const { app } = await setup();
    const user = await signUpUser(app);
    const client = testClient(app);
    const created = await client.json<{ response: { id: string; status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, strategy: "reset_password_email_code" },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "reset_password_email_code" } });
    const code = latestCodeFor(user.email, "reset_password_code")!;
    const verified = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
      body: { strategy: "reset_password_email_code", code },
    });
    expect(verified.response.status).toBe("needs_new_password");
    const done = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}/reset_password`, {
      body: { password: "Br4ndNewPass!" },
    });
    expect(done.response.status).toBe("complete");

    const { state } = await signInWithPassword(app, user.email, "Br4ndNewPass!");
    expect(state.response.sessions).toHaveLength(1);
    const oldClient = testClient(app);
    const old = await oldClient.json("/v1/client/sign_ins", { body: { identifier: user.email, password: user.password } });
    expect(errorsOf(old)[0]?.code).toBe("form_password_incorrect");
  });

  it("locks an account after too many failed password attempts", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    await ctx.settings.update({ mfa: { maxAttempts: 3 } });
    for (let i = 0; i < 3; i++) {
      const client = testClient(app);
      const res = await client.json("/v1/client/sign_ins", { body: { identifier: user.email, password: "NopeNope1!" } });
      expect(errorsOf(res)[0]?.code).toBe("form_password_incorrect");
    }
    const blocked = await testClient(app).json("/v1/client/sign_ins", { body: { identifier: user.email, password: user.password } });
    expect(errorsOf(blocked)[0]?.code).toBe("user_locked");
  });

  it("verifies a phone number and signs in with an SMS code", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ attributes: { phoneNumber: { enabled: true, usedForFirstFactor: true, verifications: ["phone_code"] } } });
    const user = await signUpUser(app);
    const phone = await user.client.json<{ response: { id: string; phone_number: string; verification: { status: string } } }>("/v1/client/me/phone_numbers", {
      body: { phone_number: "+15551234567" },
    });
    expect(phone.response.verification.status).toBe("unverified");
    await user.client.json(`/v1/client/me/phone_numbers/${phone.response.id}/prepare_verification`, { body: {} });
    const sms = getSmsOutbox().at(-1)!;
    expect(sms.to).toBe("+15551234567");
    const code = /(\d{6})/.exec(sms.body)?.[1];
    await user.client.json(`/v1/client/me/phone_numbers/${phone.response.id}/attempt_verification`, { body: { code } });

    const client = testClient(app);
    const created = await client.json<{ response: { id: string; status: string; supported_first_factors: { strategy: string }[] } }>("/v1/client/sign_ins", {
      body: { identifier: "+15551234567" },
    });
    expect(created.response.status).toBe("needs_first_factor");
    expect(created.response.supported_first_factors.some((f) => f.strategy === "phone_code")).toBe(true);
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "phone_code" } });
    const smsCode = /(\d{6})/.exec(getSmsOutbox().at(-1)!.body)?.[1];
    const done = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}/attempt_first_factor`, {
      body: { strategy: "phone_code", code: smsCode },
    });
    expect(done.response.status).toBe("complete");
  });

  it("returns form_identifier_not_found for unknown accounts", async () => {
    const { app } = await setup();
    const res = await testClient(app).json("/v1/client/sign_ins", { body: { identifier: "ghost@example.com" } });
    expect(errorsOf(res)[0]?.code).toBe("form_identifier_not_found");
  });

  it("routes enterprise SSO domains to /v1/client/enterprise/start", async () => {
    const { app, ctx } = await setup();
    const now = Date.now();
    ctx.db.insert(schema.enterpriseConnections).values({
      id: "ent_test", name: "Acme Okta", protocol: "saml", provider: "okta", domains: ["corp.example"], active: true,
      config: {}, createdAt: now, updatedAt: now,
    }).run();
    const client = testClient(app);
    const handoff = await client.json<{ response: { status: string; first_factor_verification: { strategy: string; external_verification_redirect_url: string } } }>("/v1/client/sign_ins", {
      body: { identifier: "someone@corp.example", strategy: "enterprise_sso" },
    });
    expect(handoff.response.status).toBe("needs_first_factor");
    expect(handoff.response.first_factor_verification.strategy).toBe("enterprise_sso");
    const url = new URL(handoff.response.first_factor_verification.external_verification_redirect_url);
    expect(url.pathname).toBe("/v1/client/enterprise/start");
    expect(url.searchParams.get("connection_id")).toBe("ent_test");
    expect(url.searchParams.get("client_id")).toBeTruthy();
    expect(url.searchParams.get("action")).toBe("sign_in");

    // An existing account on the domain is routed to SSO by identifier alone.
    const user = await signUpUser(app, { email: "employee@corp.example" });
    const routed = await testClient(app).json<{ response: { first_factor_verification: { external_verification_redirect_url: string } } }>("/v1/client/sign_ins", {
      body: { identifier: user.email },
    });
    expect(routed.response.first_factor_verification.external_verification_redirect_url).toContain("/v1/client/enterprise/start");
  });

  it("hides unknown accounts when enumeration protection is enabled", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ security: { enumerationProtection: true } });
    const res = await testClient(app).json<{ response: { status: string; supported_first_factors: unknown } }>("/v1/client/sign_ins", {
      body: { identifier: "ghost@example.com" },
    });
    expect(res.response.status).toBe("needs_identifier");
    expect(res.response.supported_first_factors).toBeNull();
  });

  it("verifies CAPTCHA tokens from the body or header when bot protection is configured", async () => {
    const { app, ctx } = await setup();
    await ctx.settings.update({ security: { captchaProvider: "turnstile", captchaSecret: "secret" } });
    setCaptchaVerifierForTests(async (token) => token === "good-token");
    try {
      const client = testClient(app);
      const missing = await client.json("/v1/client/sign_ups", { body: { email_address: "captcha1@example.com", password: "Sup3rSecret!" } });
      expect(errorsOf(missing)[0]?.code).toBe("bot_detected");

      const fromBody = await client.json<{ response: { status: string } }>("/v1/client/sign_ups", {
        body: { email_address: "captcha2@example.com", password: "Sup3rSecret!", captcha_token: "good-token" },
      });
      expect(fromBody.response.status).toBe("missing_requirements");

      const fromHeader = await client.json<{ response: { status: string } }>("/v1/client/sign_ups", {
        body: { email_address: "captcha3@example.com", password: "Sup3rSecret!" },
        headers: { "x-captcha-token": "good-token" },
      });
      expect(fromHeader.response.status).toBe("missing_requirements");
    } finally {
      setCaptchaVerifierForTests(null);
    }
  });
});
