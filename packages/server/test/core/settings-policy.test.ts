// Settings are the server's contract with its own UI: a saved tree must be one the server can actually serve.
// These tests cover the prerequisites (attributes, providers, roles, lifetimes) and the "disabled means locked"
// rule, including that turning a feature back on restores the operator's original sub-switches.
import { describe, expect, it } from "vitest";
import { createContext } from "../../src/bootstrap";
import { assertSettingsUsable, normalizeSettings, emailDeliveryRequired, smsDeliveryRequired, effectiveEmailProvider } from "../../src/lib/settings-policy";
import { instanceSettingsSchema } from "@orbitid/shared";
import { deepMerge } from "../../src/settings";
import { api, backend, errorCode, seedAuth, seedUser, setup } from "../orgs/helpers";

/**
 * A complete, *served* settings tree: the patch is deep-merged over the defaults exactly like a real save, then
 * normalized (disabled attributes lose their sub-switches), because that is what the policy validates.
 */
const parse = (patch: Record<string, unknown>) => normalizeSettings(instanceSettingsSchema.parse(deepMerge(instanceSettingsSchema.parse({}), patch)));

async function context() {
  return createContext({ databaseUrl: ":memory:", secretKey: "sk_test_testsecret", baseUrl: "http://localhost:4000", nodeEnv: "test" });
}

describe("settings prerequisites", () => {
  it("locks the sub-switches of a disabled attribute instead of storing an impossible wish", () => {
    // The store normalizes first, so a "required but disabled" patch is not an error: it is stored as inert and
    // served with the flags off. `assertAttributeConsistency` is the belt-and-braces check on the served tree.
    for (const attributes of [
      { emailAddress: { enabled: false, required: true } },
      { phoneNumber: { enabled: false, usedForSecondFactor: true } },
      { username: { enabled: false, usedForFirstFactor: true } },
      { passkey: { enabled: false, required: true } },
    ]) {
      const served = parse({ attributes });
      for (const attr of Object.values(served.attributes) as { enabled: boolean; required: boolean; usedForFirstFactor: boolean; usedForSecondFactor: boolean }[]) {
        if (attr.enabled) continue;
        expect(attr.required).toBe(false);
        expect(attr.usedForFirstFactor).toBe(false);
        expect(attr.usedForSecondFactor).toBe(false);
      }
    }
    // A tree that somehow reaches the policy unnormalized is still refused.
    const unnormalized = instanceSettingsSchema.parse({ attributes: { emailAddress: { enabled: false, required: true } } });
    expect(() => assertSettingsUsable(unnormalized)).toThrow(/needs .*enabled/);
  });

  it("refuses verification strategies that do not apply to the attribute", () => {
    expect(() => assertSettingsUsable(parse({ attributes: { emailAddress: { verifications: ["totp"] } } }))).toThrow(/email_code and email_link/);
    expect(() => assertSettingsUsable(parse({ attributes: { phoneNumber: { enabled: true, verifications: ["email_link"] } } }))).toThrow(/phone_code/);
    // Email verification with no strategy at all would send nothing.
    expect(() => assertSettingsUsable(parse({ attributes: { emailAddress: { verifications: [] } } }))).toThrow(/at least one verification strategy/);
  });

  it("refuses a configuration where nobody could sign in or up", () => {
    const allOff = {
      emailAddress: { enabled: false }, phoneNumber: { enabled: false }, username: { enabled: false },
      password: { enabled: false }, passkey: { enabled: false },
    };
    expect(() => assertSettingsUsable(parse({ attributes: allOff }))).toThrow(/nobody could sign up or sign in/);
  });

  it("refuses a required password nobody could create", () => {
    const settings = parse({
      attributes: {
        emailAddress: { enabled: false }, phoneNumber: { enabled: false }, username: { enabled: false }, passkey: { enabled: false },
        password: { enabled: true, required: true, usedForFirstFactor: false },
      },
    });
    // Email is required by default and has just been disabled, which the served tree locks; password remains the
    // only path to an account, and with no identifier a required password cannot be created.
    expect(settings.attributes.emailAddress.required).toBe(false);
    expect(settings.attributes.password.required).toBe(true);
    expect(() => assertSettingsUsable(settings)).toThrow();
  });

  it("validates password and session lifetimes", () => {
    expect(() => assertSettingsUsable(parse({ password: { minLength: 80 } }))).toThrow(/72/);
    expect(() => assertSettingsUsable(parse({ password: { minLength: 0 } }))).toThrow();
    // 0 means "no maximum lifetime" and is the default; a negative value is refused.
    expect(() => assertSettingsUsable(parse({ session: { lifetimeSeconds: 0 } }))).not.toThrow();
    expect(() => assertSettingsUsable(parse({ session: { lifetimeSeconds: -1 } }))).toThrow(/0 \(no maximum lifetime\)/);
    expect(() => assertSettingsUsable(parse({ session: { tokenLifetimeSeconds: 0 } }))).toThrow(/greater than 0/);
    expect(() => assertSettingsUsable(parse({ session: { lifetimeSeconds: 3_600, tokenLifetimeSeconds: 10_000_000 } }))).toThrow(/cannot exceed/);
    // With no maximum, a long-lived token is fine; an inactivity timeout may exceed any finite lifetime.
    expect(() => assertSettingsUsable(parse({ session: { lifetimeSeconds: 0, tokenLifetimeSeconds: 10_000_000 } }))).not.toThrow();
    expect(() => assertSettingsUsable(parse({ session: { inactivityTimeoutSeconds: 0 } }))).not.toThrow();
    expect(() => assertSettingsUsable(parse({ password: { maxLength: 8, minLength: 9 } }))).toThrow();
  });

  it("refuses an organization role setting that is not an organization key", () => {
    expect(() => assertSettingsUsable(parse({ organizations: { creatorRole: "app:admin" } }))).toThrow(/organization role key/);
    expect(() => assertSettingsUsable(parse({ organizations: { defaultRole: "member" } }))).toThrow(/organization role key/);
    expect(() => assertSettingsUsable(parse({ organizations: { maxAllowedMemberships: -1 } }))).toThrow(/0 \(no limit\)/);
    // 0 means unlimited, the default: no plan-shaped member cap.
    expect(() => assertSettingsUsable(parse({ organizations: { maxAllowedMemberships: 0 } }))).not.toThrow();
  });

  it("refuses an enabled provider without credentials or a discovery URL", () => {
    expect(() => assertSettingsUsable(parse({ social: { google: { enabled: true, clientId: "id" } } }))).toThrow(/clientSecret/);
    expect(() => assertSettingsUsable(parse({ social: { custom_acme: { enabled: true, clientId: "id", clientSecret: "s" } } }))).toThrow(/discoveryUrl/);
    expect(() => assertSettingsUsable(parse({ social: { custom_acme: { enabled: true, clientId: "id", clientSecret: "s", discoveryUrl: "http://example.test/x" } } }))).toThrow(/https/);
    // A loopback http provider is accepted (a local test IdP); reachability is decided at request time.
    expect(() => assertSettingsUsable(parse({ social: { custom_acme: { enabled: true, clientId: "id", clientSecret: "s", discoveryUrl: "http://127.0.0.1:8080/.well-known/openid-configuration" } } }))).not.toThrow();
    // Apple may use a .p8 triple instead of a secret.
    expect(() => assertSettingsUsable(parse({
      social: { apple: { enabled: true, clientId: "id", appleTeamId: "t", appleKeyId: "k", applePrivateKey: "p" } },
    }))).not.toThrow();
  });

  it("accepts custom providers with manual endpoints or a public PKCE client", () => {
    const base = { enabled: true, clientId: "id", clientSecret: "s" } as const;
    expect(() => assertSettingsUsable(parse({ social: { custom_oauth: {
      ...base, protocol: "oauth2",
      authorizationUrl: "https://idp.example/authorize", tokenUrl: "https://idp.example/token", userinfoUrl: "https://idp.example/userinfo",
    } } }))).not.toThrow();
    // OIDC manual endpoints need a way to read the profile: userinfo or JWKS.
    expect(() => assertSettingsUsable(parse({ social: { custom_manual: {
      ...base, protocol: "oidc", authorizationUrl: "https://idp.example/authorize", tokenUrl: "https://idp.example/token",
    } } }))).toThrow(/userinfoUrl or a jwksUrl/);
    // A public client uses PKCE with no secret.
    expect(() => assertSettingsUsable(parse({ social: { custom_public: {
      enabled: true, clientId: "id", pkce: true,
      authorizationUrl: "https://idp.example/authorize", tokenUrl: "https://idp.example/token", userinfoUrl: "https://idp.example/userinfo",
    } } }))).not.toThrow();
  });

  it("validates every custom endpoint URL", () => {
    const settings = (patch: Record<string, unknown>) => parse({ social: { custom_bad: {
      enabled: true, clientId: "id", clientSecret: "s",
      authorizationUrl: "https://idp.example/authorize", tokenUrl: "https://idp.example/token", userinfoUrl: "https://idp.example/userinfo",
      ...patch,
    } } });
    expect(() => assertSettingsUsable(settings({ tokenUrl: "http://public.example/token" }))).toThrow(/https/);
    expect(() => assertSettingsUsable(settings({ logoUrl: "not a url" }))).toThrow(/absolute URL/);
  });

  it("refuses a captcha provider with no secret and an sms provider with missing fields", () => {
    expect(() => assertSettingsUsable(parse({ security: { captchaProvider: "turnstile" } }))).toThrow(/captchaSecret/);
    expect(() => assertSettingsUsable(parse({ sms: { provider: "twilio" } }))).toThrow(/twilioAccountSid/);
    expect(() => assertSettingsUsable(parse({ sms: { provider: "webhook" } }))).toThrow(/webhookUrl/);
    expect(() => assertSettingsUsable(parse({ sms: { webhookUrl: "http://insecure.test/hook" } }))).toThrow(/https/);
  });

  it("knows when a flow needs a delivery channel", () => {
    const settings = parse({});
    expect(emailDeliveryRequired(settings)).toBe(true);
    expect(smsDeliveryRequired(settings)).toBe(false);
    const sms = parse({ attributes: { phoneNumber: { enabled: true, usedForSecondFactor: true, verifications: ["phone_code"] } } });
    expect(smsDeliveryRequired(sms)).toBe(true);
    // Verifying a phone at sign-up sends a code too, so it needs a transport just like a factor does.
    const smsSignUp = parse({ attributes: { phoneNumber: { enabled: true, verifyAtSignUp: true, verifications: ["phone_code"] } } });
    expect(smsDeliveryRequired(smsSignUp)).toBe(true);
    const noEmail = parse({ attributes: { emailAddress: { verifyAtSignUp: false, usedForFirstFactor: false } } });
    expect(emailDeliveryRequired(noEmail)).toBe(false);
  });

  it("accepts credentials supplied through the environment, exactly as the mail resolver does", () => {
    // A deployment configured only through ORBITID_* variables must still be able to save settings.
    expect(effectiveEmailProvider(parse({}))).toBe("console");
    expect(effectiveEmailProvider(parse({}), { resendApiKey: "re_env" })).toBe("resend");
    expect(effectiveEmailProvider(parse({}), { smtpUrl: "smtp://mail.example.com:587" })).toBe("smtp");
    // An explicit provider still wins over the environment, including the deliberate `console` opt-out.
    expect(effectiveEmailProvider(parse({ email: { provider: "console" } }), { resendApiKey: "re_env" })).toBe("console");

    expect(() => assertSettingsUsable(parse({ email: { provider: "resend" } }))).toThrow(/API key/);
    expect(() => assertSettingsUsable(parse({ email: { provider: "resend" } }), { env: { resendApiKey: "re_env" } })).not.toThrow();
    expect(() => assertSettingsUsable(parse({ email: { provider: "smtp" } }))).toThrow(/SMTP URL/);
    expect(() => assertSettingsUsable(parse({ email: { provider: "smtp" } }), { env: { smtpUrl: "smtp://mail.example.com:587" } })).not.toThrow();
    // An empty `from` means "use the environment, then the default"; it is not a malformed header.
    expect(() => assertSettingsUsable(parse({ email: { from: "" } }))).not.toThrow();
    expect(() => assertSettingsUsable(parse({ email: { from: "not an address" } }))).toThrow();
  });
});

describe("environment-configured deployments", () => {
  it("accepts a production save when the mail credentials come from ORBITID_* variables", async () => {
    const saved = { vitest: process.env.VITEST, nodeEnv: process.env.NODE_ENV, key: process.env.ORBITID_RESEND_API_KEY };
    delete process.env.VITEST;
    process.env.NODE_ENV = "production";
    delete process.env.ORBITID_RESEND_API_KEY;
    try {
      // Without a provider anywhere, an e-mail-first-factor instance cannot deliver, so the save is refused.
      const bare = await createContext({ databaseUrl: ":memory:", secretKey: "sk_test_production_0123456789abcdef", baseUrl: "https://auth.example.com", nodeEnv: "production", encryptionKey: "k".repeat(40) });
      await expect(bare.settings.update({ application: { name: "Bare" } })).rejects.toThrow(/no e-mail provider/i);

      // The same deployment with the documented environment key is deliverable and must be configurable.
      process.env.ORBITID_RESEND_API_KEY = "re_env";
      const configured = await createContext({ databaseUrl: ":memory:", secretKey: "sk_test_production_0123456789abcdef", baseUrl: "https://auth.example.com", nodeEnv: "production", encryptionKey: "k".repeat(40) });
      await expect(configured.settings.update({ application: { name: "Env configured" } })).resolves.toMatchObject({ application: { name: "Env configured" } });
    } finally {
      if (saved.vitest !== undefined) process.env.VITEST = saved.vitest; else delete process.env.VITEST;
      if (saved.nodeEnv !== undefined) process.env.NODE_ENV = saved.nodeEnv; else delete process.env.NODE_ENV;
      if (saved.key !== undefined) process.env.ORBITID_RESEND_API_KEY = saved.key; else delete process.env.ORBITID_RESEND_API_KEY;
    }
  });
});

describe("disabled features are locked", () => {
  it("forces organization sub-switches off in the served tree", async () => {
    const ctx = await context();
    await ctx.settings.update({ organizations: { enabled: false, creationEnabled: true, domainsEnabled: true, membershipRequestsEnabled: true, forceOrganizationSelection: true, creatorRole: "org:admin", defaultRole: "org:member" } });
    const served = ctx.settings.get();
    expect(served.organizations.enabled).toBe(false);
    expect(served.organizations.creationEnabled).toBe(false);
    expect(served.organizations.domainsEnabled).toBe(false);
    expect(served.organizations.membershipRequestsEnabled).toBe(false);
    expect(served.organizations.forceOrganizationSelection).toBe(false);
    expect(served.userSettings.createOrganizationEnabled).toBe(false);
  });

  it("keeps the operator's intent, so re-enabling organizations restores creation", async () => {
    const ctx = await context();
    await ctx.settings.update({ organizations: { enabled: false, creationEnabled: true } });
    expect(ctx.settings.get().organizations.creationEnabled).toBe(false);
    await ctx.settings.update({ organizations: { enabled: true } });
    expect(ctx.settings.get().organizations.creationEnabled).toBe(true);
  });

  it("forces every sub-switch of a disabled attribute off in the served tree", async () => {
    const ctx = await context();
    await ctx.settings.update({ attributes: { phoneNumber: { enabled: false, required: true, usedForFirstFactor: true, usedForSecondFactor: true, verifyAtSignUp: true } } });
    const phone = ctx.settings.get().attributes.phoneNumber;
    expect(phone.enabled).toBe(false);
    expect(phone.required).toBe(false);
    expect(phone.usedForFirstFactor).toBe(false);
    expect(phone.usedForSecondFactor).toBe(false);
    expect(phone.verifyAtSignUp).toBe(false);
    // Re-enabling brings the flags back: they were stored, not destroyed.
    await ctx.settings.update({ attributes: { phoneNumber: { enabled: true } } });
    expect(ctx.settings.get().attributes.phoneNumber.usedForFirstFactor).toBe(true);
  });

  it("is idempotent and mutates its input (so the store must copy before serving)", () => {
    const settings = instanceSettingsSchema.parse(deepMerge(instanceSettingsSchema.parse({}), { organizations: { enabled: false, creationEnabled: true } }));
    const once = normalizeSettings(structuredClone(settings));
    const twice = normalizeSettings(structuredClone(settings));
    expect(twice).toEqual(once);
    // The helper really does mutate: this is why the store serves a clone and keeps the operator's tree intact.
    const mutable = structuredClone(settings);
    normalizeSettings(mutable);
    expect(mutable.organizations.creationEnabled).toBe(false);
    expect(settings.organizations.creationEnabled).toBe(true);
  });

  it("rejects a save the server could not serve through the store", async () => {
    const ctx = await context();
    await expect(ctx.settings.update({ attributes: { emailAddress: { verifications: ["totp"] } } })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.settings.update({ social: { google: { enabled: true, clientId: "id" } } })).rejects.toMatchObject({ status: 422 });
    await expect(ctx.settings.update({ organizations: { creatorRole: "app:admin" } })).rejects.toMatchObject({ status: 422 });
  });
});

describe("organization features are enforced server-side", () => {
  it("refuses organization writes while organizations are disabled", async () => {
    const { app, ctx } = await setup({ organizations: { enabled: false } });
    const user = await seedUser(ctx, { email: "user@acme.test" });
    const auth = await seedAuth(ctx, user.id);
    const created = await api(app, "POST", "/v1/client/organizations", { cookie: auth.cookie, body: { name: "Acme" } });
    expect(created.status).toBe(403);
    expect(errorCode(created.body)).toBe("organizations_disabled");
    // Every user-facing organization route is gated, including the read-only ones and the ones that grant a
    // membership implicitly (accepting an invitation or a suggestion).
    for (const [method, path, body] of [
      ["GET", "/v1/client/me/organization_memberships", undefined],
      ["POST", "/v1/client/me/organization_memberships", { organization_id: "org_x" }],
      ["GET", "/v1/client/me/organization_invitations", undefined],
      ["GET", "/v1/client/me/organization_suggestions", undefined],
      ["POST", "/v1/client/organizations", { name: "Acme" }],
    ] as const) {
      const res = await api(app, method, path, { cookie: auth.cookie, body });
      expect(res.status, `${method} ${path}`).toBe(403);
      expect(errorCode(res.body)).toBe("organizations_disabled");
    }
    // The operator surface still works: the secret key can repair data while the feature is off for users.
    expect((await backend(app, "GET", "/v1/organizations")).status).toBe(200);
  });

  it("refuses a membership when organization creation is off but organizations are on", async () => {
    const { app, ctx } = await setup({ organizations: { creationEnabled: false } });
    const user = await seedUser(ctx, { email: "creator@acme.test" });
    const auth = await seedAuth(ctx, user.id);
    const res = await api(app, "POST", "/v1/client/organizations", { cookie: auth.cookie, body: { name: "Acme" } });
    expect(res.status).toBe(403);
    expect(errorCode(res.body)).toBe("organization_creation_not_allowed");
  });
});
