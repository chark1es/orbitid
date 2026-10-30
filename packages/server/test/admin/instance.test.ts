import { describe, it, expect, vi, beforeEach } from "vitest";
import { authenticator } from "otplib";
import { ID_PREFIX, type AuditLogJSON, type PaginatedList } from "@orbitid/shared";
import { sha256 } from "../../src/lib/crypto";
import * as s from "../../src/db/schema";
import { newId } from "../../src/lib/ids";
import { createSessionFixture, createUser, json, testApp, type ErrorBody } from "./helpers";

type SendEmail = (ctx: unknown, input: { to: string; template: string; vars: Record<string, unknown> }) => Promise<{ delivered: boolean; error?: { code: string; message: string } }>;
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn<SendEmail>(async () => ({ delivered: true })) }));
vi.mock("../../src/services/mail", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/services/mail")>()),
  sendEmail,
  sendSms: vi.fn(async () => undefined),
}));

beforeEach(() => sendEmail.mockClear());

interface InstanceResponse {
  object: string;
  id: string;
  environment_type: string;
  publishable_key: string;
  application: { name: string; homeUrl: string; allowedOrigins: string[]; allowedRedirectOrigins: string[] };
  email: { from: string; smtpUrl: string; smtpUrlSet: boolean };
  sms: { twilioAuthToken: string; twilioAuthTokenSet: boolean };
  security: { captchaSecret: string; captchaSecretSet: boolean };
  social: Record<string, { enabled: boolean; clientId: string; clientSecret: string; clientSecretSet: boolean }>;
}

interface StatsResponse {
  users_total: number;
  users_active_7d: number;
  sessions_active: number;
  organizations_total: number;
  signups_by_day: { date: string; count: number }[];
  signins_by_day: { date: string; count: number }[];
  banned_users: number;
  locked_users: number;
  mfa_enabled_users: number;
  top_social_providers: { provider: string; count: number }[];
}

const SECRETS = {
  smtp: "smtp://mailer:hunter2@smtp.example.com:587",
  twilio: "twilio-auth-token",
  captcha: "captcha-secret",
  google: "google-client-secret",
};

async function instanceWithSecrets(api: Awaited<ReturnType<typeof testApp>>["api"], ctx: Awaited<ReturnType<typeof testApp>>["ctx"]) {
  await ctx.settings.update({
    application: { name: "Acme Auth", homeUrl: "https://auth.example.com" },
    email: { smtpUrl: SECRETS.smtp },
    sms: { twilioAuthToken: SECRETS.twilio },
    security: { captchaSecret: SECRETS.captcha },
    social: { google: { enabled: true, clientId: "google-client-id", clientSecret: SECRETS.google } },
  });
  return json<InstanceResponse>(await api("GET", "/v1/instance"));
}

describe("instance settings", () => {
  it("masks stored secrets and flags them as set", async () => {
    const { api, ctx } = await testApp();
    const instance = await instanceWithSecrets(api, ctx);
    expect(instance.object).toBe("instance");
    expect(instance.environment_type).toBe("development");
    expect(instance.publishable_key).toBe(ctx.publishableKey);
    expect(instance.application.name).toBe("Acme Auth");

    expect(instance.email).toMatchObject({ smtpUrl: "••••", smtpUrlSet: true });
    expect(instance.sms).toMatchObject({ twilioAuthToken: "••••", twilioAuthTokenSet: true });
    expect(instance.security).toMatchObject({ captchaSecret: "••••", captchaSecretSet: true });
    expect(instance.social.google).toMatchObject({ enabled: true, clientId: "google-client-id", clientSecret: "••••", clientSecretSet: true });
    for (const secret of Object.values(SECRETS)) expect(JSON.stringify(instance)).not.toContain(secret);
  });

  it("keeps secrets when the masked value is sent back and validates URLs", async () => {
    const { api, ctx } = await testApp();
    await instanceWithSecrets(api, ctx);

    const patched = await json<InstanceResponse>(
      await api("PATCH", "/v1/instance", {
        application: { name: "Renamed", allowedOrigins: ["https://app.example.com"] },
        email: { smtpUrl: "••••", smtpUrlSet: true },
        social: { google: { clientSecret: "••••" } },
      }),
    );
    expect(patched.application.name).toBe("Renamed");
    expect(patched.application.allowedOrigins).toEqual(["https://app.example.com"]);
    expect(patched.application.homeUrl).toBe("https://auth.example.com");
    expect(patched.email.smtpUrl).toBe("••••");
    expect(patched.social.google.clientId).toBe("google-client-id");

    const settings = ctx.settings.get();
    expect(settings.email.smtpUrl).toBe(SECRETS.smtp);
    expect(settings.social.google!.clientSecret).toBe(SECRETS.google);

    for (const body of [
      { application: { allowedOrigins: ["not-a-url"] } },
      { application: { homeUrl: "javascript:alert(1)" } },
      { application: { allowedRedirectOrigins: [42] } },
      { password: { minLength: 0 } },
    ]) {
      const res = await api("PATCH", "/v1/instance", body);
      expect(res.status).toBe(422);
    }
    expect(ctx.settings.get().application.homeUrl).toBe("https://auth.example.com");
  });

  it("refuses an organization role setting that names a missing role", async () => {
    const { api } = await testApp();
    // `org:member` / `org:admin` are seeded, so the default round-trip is accepted.
    expect((await api("PATCH", "/v1/instance", { organizations: { creatorRole: "org:admin", defaultRole: "org:member" } })).status).toBe(200);

    for (const field of ["creatorRole", "defaultRole"] as const) {
      const missing = await api("PATCH", "/v1/instance", { organizations: { [field]: "org:nope" } });
      expect(missing.status, field).toBe(422);
      expect((await json<ErrorBody>(missing)).errors[0]!.meta?.param_name).toBe(`organizations.${field}`);
      // An instance role is refused by the pure policy before the database lookup even matters.
      const wrongScope = await api("PATCH", "/v1/instance", { organizations: { [field]: "app:support" } });
      expect(wrongScope.status, field).toBe(422);
      expect((await json<ErrorBody>(wrongScope)).errors[0]!.meta?.param_name).toBe(`organizations.${field}`);
    }
  });

  it("sends a test email and reports a typed failure instead of a false success", async () => {
    const { api, ctx } = await testApp();
    await ctx.settings.update({ application: { supportEmail: "help@example.com" } });
    expect(await json(await api("POST", "/v1/instance/test_email", {}))).toEqual({ status: "ok", to: "help@example.com" });
    expect(sendEmail.mock.calls[0]![1].to).toBe("help@example.com");

    await api("POST", "/v1/instance/test_email", { to: "ops@example.com" });
    expect(sendEmail.mock.calls[1]![1].to).toBe("ops@example.com");

    // When the send reports a failure, the legacy route says so rather than answering "ok".
    sendEmail.mockResolvedValueOnce({ delivered: false, error: { code: "email_not_configured", message: "Email is not configured." } });
    const failed = await api("POST", "/v1/instance/test_email", { to: "ops@example.com" });
    expect(failed.status).toBe(503);
    expect((await json<ErrorBody>(failed)).errors[0]!.code).toBe("email_not_configured");

    // A malformed recipient is a 422 (the documented contract), not a misleading "transport failed" 503.
    sendEmail.mockResolvedValueOnce({ delivered: false, error: { code: "form_param_format_invalid", message: "to must be a valid email address" } });
    const invalid = await api("POST", "/v1/instance/test_email", { to: "ops@example.com" });
    expect(invalid.status).toBe(422);
    expect((await json<ErrorBody>(invalid)).errors[0]!.code).toBe("form_param_format_invalid");
  });

  it("uses the bare From address when no recipient is given", async () => {
    const { api, ctx } = await testApp();
    expect(ctx.settings.get().email.from).toContain("OrbitID");
    const res = await api("POST", "/v1/instance/test_email", {});
    expect(res.status).toBe(200);
    // The header is `OrbitID <no-reply@localhost>`; passing that display-name form to the send path was a 422.
    expect(sendEmail.mock.calls[0]![1].to).toBe("no-reply@localhost");
  });

  it("rotates the instance signing key", async () => {
    const { api, ctx } = await testApp();
    const first = await json<{ object: string; kid: string; algorithm: string; active: boolean }>(await api("POST", "/v1/instance/signing_keys/rotate"));
    expect(first).toMatchObject({ object: "signing_key", algorithm: "RS256", active: true });
    const keys = (await ctx.db.select().from(s.signingKeys));
    expect(keys).toHaveLength(1);
    expect(keys[0]!.kid).toBe(first.kid);
    expect(keys[0]!.publicJwk).toMatchObject({ kty: "RSA" });
    expect(keys[0]!.privateJwkEnc).toMatch(/^v1\./);

    const second = await json<{ kid: string }>(await api("POST", "/v1/instance/signing_keys/rotate"));
    expect(second.kid).not.toBe(first.kid);
    const rotated = (await ctx.db.select().from(s.signingKeys));
    expect(rotated.filter((key) => key.active)).toHaveLength(1);
    expect(rotated.find((key) => key.kid === first.kid)!.active).toBe(false);
  });

  it("issues testing tokens and respects the setting", async () => {
    const { api, ctx } = await testApp();
    const created = await json<{ object: string; token: string; expires_at: number }>(await api("POST", "/v1/testing_tokens"));
    expect(created.object).toBe("testing_token");
    expect(created.token).toMatch(/^tt_/);
    expect(created.expires_at).toBeGreaterThan(Date.now());

    const row = (await ctx.db.select().from(s.verifications)).find((verification) => verification.purpose === "testing_token")!;
    expect(row.tokenHash).toBe(sha256(created.token));

    await ctx.settings.update({ security: { testingTokensEnabled: false } });
    expect((await api("POST", "/v1/testing_tokens")).status).toBe(400);
  });
});

describe("audit logs & stats", () => {
  it("records mutations and filters audit logs", async () => {
    const { api } = await testApp();
    const user = await createUser(api);
    await api("POST", `/v1/users/${user.id}/ban`);

    const logs = await json<PaginatedList<AuditLogJSON>>(await api("GET", "/v1/audit_logs"));
    expect(logs.total_count).toBeGreaterThanOrEqual(2);
    expect(logs.data.every((log) => log.object === "audit_log")).toBe(true);

    const created = await json<PaginatedList<AuditLogJSON>>(await api("GET", "/v1/audit_logs?action=user.created&target_type=user"));
    expect(created.data.map((log) => log.target_id)).toEqual([user.id]);
    expect(created.data[0]!.actor).toBe("secret_key");

    const banned = await json<PaginatedList<AuditLogJSON>>(await api("GET", "/v1/audit_logs?action=user.*"));
    expect(banned.data.map((log) => log.action)).toEqual(expect.arrayContaining(["user.banned", "user.created"]));

    expect((await json<PaginatedList<AuditLogJSON>>(await api("GET", "/v1/audit_logs?limit=1"))).data).toHaveLength(1);
    expect((await json<PaginatedList<AuditLogJSON>>(await api("GET", `/v1/audit_logs?target_id=${user.id}`))).total_count).toBe(2);
  });

  it("aggregates instance statistics", async () => {
    const { api, ctx } = await testApp();
    const active = await createUser(api, { email_address: ["s1@example.com"] });
    const mfaUser = await createUser(api, { email_address: ["s2@example.com"], totp_secret: authenticator.generateSecret() });
    const banned = await createUser(api, { email_address: ["s3@example.com"] });
    const locked = await createUser(api, { email_address: ["s4@example.com"] });
    await api("POST", `/v1/users/${banned.id}/ban`);
    await api("POST", `/v1/users/${locked.id}/lock`);
    await createSessionFixture(ctx, active.id);

    const orgId = newId("org");
    await ctx.db.insert(s.organizations).values({ id: orgId, name: "Acme" });
    for (const [index, provider] of ["google", "google", "github"].entries()) {
      await ctx.db
                        .insert(s.externalAccounts)
                        .values({ id: newId(ID_PREFIX.external), userId: active.id, provider, providerUserId: `${provider}-${index}` });
    }

    const stats = await json<StatsResponse>(await api("GET", "/v1/stats"));
    expect(stats.users_total).toBe(4);
    expect(stats.banned_users).toBe(1);
    expect(stats.locked_users).toBe(1);
    expect(stats.mfa_enabled_users).toBe(1);
    expect(stats.organizations_total).toBe(1);
    expect(stats.sessions_active).toBe(1);
    expect(stats.signups_by_day).toHaveLength(30);
    expect(stats.signups_by_day.reduce((sum, day) => sum + day.count, 0)).toBe(4);
    expect(stats.signins_by_day.reduce((sum, day) => sum + day.count, 0)).toBe(1);
    expect(stats.top_social_providers).toEqual([
      { provider: "google", count: 2 },
      { provider: "github", count: 1 },
    ]);
  });
});
