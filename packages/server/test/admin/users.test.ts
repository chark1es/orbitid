import { describe, it, expect } from "vitest";
import { authenticator } from "otplib";
import { ID_PREFIX, type DeletedObjectJSON, type EmailAddressJSON, type PaginatedList, type PhoneNumberJSON, type UserJSON } from "@orbitid/shared";
import { encrypt } from "../../src/lib/crypto";
import { newId } from "../../src/lib/ids";
import * as s from "../../src/db/schema";
import { createSessionFixture, createUser, json, testApp, type ErrorBody } from "./helpers";

type OAuthTokenRow = { object: string; external_account_id: string; provider: string; token: string | null; scopes: string; expires_at: number | null };

describe("users", () => {
  it("filters the user list by mfa and wraps it with ?paginated=true", async () => {
    const { api } = await testApp();
    const withMfa = await createUser(api, { email_address: ["mfa@example.com"], password: "Sup3r-secret!", totp_secret: authenticator.generateSecret() });
    const without = await createUser(api, { email_address: ["plain@example.com"], password: "Sup3r-secret!" });
    expect(withMfa.totp_enabled).toBe(true);

    const mfaOn = await json<PaginatedList<UserJSON>>(await api("GET", "/v1/users?mfa=true&paginated=true"));
    expect(mfaOn.data.map((u) => u.id)).toEqual([withMfa.id]);
    expect(mfaOn.total_count).toBe(1);
    const mfaOff = await json<UserJSON[]>(await api("GET", "/v1/users?mfa=false"));
    expect(mfaOff.map((u) => u.id)).toEqual([without.id]);
  });

  it("creates a user with verified email, hashed password and metadata", async () => {
    const { api, ctx } = await testApp();
    const res = await api("POST", "/v1/users", {
      email_address: ["Alice@Example.com"],
      phone_number: ["+15551234567"],
      username: "alice",
      password: "Sup3r-secret!",
      first_name: "Alice",
      last_name: "Liddle",
      external_id: "crm_1",
      public_metadata: { tier: "pro" },
      private_metadata: { secret: 1 },
      unsafe_metadata: { color: "red" },
      totp_secret: authenticator.generateSecret(),
      backup_codes: ["abcd1234"],
    });
    expect(res.status).toBe(200);
    const user = await json<UserJSON>(res);
    expect(user.object).toBe("user");
    expect(user.email_addresses[0]!.email_address).toBe("alice@example.com");
    expect(user.email_addresses[0]!.verification?.status).toBe("verified");
    expect(user.primary_email_address_id).toBe(user.email_addresses[0]!.id);
    expect(user.phone_numbers[0]!.phone_number).toBe("+15551234567");
    expect(user.password_enabled).toBe(true);
    expect(user.totp_enabled).toBe(true);
    expect(user.backup_code_enabled).toBe(true);
    expect(user.public_metadata).toEqual({ tier: "pro" });
    expect(user.private_metadata).toEqual({ secret: 1 });
    expect(user.username).toBe("alice");
    expect(user.external_id).toBe("crm_1");

    const row = ctx.db.select().from(s.users).all()[0]!;
    expect(row.passwordHash).not.toBe("Sup3r-secret!");
    expect(row.passwordHash!.startsWith("$argon2id$")).toBe(true);
    expect(row.backupCodes).toHaveLength(1);
    expect(row.backupCodes![0]).not.toBe("abcd1234");
  });

  it("rejects duplicates and enforces the password policy", async () => {
    const { api } = await testApp();
    await createUser(api, { email_address: ["dup@example.com"], username: "dup", external_id: "ext-1" });

    const dupEmail = await api("POST", "/v1/users", { email_address: ["dup@example.com"], password: "Sup3r-secret!" });
    expect(dupEmail.status).toBe(422);
    expect((await json<ErrorBody>(dupEmail)).errors[0]!.code).toBe("form_identifier_exists");

    expect((await api("POST", "/v1/users", { username: "DUP", password: "Sup3r-secret!" })).status).toBe(422);
    expect((await api("POST", "/v1/users", { external_id: "ext-1", password: "Sup3r-secret!" })).status).toBe(422);

    const missingPassword = await api("POST", "/v1/users", { email_address: ["nopass@example.com"] });
    expect(missingPassword.status).toBe(422);
    expect((await json<ErrorBody>(missingPassword)).errors[0]!.code).toBe("form_param_missing");

    const shortPassword = await api("POST", "/v1/users", { email_address: ["short@example.com"], password: "abc" });
    expect(shortPassword.status).toBe(422);
    expect((await json<ErrorBody>(shortPassword)).errors[0]!.code).toBe("form_password_length_too_short");

    const dupInPayload = await api("POST", "/v1/users", { email_address: ["twice@example.com", "Twice@example.com"], skip_password_requirement: true });
    expect(dupInPayload.status).toBe(422);
    expect((await json<ErrorBody>(dupInPayload)).errors[0]!.code).toBe("duplicate_record");

    const skipped = await api("POST", "/v1/users", { email_address: ["skipped@example.com"], skip_password_requirement: true });
    expect(skipped.status).toBe(200);
    expect((await json<UserJSON>(skipped)).password_enabled).toBe(false);

    const digest = await api("POST", "/v1/users", {
      email_address: ["digest@example.com"],
      password_digest: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2E$0000000000000000000000000000000000000000000",
      password_hasher: "argon2",
      skip_password_checks: true,
    });
    expect(digest.status).toBe(200);
  });

  it("lists users as a bare array with x-total-count, filters, ordering and pagination", async () => {
    const { api, ctx } = await testApp();
    const a = await createUser(api, { email_address: ["a@example.com"], username: "alpha", created_at: 1_000 });
    const b = await createUser(api, { email_address: ["b@example.com"], external_id: "ext-b", created_at: 2_000 });
    const c = await createUser(api, { email_address: ["c@example.com"], phone_number: ["+15550000003"], created_at: 3_000 });

    const list = await api("GET", "/v1/users");
    expect(list.status).toBe(200);
    const body = await json<UserJSON[]>(list);
    expect(Array.isArray(body)).toBe(true);
    expect(list.headers.get("x-total-count")).toBe("3");
    expect(body.map((u) => u.id)).toEqual([c.id, b.id, a.id]);

    expect((await json<UserJSON[]>(await api("GET", "/v1/users?order_by=created_at"))).map((u) => u.id)).toEqual([a.id, b.id, c.id]);
    expect((await json<UserJSON[]>(await api("GET", "/v1/users?limit=1&offset=1&order_by=created_at"))).map((u) => u.id)).toEqual([b.id]);

    const paginated = await json<PaginatedList<UserJSON>>(await api("GET", "/v1/users?paginated=true&limit=2"));
    expect(paginated.total_count).toBe(3);
    expect(paginated.data).toHaveLength(2);

    expect(await json(await api("GET", "/v1/users/count"))).toEqual({ object: "total_count", total_count: 3 });

    expect((await json<UserJSON[]>(await api("GET", "/v1/users?query=alpha"))).map((u) => u.id)).toEqual([a.id]);
    expect((await json<UserJSON[]>(await api("GET", `/v1/users?query=${b.id}`))).map((u) => u.id)).toEqual([b.id]);
    expect((await json<UserJSON[]>(await api("GET", "/v1/users?email_address=b@example.com"))).map((u) => u.id)).toEqual([b.id]);
    expect((await json<UserJSON[]>(await api("GET", "/v1/users?email_address=a@example.com&email_address=c@example.com"))).map((u) => u.id).sort()).toEqual([a.id, c.id].sort());
    expect((await json<UserJSON[]>(await api("GET", "/v1/users?username=alpha"))).map((u) => u.id)).toEqual([a.id]);
    expect((await json<UserJSON[]>(await api("GET", "/v1/users?external_id=ext-b"))).map((u) => u.id)).toEqual([b.id]);
    expect((await json<UserJSON[]>(await api("GET", `/v1/users?user_id=${c.id}`))).map((u) => u.id)).toEqual([c.id]);
    expect((await json<UserJSON[]>(await api("GET", "/v1/users?phone_number=%2B15550000003"))).map((u) => u.id)).toEqual([c.id]);
    expect(await json<UserJSON[]>(await api("GET", "/v1/users?email_address=nobody@example.com"))).toEqual([]);

    const orgId = newId("org");
    ctx.db.insert(s.organizations).values({ id: orgId, name: "Acme" }).run();
    ctx.db.insert(s.organizationMemberships).values({ id: newId(ID_PREFIX.membership), organizationId: orgId, userId: b.id, roleKey: "org:member" }).run();
    expect((await json<UserJSON[]>(await api("GET", `/v1/users?organization_id=${orgId}`))).map((u) => u.id)).toEqual([b.id]);

    expect(await json<UserJSON[]>(await api("GET", "/v1/users?banned=true"))).toEqual([]);
    ctx.raw.prepare("UPDATE users SET last_active_at = 5000").run();
    expect(await json<UserJSON[]>(await api("GET", "/v1/users?last_active_at_since=4000"))).toHaveLength(3);
    expect(await json<UserJSON[]>(await api("GET", "/v1/users?last_active_at_since=6000"))).toEqual([]);
  });

  it("updates profile fields, replaces metadata and deep-merges via the metadata endpoint", async () => {
    const { api } = await testApp();
    const user = await createUser(api, { public_metadata: { tier: "free", nested: { a: 1, b: 2 }, drop: true } });

    const updated = await json<UserJSON>(
      await api("PATCH", `/v1/users/${user.id}`, { first_name: "Grace", username: "grace", public_metadata: { tier: "pro" }, delete_self_enabled: false }),
    );
    expect(updated.first_name).toBe("Grace");
    expect(updated.username).toBe("grace");
    expect(updated.public_metadata).toEqual({ tier: "pro" });
    expect(updated.delete_self_enabled).toBe(false);

    await api("PATCH", `/v1/users/${user.id}/metadata`, { public_metadata: { nested: { a: 1, b: 2 }, drop: true } });
    const merged = await json<UserJSON>(await api("PATCH", `/v1/users/${user.id}/metadata`, { public_metadata: { nested: { b: 3, c: 4 }, drop: null, email: "x" } }));
    expect(merged.public_metadata).toEqual({ tier: "pro", nested: { a: 1, b: 3, c: 4 }, email: "x" });

    expect((await json<UserJSON>(await api("PATCH", `/v1/users/${user.id}`, { username: null }))).username).toBeNull();
    expect((await api("PATCH", `/v1/users/${user.id}`, { primary_email_address_id: "idn_e_nope" })).status).toBe(422);
  });

  it("bans, unbans, locks, unlocks, verifies password and TOTP", async () => {
    const { api, ctx } = await testApp();
    const secret = authenticator.generateSecret();
    const user = await createUser(api, { password: "Sup3r-secret!", totp_secret: secret });
    const { sessionId } = createSessionFixture(ctx, user.id);

    const banned = await json<UserJSON>(await api("POST", `/v1/users/${user.id}/ban`));
    expect(banned.banned).toBe(true);
    const sessionRow = ctx.db.select().from(s.sessions).all().find((row) => row.id === sessionId)!;
    expect(sessionRow.status).toBe("revoked");
    expect((await json<UserJSON[]>(await api("GET", "/v1/users?banned=true"))).map((u) => u.id)).toEqual([user.id]);

    expect((await json<UserJSON>(await api("POST", `/v1/users/${user.id}/unban`))).banned).toBe(false);

    const locked = await json<UserJSON>(await api("POST", `/v1/users/${user.id}/lock`));
    expect(locked.locked).toBe(true);
    expect(locked.lockout_expires_in_seconds).toBeNull();
    expect((await json<UserJSON[]>(await api("GET", "/v1/users?locked=true"))).map((u) => u.id)).toEqual([user.id]);
    expect((await json<UserJSON>(await api("POST", `/v1/users/${user.id}/unlock`))).locked).toBe(false);

    expect((await api("POST", `/v1/users/${user.id}/verify_password`, { password: "Sup3r-secret!" })).status).toBe(200);
    const wrong = await api("POST", `/v1/users/${user.id}/verify_password`, { password: "nope" });
    expect(wrong.status).toBe(422);
    expect((await json<ErrorBody>(wrong)).errors[0]!.code).toBe("form_password_incorrect");

    expect((await api("POST", `/v1/users/${user.id}/verify_totp`, { code: authenticator.generate(secret) })).status).toBe(200);
    const badCode = await api("POST", `/v1/users/${user.id}/verify_totp`, { code: "000000" });
    expect(badCode.status).toBe(422);
    expect((await json<ErrorBody>(badCode)).errors[0]!.code).toBe("form_code_incorrect");

    const reset = await json<UserJSON>(await api("DELETE", `/v1/users/${user.id}/mfa`));
    expect(reset.totp_enabled).toBe(false);
    expect(reset.backup_code_enabled).toBe(false);
    expect((await api("POST", `/v1/users/${user.id}/verify_totp`, { code: "123456" })).status).toBe(422);

    expect((await json<UserJSON>(await api("DELETE", `/v1/users/${user.id}/password`))).password_enabled).toBe(false);
  });

  it("deletes a user and cascades identifiers", async () => {
    const { api } = await testApp();
    const user = await createUser(api, { email_address: ["gone@example.com"] });
    const del = await api("DELETE", `/v1/users/${user.id}`);
    expect(del.status).toBe(200);
    expect(await json<DeletedObjectJSON>(del)).toEqual({ object: "user", id: user.id, deleted: true });
    expect((await api("GET", `/v1/users/${user.id}`)).status).toBe(404);
    expect((await json<PaginatedList<EmailAddressJSON>>(await api("GET", `/v1/email_addresses?user_id=${user.id}`))).data).toEqual([]);
  });

  it("manages email addresses and phone numbers", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api, { email_address: ["first@example.com"] });

    const added = await json<EmailAddressJSON>(await api("POST", "/v1/email_addresses", { user_id: user.id, email_address: "Second@Example.com", verified: true }));
    expect(added.email_address).toBe("second@example.com");
    expect(added.verification?.status).toBe("verified");

    await api("PATCH", `/v1/email_addresses/${added.id}`, { primary: true });
    expect((await json<UserJSON>(await api("GET", `/v1/users/${user.id}`))).primary_email_address_id).toBe(added.id);

    expect((await json<EmailAddressJSON>(await api("PATCH", `/v1/email_addresses/${added.id}`, { verified: false }))).verification?.status).toBe("unverified");
    expect((await api("POST", "/v1/email_addresses", { user_id: user.id, email_address: "first@example.com" })).status).toBe(422);
    expect(await json<DeletedObjectJSON>(await api("DELETE", `/v1/email_addresses/${added.id}`))).toEqual({ object: "email_address", id: added.id, deleted: true });

    // Verifying an address another account already verified is rejected instead of hitting the unique index.
    const clashUser = await createUser(api, { email_address: ["shared@example.com"] });
    ctx.db.insert(s.emailAddresses).values({ id: newId(ID_PREFIX.email), userId: clashUser.id, email: "first@example.com", verified: false }).run();
    const pendingRow = ctx.db.select().from(s.emailAddresses).all().find((row) => row.userId === clashUser.id && row.email === "first@example.com")!;
    expect((await api("PATCH", `/v1/email_addresses/${pendingRow.id}`, { verified: true })).status).toBe(422);

    const phone = await json<PhoneNumberJSON>(await api("POST", "/v1/phone_numbers", { user_id: user.id, phone_number: "+15557654321", primary: true, default_second_factor: true }));
    expect(phone.reserved_for_second_factor).toBe(true);
    expect(phone.default_second_factor).toBe(true);
    const other = await json<PhoneNumberJSON>(await api("POST", "/v1/phone_numbers", { user_id: user.id, phone_number: "+15550001111" }));
    await api("PATCH", `/v1/phone_numbers/${other.id}`, { default_second_factor: true });
    const phones = await json<PaginatedList<PhoneNumberJSON>>(await api("GET", `/v1/phone_numbers?user_id=${user.id}`));
    expect(phones.data.filter((p) => p.default_second_factor)).toHaveLength(1);
    expect(phones.data.find((p) => p.id === phone.id)!.default_second_factor).toBe(false);
    expect(await json<DeletedObjectJSON>(await api("DELETE", `/v1/phone_numbers/${other.id}`))).toEqual({ object: "phone_number", id: other.id, deleted: true });
  });

  it("stores and clears profile images and decrypts external account tokens", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const withImage = await json<UserJSON>(await api("POST", `/v1/users/${user.id}/profile_image`, { file: dataUrl }));
    expect(withImage.has_image).toBe(true);
    expect(withImage.image_url).toBe(dataUrl);

    const cleared = await json<UserJSON>(await api("DELETE", `/v1/users/${user.id}/profile_image`));
    expect(cleared.has_image).toBe(false);
    expect(cleared.image_url).not.toBe(dataUrl);

    ctx.db
      .insert(s.externalAccounts)
      .values({
        id: newId(ID_PREFIX.external),
        userId: user.id,
        provider: "google",
        providerUserId: "google-1",
        emailAddress: "g@example.com",
        approvedScopes: "email profile",
        accessTokenEnc: encrypt(ctx.env.encryptionKey, "tok_live_123"),
        tokenExpiresAt: 999,
      })
      .run();
    const tokens = await json<OAuthTokenRow[]>(await api("GET", `/v1/users/${user.id}/oauth_access_tokens/google`));
    expect(tokens).toEqual([
      { object: "oauth_access_token", external_account_id: expect.any(String), provider: "google", token: "tok_live_123", scopes: "email profile", expires_at: 999 },
    ]);
    expect((await api("GET", `/v1/users/${user.id}/oauth_access_tokens/github`)).status).toBe(404);
  });
});
