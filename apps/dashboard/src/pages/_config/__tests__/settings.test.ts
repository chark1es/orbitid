import { describe, expect, it } from "vitest";
import { WEBHOOK_EVENT_TYPES, defaultInstanceSettings } from "@orbitid/shared";
import {
  SAMPLE_TEMPLATE_CONTEXT,
  buildSettingsPatch,
  emailFromError,
  groupWebhookEvents,
  humanDuration,
  insertAtCursor,
  isHttpOrigin,
  isMaskedSecret,
  mergeSettingsResponse,
  normalizeInstanceSettings,
  normalizeRestrictionIdentifier,
  permissionKeyError,
  previewTemplateClaims,
  renderTemplateString,
  reservedJwtClaimErrors,
  resolveEmailProvider,
  resendApiKeyError,
  roleKeyError,
  secretInputValue,
  secretIsConfigured,
  shouldPreserveSecret,
  smtpUrlError,
  textToList,
} from "../settings";

describe("buildSettingsPatch", () => {
  const baseline = {
    session: { lifetimeSeconds: 604_800, multiSession: false },
    branding: { primaryColor: "#6366f1", theme: "system" },
    application: { allowedOrigins: ["http://localhost:3000"] },
    attributes: { emailAddress: { enabled: true, required: true } },
  };

  it("does not send unchanged values", () => {
    expect(buildSettingsPatch(baseline, structuredClone(baseline))).toEqual({});
  });

  it("sends only the changed nested path", () => {
    const draft = structuredClone(baseline);
    draft.session.lifetimeSeconds = 86_400;
    draft.attributes.emailAddress.required = false;
    expect(buildSettingsPatch(baseline, draft)).toEqual({
      session: { lifetimeSeconds: 86_400 },
      attributes: { emailAddress: { required: false } },
    });
  });

  it("replaces arrays rather than merging them", () => {
    const draft = structuredClone(baseline);
    draft.application.allowedOrigins = ["https://example.com"];
    expect(buildSettingsPatch(baseline, draft)).toEqual({
      application: { allowedOrigins: ["https://example.com"] },
    });
  });

  it("keeps stored secrets when the draft field is blank or masked", () => {
    const base = {
      email: { smtpUrl: "smtp://user:pass@host:587" },
      security: { captchaSecret: "real-captcha-secret" },
      social: { google: { clientSecret: "real-google-secret", clientId: "client" } },
    };
    const draft = {
      email: { smtpUrl: "" },
      security: { captchaSecret: "••••••••" },
      social: { google: { clientSecret: "", clientId: "client" } },
    };
    expect(buildSettingsPatch(base, draft)).toEqual({});
  });

  it("sends a newly typed secret", () => {
    const base = { email: { smtpUrl: "smtp://old" } };
    const draft = { email: { smtpUrl: "smtp://new" } };
    expect(buildSettingsPatch(base, draft)).toEqual({ email: { smtpUrl: "smtp://new" } });
  });

  it("does not partially mask a real secret into the patch", () => {
    const base = { security: { captchaSecret: "abcdef123456" } };
    const draft = { security: { captchaSecret: "abcdef••••" } };
    expect(buildSettingsPatch(base, draft)).toEqual({});
  });

  it("detects masked server values", () => {
    expect(isMaskedSecret("••••")).toBe(true);
    expect(isMaskedSecret("••••••••")).toBe(true);
    expect(isMaskedSecret("sk_live_••••••••")).toBe(true);
    expect(isMaskedSecret("smtp://user:pass@host")).toBe(false);
    expect(shouldPreserveSecret("")).toBe(true);
    expect(shouldPreserveSecret(undefined)).toBe(true);
    expect(shouldPreserveSecret("new-secret")).toBe(false);
    expect(secretInputValue("••••••••")).toBe("");
    expect(secretInputValue("actual")).toBe("actual");
    expect(secretIsConfigured("••••••••")).toBe(true);
    expect(secretIsConfigured("")).toBe(false);
  });

  it("keeps every masked secret the server can send, including Resend and the Apple key", () => {
    const base = {
      email: { resendApiKey: "re_live_stored", smtpUrl: "smtp://user:pass@host:587" },
      sms: { twilioAuthToken: "stored-token" },
      security: { captchaSecret: "stored-captcha" },
      social: {
        apple: { clientSecret: "apple-secret", applePrivateKey: "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----" },
      },
    };
    const draft = {
      email: { resendApiKey: "••••", smtpUrl: "••••" },
      sms: { twilioAuthToken: "••••" },
      security: { captchaSecret: "••••" },
      social: { apple: { clientSecret: "••••", applePrivateKey: "••••" } },
    };
    expect(buildSettingsPatch(base, draft)).toEqual({});
  });

  it("replaces a masked secret with a typed value and clears it with an explicit empty follow-up", () => {
    const base = { email: { resendApiKey: "re_live_stored" } };
    expect(buildSettingsPatch(base, { email: { resendApiKey: "re_live_new" } })).toEqual({
      email: { resendApiKey: "re_live_new" },
    });
  });
});

describe("instance settings normalization", () => {
  it("fills defaults and accepts the { settings } envelope", () => {
    const settings = normalizeInstanceSettings({ settings: { branding: { primaryColor: "#ff0000" } } });
    expect(settings.branding.primaryColor).toBe("#ff0000");
    expect(settings.branding.theme).toBe("system");
    expect(settings.session.lifetimeSeconds).toBe(defaultInstanceSettings().session.lifetimeSeconds);
    expect(settings.attributes.emailAddress.required).toBe(true);
  });

  it("merges a PATCH response onto the baseline without losing fields", () => {
    const baseline = defaultInstanceSettings();
    baseline.session.lifetimeSeconds = 3600;
    const next = mergeSettingsResponse({ session: { multiSession: true } }, baseline);
    expect(next.session.multiSession).toBe(true);
    expect(next.session.lifetimeSeconds).toBe(3600);
    expect(next.attributes.emailAddress.enabled).toBe(true);
  });
});

describe("JWT template shortcodes", () => {
  it("renders whole-value shortcodes with their JSON type", () => {
    expect(renderTemplateString("{{user.id}}")).toBe(SAMPLE_TEMPLATE_CONTEXT.user.id);
    expect(renderTemplateString("{{user.email_verified}}")).toBe(true);
    expect(renderTemplateString("{{user.public_metadata}}")).toEqual(SAMPLE_TEMPLATE_CONTEXT.user.public_metadata);
    expect(renderTemplateString("{{org_membership.permissions}}")).toEqual(SAMPLE_TEMPLATE_CONTEXT.org_membership.permissions);
  });

  it("interpolates embedded shortcodes as strings", () => {
    expect(renderTemplateString("{{user.first_name}} {{user.last_name}}")).toBe("Ada Lovelace");
    expect(renderTemplateString("org={{org.slug}}")).toBe("org=acme");
    expect(renderTemplateString("{{user.public_metadata.plan}}")).toBe("pro");
  });

  it("supports || fallbacks", () => {
    expect(renderTemplateString("{{user.username}} || {{user.id}}")).toBe("ada");
    expect(renderTemplateString("{{user.missing}} || {{user.id}}")).toBe(SAMPLE_TEMPLATE_CONTEXT.user.id);
  });

  it("previews a whole claims object against the sample user", () => {
    const preview = previewTemplateClaims({
      email: "{{user.primary_email_address}}",
      name: "{{user.first_name}} {{user.last_name}}",
      organization: "{{org.slug}}",
      is_admin: "{{user.email_verified}}",
      fallback: "{{user.nope}} || {{user.id}}",
      nested: { count: 2, permissions: "{{org_membership.permissions}}" },
    });
    expect(preview).toEqual({
      email: "ada@example.com",
      name: "Ada Lovelace",
      organization: "acme",
      is_admin: true,
      fallback: SAMPLE_TEMPLATE_CONTEXT.user.id,
      nested: { count: 2, permissions: SAMPLE_TEMPLATE_CONTEXT.org_membership.permissions },
    });
  });

  it("inserts a shortcode at the caret", () => {
    expect(insertAtCursor('{"x": ""}', "{{user.id}}", 7, 7)).toEqual({ value: '{"x": "{{user.id}}"}', caret: 18 });
  });

  it("reports reserved claims that the server will reject", () => {
    expect(reservedJwtClaimErrors({ email: "{{user.primary_email_address}}" })).toEqual([]);
    expect(reservedJwtClaimErrors({ sub: "x", org_role: "org:admin", custom: true })).toEqual([
      '"sub" is reserved and cannot be set by a template.',
      '"org_role" is reserved and cannot be set by a template.',
    ]);
  });
});

describe("webhook event grouping", () => {
  it("groups every declared event by resource without losing any", () => {
    const groups = groupWebhookEvents();
    const regrouped = groups.flatMap((group) => group.events);
    expect(regrouped).toEqual([...WEBHOOK_EVENT_TYPES]);
    expect(new Set(regrouped).size).toBe(WEBHOOK_EVENT_TYPES.length);
    expect(groups.map((group) => group.resource)).toContain("organizationMembership");
    expect(groups.find((group) => group.resource === "user")?.label).toBe("Users");
  });

  it("preserves declared order for a custom subset", () => {
    const groups = groupWebhookEvents(["user.created", "organization.updated", "user.updated"]);
    expect(groups).toEqual([
      { resource: "user", label: "Users", events: ["user.created", "user.updated"] },
      { resource: "organization", label: "Organizations", events: ["organization.updated"] },
    ]);
  });
});

describe("role and permission keys", () => {
  it("accepts custom role keys", () => {
    expect(roleKeyError("org:billing")).toBeNull();
    expect(roleKeyError("org:team-lead")).toBeNull();
    expect(roleKeyError("org:support_2")).toBeNull();
  });

  it("rejects malformed role keys", () => {
    expect(roleKeyError("")).toMatch(/required/);
    expect(roleKeyError("admin")).toMatch(/org:/);
    expect(roleKeyError("org:")).toMatch(/after/);
    expect(roleKeyError("org:billing:read")).toMatch(/colons/);
    expect(roleKeyError("org:Billing")).toMatch(/lowercase/);
  });

  it("accepts and rejects permission keys", () => {
    expect(permissionKeyError("org:billing:manage")).toBeNull();
    expect(permissionKeyError("org:sys_memberships:read")).toMatch(/reserved/);
    expect(roleKeyError("org:sys_custom")).toMatch(/reserved/);
    expect(permissionKeyError("org:billing")).toMatch(/org:<feature>:<action>/);
    expect(permissionKeyError("billing:manage")).toMatch(/org:/);
    expect(permissionKeyError("org:billing:manage:extra")).toMatch(/org:<feature>:<action>/);
    expect(permissionKeyError("org:Billing:Manage")).toMatch(/lowercase/);
  });
});

describe("email provider resolution", () => {
  it("follows the server: an explicit provider wins, auto picks the first configured transport", () => {
    const email = defaultInstanceSettings().email;
    expect(resolveEmailProvider(email)).toMatchObject({ provider: "console", automatic: true });
    expect(resolveEmailProvider({ ...email, resendApiKey: "••••" })).toMatchObject({ provider: "resend", automatic: true });
    expect(resolveEmailProvider({ ...email, smtpUrl: "••••" })).toMatchObject({ provider: "smtp", automatic: true });
    expect(resolveEmailProvider({ ...email, smtpUrl: "••••", resendApiKey: "••••" })).toMatchObject({ provider: "resend" });
    expect(resolveEmailProvider({ ...email, provider: "console", resendApiKey: "••••" })).toMatchObject({
      provider: "console",
      automatic: false,
    });
  });

  it("reports a selected provider that has no credential instead of falling back", () => {
    const email = defaultInstanceSettings().email;
    expect(resolveEmailProvider({ ...email, provider: "resend" })).toMatchObject({ provider: "resend", missing: "resendApiKey" });
    expect(resolveEmailProvider({ ...email, provider: "smtp" })).toMatchObject({ provider: "smtp", missing: "smtpUrl" });
    expect(resolveEmailProvider({ ...email, provider: "resend", resendApiKey: "••••" }).missing).toBeNull();
  });

  it("validates the from address the way the server does", () => {
    expect(emailFromError("OrbitID <no-reply@example.com>")).toBeNull();
    expect(emailFromError("no-reply@localhost")).toBeNull();
    expect(emailFromError("")).toMatch(/required/);
    expect(emailFromError("no-reply@example.com\r\nBcc: x@example.com")).toMatch(/line breaks/);
    expect(emailFromError("OrbitID")).toMatch(/email address/);
    expect(emailFromError("<no-reply@example.com>")).toBeNull();
  });

  it("accepts only smtp and smtps URLs on a valid port", () => {
    expect(smtpUrlError("")).toBeNull();
    expect(smtpUrlError("smtp://user:pass@mail.example.com:587")).toBeNull();
    expect(smtpUrlError("smtps://mail.example.com")).toBeNull();
    expect(smtpUrlError("https://mail.example.com")).toMatch(/smtp:\/\//);
    expect(smtpUrlError("smtp://mail.example.com/path")).toMatch(/path/);
    expect(smtpUrlError("smtp://mail.example.com?x=1")).toMatch(/query/);
    expect(smtpUrlError("smtp://mail.example.com:99999")).toMatch(/port below 65535/);
    expect(smtpUrlError("not a url")).toMatch(/smtp:\/\//);
  });

  it("refuses line breaks in a Resend key", () => {
    expect(resendApiKeyError("re_live_ok")).toBeNull();
    expect(resendApiKeyError("re_live\r\nX: y")).toMatch(/line breaks/);
  });
});

describe("list helpers", () => {
  it("normalizes restriction identifiers", () => {
    expect(normalizeRestrictionIdentifier("email", " User@Example.com ")).toEqual({
      identifier: "user@example.com",
      identifier_type: "email_address",
    });
    expect(normalizeRestrictionIdentifier("domain", "@Example.com")).toEqual({
      identifier: "@example.com",
      identifier_type: "email_address",
    });
    expect(normalizeRestrictionIdentifier("phone", " +15551234567 ")).toEqual({
      identifier: "+15551234567",
      identifier_type: "phone_number",
    });
    expect(normalizeRestrictionIdentifier("email", "not-an-email")).toBeNull();
    expect(normalizeRestrictionIdentifier("domain", "not a domain")).toBeNull();
  });

  it("validates browser origins without paths", () => {
    expect(isHttpOrigin("http://localhost:3000")).toBe(true);
    expect(isHttpOrigin("https://example.com:8443")).toBe(true);
    expect(isHttpOrigin("https://example.com/app")).toBe(false);
    expect(isHttpOrigin("javascript:alert(1)")).toBe(false);
  });

  it("formats durations and splits lists", () => {
    expect(humanDuration(604_800)).toBe("7 days");
    expect(humanDuration(3600)).toBe("1 hour");
    expect(humanDuration(60)).toBe("1 minute");
    expect(humanDuration(0)).toBe("disabled");
    expect(textToList("read:users, write:users\nadmin")).toEqual(["read:users", "write:users", "admin"]);
  });
});
