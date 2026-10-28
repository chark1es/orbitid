import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../../src/app";
import { createContext } from "../../src/bootstrap";
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
  setResendEndpointForTests,
} from "../../src/services/mail";
import { errorsOf, testClient } from "./helpers";
import { codeIn, linkIn, rawHeaders, readableMessage, startFakeResend, startFakeSmtp } from "../support/fake-mail";

const SECRET = "sk_test_testsecret";
const RESEND_KEY = "re_live_test_key_do_not_leak";

afterEach(() => setResendEndpointForTests(null));

async function instance(overrides: Parameters<typeof createContext>[0] = {}) {
  const ctx = await createContext({
    databaseUrl: ":memory:",
    secretKey: SECRET,
    baseUrl: "http://localhost:4000",
    nodeEnv: "test",
    ...overrides,
  });
  clearMailOutbox();
  const app = createApp(ctx);
  const api = (method: string, path: string, body?: unknown) =>
    app.request(path, {
      method,
      headers: { authorization: `Bearer ${SECRET}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  return { ctx, app, api };
}

/** Verified user created through the Backend API, so sign-in flows do not need an email first. */
async function verifiedUser(api: (method: string, path: string, body?: unknown) => Response | Promise<Response>, email: string) {
  const res = await api("POST", "/v1/users", { email_address: [email], password: "Sup3rSecret!" });
  if (res.status !== 200) throw new Error(`create user failed: ${res.status} ${await res.text()}`);
  return (await res.json()) as { id: string; email_addresses: { email_address: string; id: string }[] };
}

/** Runs an `email_code` first-factor sign-in and returns the completed session, using `readCode` for the delivered code. */
async function signInWithEmailCode(app: ReturnType<typeof createApp>, email: string, readCode: () => string) {
  const client = testClient(app);
  const created = await client.json<{ response: { id: string; status: string } }>("/v1/client/sign_ins", { body: { identifier: email } });
  expect(created.response.status).toBe("needs_first_factor");
  await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_code" } });
  const code = readCode();
  expect(code).toMatch(/^\d{6}$/);
  const done = await client.json<{ response: { status: string; created_session_id: string } }>(
    `/v1/client/sign_ins/${created.response.id}/attempt_first_factor`,
    { body: { strategy: "email_code", code } },
  );
  expect(done.response.status).toBe("complete");
  return done.response.created_session_id;
}

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
    await ctx.settings.update({ email: { provider: "smtp", smtpUrl: "" } });
    expect(() => resolveEmailTransport(ctx)).toThrow(/smtp/i);
    await ctx.settings.update({ email: { provider: "resend", resendApiKey: "" } });
    expect(() => resolveEmailTransport(ctx)).toThrow(/API key/i);
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

  it("warns loudly in production when mail goes to the console", async () => {
    const production = await instance({ nodeEnv: "production", encryptionKey: "k".repeat(40), baseUrl: "https://auth.example.com" });
    const warning = emailStartupWarnings(production.ctx).join("\n");
    expect(warning).toContain("EMAIL IS PRINTED TO THIS LOG");
    expect(warning).toContain("Sign-in codes");
    expect(warning).toContain("ORBITID_RESEND_API_KEY");
    expect(warning).toContain("ORBITID_SMTP_URL");
    expect(warning).toContain("docs/EMAIL.md");

    const development = await instance({ nodeEnv: "development" });
    expect(emailStartupWarnings(development.ctx).join("\n")).toContain("console");
    expect(emailStartupWarnings(development.ctx).join("\n")).not.toContain("!!");

    await production.ctx.settings.update({ email: { provider: "smtp", smtpUrl: "smtps://user:secret-pass@mail.example.com:465" } });
    const smtpLine = emailStartupWarnings(production.ctx).join("\n");
    expect(smtpLine).toContain("mail.example.com");
    expect(smtpLine).not.toContain("secret-pass");
  });
});

describe("Resend transport", () => {
  it("delivers a sign-in code through Resend and the code completes sign-in", async () => {
    const resend = await startFakeResend();
    setResendEndpointForTests(resend.url);
    const { ctx, app, api } = await instance();
    await ctx.settings.update({ email: { provider: "resend", resendApiKey: RESEND_KEY, from: "Acme <no-reply@acme.test>" } });
    await verifiedUser(api, "resend-code@example.com");

    await signInWithEmailCode(app, "resend-code@example.com", () => codeIn(readableMessage(resend.requests.find((r) => /verification code$/.test(r.body.subject ?? ""))!.body.text ?? ""))!);

    // The new-sign-in notification arrives after the code, so pick the code email by its subject.
    const codeRequest = resend.requests.find((r) => /verification code$/.test(r.body.subject ?? ""));
    const code = codeIn(readableMessage(codeRequest!.body.text ?? ""))!;
    expect(codeRequest!.authorization).toBe(`Bearer ${RESEND_KEY}`);
    expect(codeRequest!.contentType).toContain("application/json");
    expect(codeRequest!.body.from).toBe(`"Acme" <no-reply@acme.test>`);
    expect(codeRequest!.body.to).toBe("resend-code@example.com");
    expect(codeRequest!.body.subject).toBe(`${code} is your OrbitID App verification code`);
    expect(codeRequest!.body.html).toContain(code);
    expect(codeRequest!.body.text).toContain(code);
    await resend.close();
  });

  it("delivers a magic link through Resend and the link completes sign-in", async () => {
    const resend = await startFakeResend();
    setResendEndpointForTests(resend.url);
    const { ctx, app, api } = await instance();
    await ctx.settings.update({ email: { provider: "resend", resendApiKey: RESEND_KEY, from: "no-reply@acme.test" } });
    await verifiedUser(api, "resend-link@example.com");

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: "resend-link@example.com", strategy: "email_link" },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_link" } });

    const link = linkIn(readableMessage(resend.last()!.body.text ?? ""))!;
    expect(link).toContain("/v1/verify?token=");
    const landing = await app.request(link, { redirect: "manual" });
    expect(landing.status).toBe(302);
    expect(landing.headers.get("location")).toContain("__orbit_status=verified");
    const done = await client.json<{ response: { status: string; created_session_id: string } }>(`/v1/client/sign_ins/${created.response.id}`);
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);
    await resend.close();
  });

  it("verifies a sign-up email through Resend", async () => {
    const resend = await startFakeResend();
    setResendEndpointForTests(resend.url);
    const { ctx, app } = await instance();
    await ctx.settings.update({ email: { provider: "resend", resendApiKey: RESEND_KEY, from: "Acme <no-reply@acme.test>" } });

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ups", {
      body: { email_address: "resend-signup@example.com", password: "Sup3rSecret!" },
    });
    await client.json(`/v1/client/sign_ups/${created.response.id}/prepare_verification`, { body: { strategy: "email_code" } });
    const code = codeIn(readableMessage(resend.last()!.body.text ?? ""))!;
    const done = await client.json<{ response: { status: string; created_session_id: string } }>(
      `/v1/client/sign_ups/${created.response.id}/attempt_verification`,
      { body: { strategy: "email_code", code } },
    );
    expect(done.response.status).toBe("complete");
    expect(done.response.created_session_id).toMatch(/^sess_/);
    await resend.close();
  });

  it("reports a safe error without the API key and with the body truncated", async () => {
    const longBody = `${RESEND_KEY} ${"x".repeat(400)}`;
    const resend = await startFakeResend({ status: 500, responseBody: `{"message":"boom ${longBody}"}` });
    setResendEndpointForTests(resend.url);
    const { ctx, api } = await instance();
    await ctx.settings.update({ email: { provider: "resend", resendApiKey: RESEND_KEY, from: "no-reply@acme.test" } });

    const res = await api("POST", "/v1/instance/email_test", { to: "ops@example.com" });
    expect(res.status).toBe(502);
    const body = (await res.json()) as { errors: { code: string; message: string }[] };
    expect(body.errors[0]!.code).toBe("email_delivery_failed");
    expect(body.errors[0]!.message).not.toContain(RESEND_KEY);
    expect(body.errors[0]!.message).toContain("[redacted]");
    // Everything after the fixed prefix is capped at 300 characters of provider text.
    expect(body.errors[0]!.message.length).toBeLessThan(360);
    await resend.close();
  });
});

describe("SMTP transport", () => {
  it("delivers a sign-in code with intact headers and the code completes sign-in", async () => {
    const smtp = await startFakeSmtp();
    const { ctx, app, api } = await instance();
    await ctx.settings.update({ email: { provider: "smtp", smtpUrl: smtp.url, from: "Acme <no-reply@acme.test>" } });
    await verifiedUser(api, "smtp-code@example.com");

    const codeMessage = () =>
      smtp.messages.find((m) => /verification code/.test(rawHeaders(m.raw).find((h) => h.name.toLowerCase() === "subject")?.value ?? ""))!;
    await signInWithEmailCode(app, "smtp-code@example.com", () => codeIn(readableMessage(codeMessage().raw))!);

    const message = codeMessage();
    expect(message.recipients).toEqual(["smtp-code@example.com"]);
    expect(message.mailFrom).toBe("no-reply@acme.test");
    const headers = rawHeaders(message.raw);
    expect(headers.filter((h) => h.name.toLowerCase() === "from")).toHaveLength(1);
    expect(headers.filter((h) => h.name.toLowerCase() === "to")).toHaveLength(1);
    expect(headers.filter((h) => h.name.toLowerCase() === "subject")).toHaveLength(1);
    expect(headers.find((h) => h.name.toLowerCase() === "from")!.value).toContain("no-reply@acme.test");
    expect(headers.find((h) => h.name.toLowerCase() === "subject")!.value).toMatch(/^\d{6} is your .* verification code$/);
    await smtp.close();
  });

  it("delivers a magic link that completes sign-in, and rejects a bad scheme", async () => {
    const smtp = await startFakeSmtp();
    const { ctx, app, api } = await instance();
    await ctx.settings.update({ email: { provider: "smtp", smtpUrl: smtp.url, from: "no-reply@acme.test" } });
    await verifiedUser(api, "smtp-link@example.com");

    const client = testClient(app);
    const created = await client.json<{ response: { id: string } }>("/v1/client/sign_ins", {
      body: { identifier: "smtp-link@example.com", strategy: "email_link" },
    });
    await client.json(`/v1/client/sign_ins/${created.response.id}/prepare_first_factor`, { body: { strategy: "email_link" } });
    const link = linkIn(readableMessage(smtp.last()!.raw))!;
    const landing = await app.request(link, { redirect: "manual" });
    expect(landing.status).toBe(302);
    expect(landing.headers.get("location")).toContain("__orbit_status=verified");
    const done = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}`);
    expect(done.response.status).toBe("complete");

    // A stored URL with another scheme never reaches nodemailer.
    await ctx.settings.update({ email: { smtpUrl: "http://mail.example.com" } });
    const res = await api("POST", "/v1/instance/email_test", { to: "ops@example.com" });
    expect(res.status).toBe(422);
    await smtp.close();
  });

  it("verifies a sign-up email through SMTP with a link", async () => {
    const smtp = await startFakeSmtp();
    const { ctx, app } = await instance();
    await ctx.settings.update({ email: { provider: "smtp", smtpUrl: smtp.url, from: "Acme <no-reply@acme.test>" } });

    const client = testClient(app);
    const created = await client.json<{ response: { id: string; status: string } }>("/v1/client/sign_ups", {
      body: { email_address: "smtp-signup@example.com", password: "Sup3rSecret!" },
    });
    await client.json(`/v1/client/sign_ups/${created.response.id}/prepare_verification`, { body: { strategy: "email_link" } });

    const message = smtp.last()!;
    expect(message.recipients).toEqual(["smtp-signup@example.com"]);
    const link = linkIn(readableMessage(message.raw))!;
    expect(link).toContain("/v1/verify?token=");
    const landing = await app.request(link, { redirect: "manual" });
    expect(landing.status).toBe(302);
    expect(landing.headers.get("location")).toContain("__orbit_status=verified");

    // Clicking the link completes the sign-up server-side, so the originating device sees a session.
    const state = await client.json<{ response: { sessions: { id: string }[]; sign_up: unknown } }>("/v1/client");
    expect(state.response.sign_up).toBeNull();
    expect(state.response.sessions[0]?.id).toMatch(/^sess_/);
    await smtp.close();
  });

  it("never lets a display name or the app name create extra headers", async () => {
    const smtp = await startFakeSmtp();
    const { ctx } = await instance();
    await ctx.settings.update({ email: { provider: "smtp", smtpUrl: smtp.url, from: "Acme <no-reply@acme.test>" } });
    await ctx.settings.update({ application: { name: "Acme\r\nBcc: leak@example.com" } });

    await sendEmail(ctx, {
      to: "target@example.com",
      template: "new_sign_in",
      vars: { user_name: "Ada\r\nBcc: attacker@example.com", ip_address: "203.0.113.7\r\nX-Injected: yes", user_agent: "Firefox" },
    });

    const message = smtp.last()!;
    const headers = rawHeaders(message.raw);
    expect(headers.some((h) => h.name.toLowerCase() === "bcc")).toBe(false);
    expect(headers.some((h) => h.name.toLowerCase() === "x-injected")).toBe(false);
    expect(message.raw).not.toContain("attacker@example.com\r\n");
    expect(headers.find((h) => h.name.toLowerCase() === "subject")!.value).not.toMatch(/[\r\n]/);
    expect(readableMessage(message.raw)).toContain("Ada Bcc: attacker@example.com");
    await smtp.close();
  });

  it("refuses recipients that fail the strict address check", async () => {
    const smtp = await startFakeSmtp();
    const { ctx, api } = await instance();
    await ctx.settings.update({ email: { provider: "smtp", smtpUrl: smtp.url, from: "no-reply@acme.test" } });

    for (const to of ["a@b.c\r\nBcc: evil@example.com", "not-an-address", "a@localhost", ""]) {
      const res = await api("POST", "/v1/instance/email_test", { to });
      expect(res.status, to).toBe(422);
    }
    await sendEmail(ctx, { to: "a@b.c\r\nBcc: evil@example.com", template: "test_email", vars: {} });
    expect(smtp.messages).toHaveLength(0);
    expect(getMailOutbox()).toHaveLength(0);
    await smtp.close();
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

    await ctx.settings.update({ email: { provider: "console" } });
    const consoleRes = await api("POST", "/v1/instance/email_test", { to: "ops@example.com" });
    expect(await consoleRes.json()).toEqual({ provider: "console", ok: true });
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
