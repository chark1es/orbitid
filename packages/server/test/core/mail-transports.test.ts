// Delivery through the Resend and SMTP transports, including header injection and address validation.
import { afterEach, describe, expect, it } from "vitest";
import { getMailOutbox, sendEmail, setResendEndpointForTests } from "../../src/services/mail";
import { testClient } from "./helpers";
import { codeIn, linkIn, rawHeaders, readableMessage, startFakeResend, startFakeSmtp } from "../support/fake-mail";
import { RESEND_KEY, instance, pathOf, signInWithEmailCode, verifiedUser } from "./mail-helpers";

afterEach(() => setResendEndpointForTests(null));

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
    const landing = await client.request(pathOf(link));
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
    const landing = await client.request(pathOf(link));
    expect(landing.status).toBe(302);
    expect(landing.headers.get("location")).toContain("__orbit_status=verified");
    const done = await client.json<{ response: { status: string } }>(`/v1/client/sign_ins/${created.response.id}`);
    expect(done.response.status).toBe("complete");

    // A stored URL with another scheme is refused at save time, so it never reaches nodemailer.
    await expect(ctx.settings.update({ email: { smtpUrl: "http://mail.example.com" } })).rejects.toMatchObject({ status: 422 });
    expect(ctx.settings.get().email.smtpUrl).toBe(smtp.url);
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
    const landing = await client.request(pathOf(link));
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
