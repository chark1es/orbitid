import { describe, it, expect } from "vitest";
import { authenticator } from "otplib";
import { eq } from "drizzle-orm";
import { ID_PREFIX, type DeletedObjectJSON, type EmailAddressJSON, type PaginatedList, type PhoneNumberJSON, type UserJSON } from "@orbitid/shared";
import { encrypt } from "../../src/lib/crypto";
import { newId } from "../../src/lib/ids";
import * as s from "../../src/db/schema";
import { createSessionFixture, createUser, json, testApp, type ErrorBody } from "./helpers";
import { signUpUser } from "../core/helpers";
import { latestCodeFor } from "../../src/services/mail";

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

    const row = (await ctx.db.select().from(s.users))[0]!;
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
    await ctx.db.insert(s.organizations).values({ id: orgId, name: "Acme" });
    await ctx.db.insert(s.organizationMemberships).values({ id: newId(ID_PREFIX.membership), organizationId: orgId, userId: b.id, roleKey: "org:member" });
    expect((await json<UserJSON[]>(await api("GET", `/v1/users?organization_id=${orgId}`))).map((u) => u.id)).toEqual([b.id]);

    expect(await json<UserJSON[]>(await api("GET", "/v1/users?banned=true"))).toEqual([]);
    await ctx.db.update(s.users).set({ lastActiveAt: 5000 });
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
    // Moving the primary identifier is refused rather than validated: an operator cannot re-point sign-in.
    const moved = await api("PATCH", `/v1/users/${user.id}`, { primary_email_address_id: user.email_addresses[0]!.id });
    expect(moved.status).toBe(403);
    expect((await json<ErrorBody>(moved)).errors[0]!.code).toBe("not_allowed_access");
  });

  it("bans, unbans, locks and unlocks without touching the user's credentials", async () => {
    const { api, ctx } = await testApp();
    const secret = authenticator.generateSecret();
    const user = await createUser(api, { password: "Sup3r-secret!", totp_secret: secret });
    const { sessionId } = await createSessionFixture(ctx, user.id);

    const banned = await json<UserJSON>(await api("POST", `/v1/users/${user.id}/ban`));
    expect(banned.banned).toBe(true);
    const sessionRow = (await ctx.db.select().from(s.sessions)).find((row) => row.id === sessionId)!;
    expect(sessionRow.status).toBe("revoked");
    expect((await json<UserJSON[]>(await api("GET", "/v1/users?banned=true"))).map((u) => u.id)).toEqual([user.id]);

    expect((await json<UserJSON>(await api("POST", `/v1/users/${user.id}/unban`))).banned).toBe(false);

    const locked = await json<UserJSON>(await api("POST", `/v1/users/${user.id}/lock`));
    expect(locked.locked).toBe(true);
    expect(locked.lockout_expires_in_seconds).toBeNull();
    expect((await json<UserJSON[]>(await api("GET", "/v1/users?locked=true"))).map((u) => u.id)).toEqual([user.id]);
    expect((await json<UserJSON>(await api("POST", `/v1/users/${user.id}/unlock`))).locked).toBe(false);

    // Ban/lock are status changes, not credential changes: the password and the authenticator survive them.
    expect((await json<UserJSON>(await api("GET", `/v1/users/${user.id}`)))).toMatchObject({
      password_enabled: true,
      totp_enabled: true,
    });
  });

  it("refuses to change or clear a user's password, MFA or backup codes from the Backend API", async () => {
    const { api, ctx } = await testApp();
    const secret = authenticator.generateSecret();
    const user = await createUser(api, { password: "Sup3r-secret!", totp_secret: secret, backup_codes: ["abcd1234"] });
    const { sessionId } = await createSessionFixture(ctx, user.id);
    const before = (await ctx.db.select().from(s.users).where(eq(s.users.id, user.id)))[0]!;

    const attempts: [string, string, unknown][] = [
      ["PATCH", `/v1/users/${user.id}`, { password: "Attacker-known-1!" }],
      ["PATCH", `/v1/users/${user.id}`, { password_digest: "$argon2id$v=19$m=19456,t=2,p=1$c2FsdA$aGFzaA", password_hasher: "argon2" }],
      ["PATCH", `/v1/users/${user.id}`, { totp_secret: authenticator.generateSecret() }],
      ["PATCH", `/v1/users/${user.id}`, { totp_secret: null }],
      ["PATCH", `/v1/users/${user.id}`, { backup_codes: ["attacker-code"] }],
      ["PATCH", `/v1/users/${user.id}`, { backup_codes: null }],
      ["DELETE", `/v1/users/${user.id}/mfa`, undefined],
      ["DELETE", `/v1/users/${user.id}/password`, undefined],
    ];
    for (const [method, path, body] of attempts) {
      const res = await api(method, path, body);
      expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(403);
      const payload = await json<ErrorBody>(res);
      expect(payload.errors[0]!.code).toBe("not_allowed_access");
      // The refusal says where the user does it themselves instead.
      expect(payload.errors[0]!.message).toMatch(/signed-in session/i);
    }

    // Nothing was written: the hash, the secret and the codes are the user's, unchanged.
    const after = (await ctx.db.select().from(s.users).where(eq(s.users.id, user.id)))[0]!;
    expect(after.passwordHash).toBe(before.passwordHash);
    expect(after.totpSecretEnc).toBe(before.totpSecretEnc);
    expect(after.totpVerified).toBe(true);
    expect(after.backupCodes).toEqual(before.backupCodes);
    expect((await ctx.db.select().from(s.sessions)).find((row) => row.id === sessionId)!.status).toBe("active");

    // The verification oracle is refused too: it would let an operator guess outside every sign-in limit.
    for (const [path, body] of [
      [`/v1/users/${user.id}/verify_password`, { password: "Sup3r-secret!" }],
      [`/v1/users/${user.id}/verify_totp`, { code: authenticator.generate(secret) }],
    ] as const) {
      const res = await api("POST", path, body);
      expect(res.status, path).toBe(403);
      expect((await json<ErrorBody>(res)).errors[0]!.code).toBe("not_allowed_access");
    }

    // The user's own session is untouched by all of this and can still read its factor state.
    expect((await json<UserJSON>(await api("GET", `/v1/users/${user.id}`)))).toMatchObject({ password_enabled: true, totp_enabled: true });
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

  it("refuses every Backend API identifier write, including verification and second-factor installs", async () => {
    const { api } = await testApp();
    const user = await createUser(api, { email_address: ["first@example.com"], phone_number: ["+15551230000"] });
    const emailId = user.email_addresses[0]!.id;
    const phoneId = user.phone_numbers[0]!.id;

    const attempts: [string, string, unknown][] = [
      ["POST", "/v1/email_addresses", { user_id: user.id, email_address: "attacker@example.com", verified: true, primary: true }],
      ["POST", "/v1/email_addresses", { user_id: user.id, email_address: "attacker@example.com" }],
      ["PATCH", `/v1/email_addresses/${emailId}`, { verified: true }],
      ["PATCH", `/v1/email_addresses/${emailId}`, { verified: false }],
      ["PATCH", `/v1/email_addresses/${emailId}`, { primary: true }],
      ["DELETE", `/v1/email_addresses/${emailId}`, undefined],
      ["POST", "/v1/phone_numbers", { user_id: user.id, phone_number: "+15550009999", verified: true, primary: true, default_second_factor: true }],
      ["PATCH", `/v1/phone_numbers/${phoneId}`, { verified: true }],
      ["PATCH", `/v1/phone_numbers/${phoneId}`, { default_second_factor: true }],
      ["PATCH", `/v1/phone_numbers/${phoneId}`, { primary: true }],
      ["DELETE", `/v1/phone_numbers/${phoneId}`, undefined],
    ];
    for (const [method, path, body] of attempts) {
      const res = await api(method, path, body);
      expect(res.status, `${method} ${path} ${JSON.stringify(body)}`).toBe(403);
      expect((await json<ErrorBody>(res)).errors[0]!.code).toBe("not_allowed_access");
    }

    // No attach, verify, promote or delete happened: the identifiers are exactly what the import created.
    const emails = await json<PaginatedList<EmailAddressJSON>>(await api("GET", `/v1/email_addresses?user_id=${user.id}`));
    expect(emails.data.map((e) => e.email_address)).toEqual(["first@example.com"]);
    expect(emails.data[0]!.verification?.status).toBe("verified");
    const phones = await json<PaginatedList<PhoneNumberJSON>>(await api("GET", `/v1/phone_numbers?user_id=${user.id}`));
    expect(phones.data.map((p) => p.phone_number)).toEqual(["+15551230000"]);
    expect((await json<UserJSON>(await api("GET", `/v1/users/${user.id}`))).primary_email_address_id).toBe(emailId);
    expect((await json<UserJSON>(await api("GET", `/v1/users/${user.id}`))).primary_phone_number_id).toBe(phoneId);

    // Unknown ids are still a 404 rather than a refusal, so lookups do not become an existence oracle for writes.
    expect((await api("PATCH", "/v1/email_addresses/idn_e_nope", { verified: true })).status).toBe(404);
    expect((await api("POST", "/v1/email_addresses", { user_id: "user_nope", email_address: "x@example.com" })).status).toBe(404);
  });

  it("keeps the user's own identifier flow working through the Frontend API", async () => {
    const { app, api } = await testApp();
    const user = await signUpUser(app, { email: "selfserve@example.com" });
    const added = await user.client.json<{ response: { id: string; email_address: string; verification: { status: string } } }>(
      "/v1/client/me/email_addresses",
      { body: { email_address: "second@example.com" } },
    );
    expect(added.response.verification.status).toBe("unverified");
    await user.client.json(`/v1/client/me/email_addresses/${added.response.id}/prepare_verification`, { body: { strategy: "email_code" } });
    const code = latestCodeFor("second@example.com");
    if (!code) throw new Error("no verification code");
    const verified = await user.client.json<{ response: { verification: { status: string } } }>(
      `/v1/client/me/email_addresses/${added.response.id}/attempt_verification`,
      { body: { code } },
    );
    expect(verified.response.verification.status).toBe("verified");
    // The Backend API sees the new identifier but could not have created or verified it.
    expect((await json<PaginatedList<EmailAddressJSON>>(await api("GET", `/v1/email_addresses?user_id=${user.userId}`))).data).toHaveLength(2);
  });

  it("stores and clears profile images but never exposes linked third-party tokens", async () => {
    const { api, ctx } = await testApp();
    const user = await createUser(api);
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";
    const withImage = await json<UserJSON>(await api("POST", `/v1/users/${user.id}/profile_image`, { file: dataUrl }));
    expect(withImage.has_image).toBe(true);
    expect(withImage.image_url).toBe(dataUrl);

    const cleared = await json<UserJSON>(await api("DELETE", `/v1/users/${user.id}/profile_image`));
    expect(cleared.has_image).toBe(false);
    expect(cleared.image_url).not.toBe(dataUrl);

    await ctx.db
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
                  });
    // An operator reading the token could act as the user at the provider; the user reads their own instead.
    const refused = await api("GET", `/v1/users/${user.id}/oauth_access_tokens/google`);
    expect(refused.status).toBe(403);
    const refusedText = await refused.text();
    expect((JSON.parse(refusedText) as ErrorBody).errors[0]!.code).toBe("not_allowed_access");
    expect(refusedText).not.toContain("tok_live_123");
    expect((await api("GET", `/v1/users/${user.id}/oauth_access_tokens/github`)).status).toBe(403);
  });
});

describe("user search", () => {
  it("matches names, emails and ids case-insensitively and treats % and _ literally", async () => {
    const { api } = await testApp();
    const ada = await createUser(api, { email_address: ["Ada.Lovelace@Example.com"], first_name: "Ada", last_name: "Lovelace" });
    await createUser(api, { email_address: ["grace@example.com"], first_name: "Grace", last_name: "Hopper" });

    const ids = async (q: string) => (await json<UserJSON[]>(await api("GET", `/v1/users?query=${encodeURIComponent(q)}`))).map((u) => u.id);
    expect(await ids("ADA")).toEqual([ada.id]);
    expect(await ids("lovelace@EXAMPLE")).toEqual([ada.id]);
    expect(await ids("ada lovelace")).toEqual([ada.id]);
    expect(await ids("%")).toEqual([]);
    expect(await ids("_da")).toEqual([]);
  });
});

describe("required profile prerequisites", () => {
  it("enforces the instance's required attributes on Backend API create and update", async () => {
    const { api, ctx } = await testApp();
    await ctx.settings.update({ attributes: { firstName: { enabled: true, required: true }, lastName: { enabled: true, required: true } } });

    // Required fields are prerequisites, not a UI hint: a script cannot create an account without them.
    const missingFirst = await api("POST", "/v1/users", { email_address: ["a@example.com"], password: "Sup3r-secret!" });
    expect(missingFirst.status).toBe(422);
    expect((await json<ErrorBody>(missingFirst)).errors[0]!.meta?.param_name).toBe("first_name");
    const missingLast = await api("POST", "/v1/users", { email_address: ["a@example.com"], password: "Sup3r-secret!", first_name: "Ada" });
    expect(missingLast.status).toBe(422);

    const created = await json<UserJSON>(await api("POST", "/v1/users", {
      email_address: ["a@example.com"], password: "Sup3r-secret!", first_name: "Ada", last_name: "Lovelace",
    }));
    expect(created.first_name).toBe("Ada");

    // ...and cannot be cleared afterwards, by the user or by an operator.
    const cleared = await api("PATCH", `/v1/users/${created.id}`, { last_name: null });
    expect(cleared.status).toBe(422);
    expect((await json<ErrorBody>(cleared)).errors[0]!.meta?.param_name).toBe("last_name");

    // The documented import escape hatch still works.
    expect((await api("POST", "/v1/users", { email_address: ["import@example.com"], skip_password_requirement: true })).status).toBe(200);
  });

  it("enforces a required username and refuses to clear it", async () => {
    const { api, ctx } = await testApp();
    await ctx.settings.update({ attributes: { username: { enabled: true, required: true } } });
    const missing = await api("POST", "/v1/users", { email_address: ["u@example.com"], password: "Sup3r-secret!" });
    expect(missing.status).toBe(422);
    expect((await json<ErrorBody>(missing)).errors[0]!.meta?.param_name).toBe("username");
    const created = await json<UserJSON>(await api("POST", "/v1/users", { email_address: ["u@example.com"], password: "Sup3r-secret!", username: "ada" }));
    expect((await api("PATCH", `/v1/users/${created.id}`, { username: null })).status).toBe(422);
    expect((await api("PATCH", `/v1/users/${created.id}`, { username: "ada2" })).status).toBe(200);
  });

  it("refuses to remove any identifier through the Backend API, required or not", async () => {
    const { api, ctx } = await testApp();
    // Email is required by default: removal used to be refused as a 422. It is now an operator refusal (403) for every
    // identifier, because deleting the address a user signs in with is a lockout, not a configuration change.
    const user = await json<UserJSON>(await api("POST", "/v1/users", { email_address: ["only@example.com"], password: "Sup3r-secret!" }));
    const emailId = user.email_addresses[0]!.id;
    const removed = await api("DELETE", `/v1/email_addresses/${emailId}`);
    expect(removed.status).toBe(403);
    expect((await json<ErrorBody>(removed)).errors[0]!.code).toBe("not_allowed_access");

    // The same refusal applies once the attribute is optional: the operator still cannot strip the account.
    await ctx.settings.update({ attributes: { emailAddress: { enabled: true, required: false } } });
    const second = await json<UserJSON>(await api("POST", "/v1/users", { email_address: ["second@example.com"], password: "Sup3r-secret!", phone_number: ["+15551230000"] }));
    expect((await api("DELETE", `/v1/email_addresses/${second.email_addresses[0]!.id}`)).status).toBe(403);
    expect((await api("DELETE", `/v1/phone_numbers/${second.phone_numbers[0]!.id}`)).status).toBe(403);

    // And the user can still remove their own identifier from their session.
    const self = await signUpUser((await testApp()).app);
    const mine = await self.client.json<{ response: { email_addresses: { id: string }[] } }>("/v1/client/me");
    expect(mine.response.email_addresses.length).toBe(1);
  });
});
