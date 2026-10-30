// Email settings, the instance test endpoint, template escaping and the "no secret leaves the server" guarantee.
import { readdirSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadEnv } from "../../src/env";
import {
  clearMailOutbox,
  emailStartupWarnings,
  getMailOutbox,
  headerSafe,
  parseEmailFrom,
  parseSmtpUrl,
  resolveEmailTransport,
  sendEmail,
  sendTestEmail,
  setMailTransport,
  setResendEndpointForTests,
} from "../../src/services/mail";
import * as s from "../../src/db/schema";
import { errorsOf } from "./helpers";
import { codeIn, readableMessage, startFakeResend } from "../support/fake-mail";
import { RESEND_KEY, instance } from "./mail-helpers";

afterEach(() => setResendEndpointForTests(null));

describe("email settings", () => {
  it("accepts smtp(s) URLs and rejects anything else", () => {
    expect(parseSmtpUrl("smtp://user:pass@mail.example.com:587")).toMatchObject({ host: "mail.example.com", port: 587, secure: false, user: "user", pass: "pass" });
    expect(parseSmtpUrl("smtps://mail.example.com")).toMatchObject({ port: 465, secure: true });
    expect(parseSmtpUrl("smtp://mail.example.com")).toMatchObject({ port: 587 });
    for (const bad of ["http://mail.example.com", "ftp://mail.example.com", "smtp://", "mail.example.com", "smtp://host:99999", "smtp://host/path", "smtp://host?a=b", "smtp://host\r\nBcc: x@y.z"]) {
      expect(() => parseSmtpUrl(bad), bad).toThrow(/smtp/i);
    }
    try {
      parseSmtpUrl("http://mail.example.com");
    } catch (error) {
      expect((error as { status: number }).status).toBe(422);
    }
  });

  it("validates the From header and refuses line breaks", () => {
    expect(parseEmailFrom("Acme <no-reply@acme.test>")).toEqual({ address: "no-reply@acme.test", value: `"Acme" <no-reply@acme.test>` });
    expect(parseEmailFrom("no-reply@localhost")).toEqual({ address: "no-reply@localhost", value: "no-reply@localhost" });
    for (const bad of ["", "Acme", "a@b.c\r\nBcc: x@y.z", "<>", "Acme <not-an-address>"]) {
      expect(() => parseEmailFrom(bad), bad).toThrow();
    }
    // A display name with a quote cannot break out of the quoted string.
    expect(parseEmailFrom('Ev"il <a@b.co>').value).toBe('"Ev\\"il" <a@b.co>');
    expect(headerSafe("a\r\nBcc: x")).toBe("a Bcc: x");
  });

  it("rejects a bad SMTP URL and a bad From address when settings are saved", async () => {
    const { api, ctx } = await instance();
    const badUrl = await api("PATCH", "/v1/instance", { email: { smtpUrl: "http://mail.example.com" } });
    expect(badUrl.status).toBe(422);
    expect(errorsOf(await badUrl.json())[0]?.meta?.param_name).toBe("email.smtpUrl");
    expect(ctx.settings.get().email.smtpUrl).toBe("");

    const badFrom = await api("PATCH", "/v1/instance", { email: { from: "Acme\r\nBcc: evil@example.com" } });
    expect(badFrom.status).toBe(422);
    expect(errorsOf(await badFrom.json())[0]?.meta?.param_name).toBe("email.from");

    const ok = await api("PATCH", "/v1/instance", { email: { smtpUrl: "smtps://user:pass@mail.example.com:465", from: "Acme <no-reply@acme.test>" } });
    expect(ok.status).toBe(200);
    expect(ctx.settings.get().email.smtpUrl).toBe("smtps://user:pass@mail.example.com:465");
    expect(ctx.settings.get().email.from).toBe("Acme <no-reply@acme.test>");
  });

  it("resolves the provider from settings first and environment second", async () => {
    const { ctx } = await instance();
    expect(resolveEmailTransport(ctx)).toMatchObject({ provider: "console", from: `"OrbitID" <no-reply@localhost>` });

    // Environment fills in only when the setting is empty.
    await ctx.settings.update({ email: { resendApiKey: "re_setting" } });
    const withEnv = { ...ctx, env: { ...ctx.env, resendApiKey: "re_env", smtpUrl: "smtp://env.example.com:587", emailFrom: "Env <env@example.com>" } };
    expect(resolveEmailTransport(withEnv)).toMatchObject({ provider: "resend", resendApiKey: "re_setting", from: `"Env" <env@example.com>` });

    await ctx.settings.update({ email: { resendApiKey: "", smtpUrl: "" } });
    expect(resolveEmailTransport(withEnv)).toMatchObject({ provider: "resend", resendApiKey: "re_env" });
    // Without the key, the SMTP fallback from the environment is used.
    expect(resolveEmailTransport({ ...withEnv, env: { ...withEnv.env, resendApiKey: "" } })).toMatchObject({ provider: "smtp", smtpUrl: "smtp://env.example.com:587" });

    // `auto` prefers Resend, then SMTP, then console.
    await ctx.settings.update({ email: { smtpUrl: "smtp://mail.example.com:587" } });
    expect(resolveEmailTransport(ctx)).toMatchObject({ provider: "smtp", smtpUrl: "smtp://mail.example.com:587" });
    await ctx.settings.update({ email: { resendApiKey: "re_both" } });
    expect(resolveEmailTransport(ctx).provider).toBe("resend");

    // An explicit provider wins over what is configured.
    await ctx.settings.update({ email: { provider: "console" } });
    expect(resolveEmailTransport(ctx).provider).toBe("console");
    // Naming a provider without its credential is refused at save time (the server could never deliver).
    await expect(ctx.settings.update({ email: { provider: "smtp", smtpUrl: "" } })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.settings.update({ email: { provider: "resend", resendApiKey: "" } })).rejects.toMatchObject({ status: 422 });
    expect(ctx.settings.get().email.provider).toBe("console");
    // The resolver still reports the same problem for a tree an older version stored.
    expect(() => resolveEmailTransport({ ...ctx, settings: { get: () => ({ ...ctx.settings.get(), email: { ...ctx.settings.get().email, provider: "smtp", smtpUrl: "" } }) } } as typeof ctx)).toThrow(/smtp/i);
    expect(() => resolveEmailTransport({ ...ctx, settings: { get: () => ({ ...ctx.settings.get(), email: { ...ctx.settings.get().email, provider: "resend", resendApiKey: "" } }) } } as typeof ctx)).toThrow(/API key/i);
  });

  it("reads the email fallbacks from the environment", () => {
    const previous = { key: process.env.ORBITID_RESEND_API_KEY, smtp: process.env.ORBITID_SMTP_URL, from: process.env.ORBITID_EMAIL_FROM };
    process.env.ORBITID_RESEND_API_KEY = "re_from_env";
    process.env.ORBITID_SMTP_URL = "smtp://env.example.com:587";
    process.env.ORBITID_EMAIL_FROM = "Env <env@example.com>";
    try {
      const env = loadEnv({ databaseUrl: ":memory:" });
      expect(env).toMatchObject({ resendApiKey: "re_from_env", smtpUrl: "smtp://env.example.com:587", emailFrom: "Env <env@example.com>" });
      // Explicit overrides still win.
      expect(loadEnv({ databaseUrl: ":memory:", resendApiKey: "re_override" }).resendApiKey).toBe("re_override");
    } finally {
      for (const [name, value] of [["ORBITID_RESEND_API_KEY", previous.key], ["ORBITID_SMTP_URL", previous.smtp], ["ORBITID_EMAIL_FROM", previous.from]] as const) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("never prints or persists a sign-in code when no provider is configured", async () => {
    // A development instance is the interesting case: it is where a "helpful" console transport used to exist.
    const development = await instance({ nodeEnv: "development" });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const dir = readdirSync(development.ctx.env.dataDir, { recursive: true }).length;

    await sendEmail(development.ctx, { to: "ada@example.com", template: "verification_code", vars: { code: "424242" } });
    expect(log.mock.calls.flat().join("\n")).not.toContain("424242");
    // Nothing was written either: a plaintext code on disk is the same leak with a longer half-life.
    expect(readdirSync(development.ctx.env.dataDir, { recursive: true }).length).toBe(dir);
    await expect(sendTestEmail(development.ctx, "ada@example.com")).rejects.toMatchObject({ code: "email_not_configured" });
    log.mockRestore();
  });

  it("warns in production and development when no provider is configured", async () => {
    const production = await instance({ nodeEnv: "production", secretKey: "sk_test_production_0123456789abcdef", encryptionKey: "k".repeat(40), baseUrl: "https://auth.example.com" });
    const warning = emailStartupWarnings(production.ctx).join("\n");
    expect(warning).toContain("EMAIL IS NOT CONFIGURED");
    expect(warning).toContain("ORBITID_RESEND_API_KEY");
    expect(warning).toContain("ORBITID_SMTP_URL");
    expect(warning).toContain("docs/EMAIL.md");
    // There is no opt-in that turns the log into a delivery channel any more.
    expect(warning).not.toContain("PRINTED");

    const development = await instance({ nodeEnv: "development" });
    expect(emailStartupWarnings(development.ctx).join("\n")).toContain("EMAIL IS NOT CONFIGURED");

    await production.ctx.settings.update({ email: { provider: "smtp", smtpUrl: "smtps://user:secret-pass@mail.example.com:465" } });
    const smtpLine = emailStartupWarnings(production.ctx).join("\n");
    expect(smtpLine).toContain("mail.example.com");
    expect(smtpLine).not.toContain("secret-pass");
  });

  it("refuses the test-only capture seams outside the test environment", async () => {
    const development = await instance({ nodeEnv: "development" });
    const saved = { vitest: process.env.VITEST, nodeEnv: process.env.NODE_ENV };
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    try {
      expect(() => getMailOutbox()).toThrow(/only available in tests/);
      expect(() => setMailTransport(async () => undefined)).toThrow(/only available in tests/);
      expect(() => clearMailOutbox()).toThrow(/only available in tests/);
    } finally {
      if (saved.vitest !== undefined) process.env.VITEST = saved.vitest;
      if (saved.nodeEnv !== undefined) process.env.NODE_ENV = saved.nodeEnv;
      else delete process.env.NODE_ENV;
    }
    expect(development.ctx.env.nodeEnv).toBe("development");
  });
});

describe("no secret leaves the server", () => {
  it("never puts a code or link in a log line or in the email.created event", async () => {
    const resend = await startFakeResend();
    setResendEndpointForTests(resend.url);
    const { ctx, api } = await instance();
    await ctx.settings.update({ email: { provider: "resend", resendApiKey: RESEND_KEY, from: "no-reply@acme.test" } });
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      // Every endpoint the server has configured receives the event; capturing it is how we read what went out.
      const endpoint = await api("POST", "/v1/webhooks/endpoints", { url: "https://hooks.example.test/orbitid" });
      expect(endpoint.status).toBe(200);
      await sendEmail(ctx, { to: "quiet@example.com", template: "verification_code", vars: { code: "918273" } });

      const code = codeIn(readableMessage(resend.last()!.body.text ?? ""))!;
      expect(resend.last()!.body.subject).toContain(code);
      const written = [...log.mock.calls, ...error.mock.calls].flat().join("\n");
      expect(written).not.toContain(code);
      // The webhook event names the template and the recipient, not the subject (which for a code template is the code).
      const events = await ctx.db.select().from(s.webhookEvents);
      const payload = JSON.stringify(events);
      expect(payload).toContain("verification_code");
      expect(payload).not.toContain(code);
    } finally {
      log.mockRestore();
      error.mockRestore();
      await resend.close();
    }
  });
});

describe("email templates", () => {
  it("escapes variables and only links absolute http(s) URLs", async () => {
    const { ctx } = await instance();
    await sendEmail(ctx, {
      to: "template@example.com",
      template: "organization_invitation",
      vars: { invitation_url: "javascript:alert(1)", organization_name: "<img src=x onerror=alert(1)>", inviter_name: "A&B" },
    });
    const email = getMailOutbox().at(-1)!;
    expect(email.html).not.toContain("javascript:alert(1)");
    expect(email.html).not.toContain("<img src=x");
    expect(email.html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(email.html).toContain("A&amp;B");
    // The subject is a header, not HTML: it keeps the text but can never contain a line break.
    expect(email.subject).toBe("Join <img src=x onerror=alert(1)> on OrbitID App");

    await sendEmail(ctx, { to: "template@example.com", template: "magic_link", vars: { link: "https://auth.example.com/v1/verify?token=abc" } });
    const linkEmail = getMailOutbox().at(-1)!;
    expect(linkEmail.html).toContain('href="https://auth.example.com/v1/verify?token=abc"');
  });
});

describe("POST /v1/instance/email_test", () => {
  it("sends through the resolved transport and reports the provider", async () => {
    const resend = await startFakeResend();
    setResendEndpointForTests(resend.url);
    const { ctx, api } = await instance();
    await ctx.settings.update({ email: { provider: "resend", resendApiKey: RESEND_KEY, from: "no-reply@acme.test" } });

    const res = await api("POST", "/v1/instance/email_test", { to: "ops@example.com" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ provider: "resend", ok: true });
    expect(resend.last()!.body.subject).toContain("test email");

    // `console` is the "no provider configured" value: the test reports it instead of claiming delivery.
    await ctx.settings.update({ email: { provider: "console" } });
    const consoleRes = await api("POST", "/v1/instance/email_test", { to: "ops@example.com" });
    expect(consoleRes.status).toBe(503);
    expect((await consoleRes.json() as { errors: { code: string }[] }).errors[0]!.code).toBe("email_not_configured");
    await resend.close();
  });

  it("requires a secret key, a valid body and is rate limited", async () => {
    const { app, api } = await instance();
    const unauthenticated = await app.request("/v1/instance/email_test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ to: "ops@example.com" }),
    });
    expect(unauthenticated.status).toBe(401);

    expect((await api("POST", "/v1/instance/email_test", {})).status).toBe(422);

    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await api("POST", "/v1/instance/email_test", { to: "ops@example.com" })).status);
    expect(statuses.filter((s) => s === 429).length).toBeGreaterThan(0);
  });
});
