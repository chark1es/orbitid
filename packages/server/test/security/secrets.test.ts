import { describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { createSettingsStore } from "../../src/settings";
import { isSealedSecret, maskSecrets, openSecrets, unmaskSettingsPatch } from "../../src/lib/secrets";
import { testApp, json } from "../admin/helpers";

interface InstanceResponse {
  email: { smtpUrl: string; smtpUrlSet: boolean; resendApiKey: string; resendApiKeySet: boolean };
  sms: { twilioAuthToken: string; twilioAuthTokenSet: boolean };
  security: { captchaSecret: string; captchaSecretSet: boolean };
  social: Record<string, { clientSecret: string; clientSecretSet: boolean; applePrivateKey?: string; applePrivateKeySet?: boolean }>;
}

const SECRETS = {
  smtp: "smtp://mailer:hunter2@smtp.example.com:587",
  resend: "re_live_abcdefghijklmnop",
  twilio: "twilio-auth-token-value",
  captcha: "captcha-secret-value",
  google: "google-client-secret",
  apple: "-----BEGIN PRIVATE KEY-----\nMIGTAgEAMBMGByqGSM49\n-----END PRIVATE KEY-----",
};

async function seeded() {
  const h = await testApp();
  await h.ctx.settings.update({
    email: { smtpUrl: SECRETS.smtp, resendApiKey: SECRETS.resend },
    sms: { twilioAuthToken: SECRETS.twilio },
    security: { captchaSecret: SECRETS.captcha },
    social: {
      google: { enabled: true, clientId: "google-id", clientSecret: SECRETS.google },
      apple: { enabled: true, clientId: "apple-id", clientSecret: "apple-secret", applePrivateKey: SECRETS.apple },
    },
  });
  return h;
}

describe("secrets on the wire", () => {
  it("masks every credential type and marks it as set", async () => {
    const h = await seeded();
    const instance = await json<InstanceResponse>(await h.api("GET", "/v1/instance"));
    expect(instance.email).toMatchObject({ smtpUrl: "••••", smtpUrlSet: true, resendApiKey: "••••", resendApiKeySet: true });
    expect(instance.sms).toMatchObject({ twilioAuthToken: "••••", twilioAuthTokenSet: true });
    expect(instance.security).toMatchObject({ captchaSecret: "••••", captchaSecretSet: true });
    expect(instance.social.google).toMatchObject({ clientSecret: "••••", clientSecretSet: true });
    expect(instance.social.apple).toMatchObject({ applePrivateKey: "••••", applePrivateKeySet: true });
    const wire = JSON.stringify(instance);
    for (const secret of Object.values(SECRETS)) expect(wire).not.toContain(secret.split("\n")[0]!);
  });

  it("keeps stored values through a full-object round trip that echoes the masks", async () => {
    const h = await seeded();
    const instance = await json<InstanceResponse>(await h.api("GET", "/v1/instance"));
    const patched = await json<InstanceResponse>(await h.api("PATCH", "/v1/instance", { ...instance, application: { name: "Renamed" } }));
    expect(patched.email.smtpUrl).toBe("••••");
    const settings = h.ctx.settings.get();
    expect(settings.email.smtpUrl).toBe(SECRETS.smtp);
    expect(settings.email.resendApiKey).toBe(SECRETS.resend);
    expect(settings.sms.twilioAuthToken).toBe(SECRETS.twilio);
    expect(settings.security.captchaSecret).toBe(SECRETS.captcha);
    expect(settings.social.google!.clientSecret).toBe(SECRETS.google);
    expect(settings.social.apple!.applePrivateKey).toBe(SECRETS.apple);
  });

  it("keeps stored values when the editor sends the plaintext back unchanged", async () => {
    const h = await seeded();
    await h.api("PATCH", "/v1/instance", { email: { smtpUrl: SECRETS.smtp, resendApiKey: SECRETS.resend } });
    const settings = h.ctx.settings.get();
    expect(settings.email.smtpUrl).toBe(SECRETS.smtp);
    expect(settings.email.resendApiKey).toBe(SECRETS.resend);
  });

  it("replaces a secret when the editor sends a new value", async () => {
    const h = await seeded();
    await h.api("PATCH", "/v1/instance", { email: { resendApiKey: "re_live_replacement_value" } });
    expect(h.ctx.settings.get().email.resendApiKey).toBe("re_live_replacement_value");
  });

  it("clears a secret when the editor sends an empty string", async () => {
    const h = await seeded();
    const patched = await json<InstanceResponse>(await h.api("PATCH", "/v1/instance", { security: { captchaSecret: "" } }));
    expect(h.ctx.settings.get().security.captchaSecret).toBe("");
    expect(patched.security.captchaSecretSet).toBe(false);
  });
});

describe("secrets at rest", () => {
  it("encrypts every credential in the stored settings row", async () => {
    const h = await seeded();
    const row = (await h.ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))[0]!;
    const stored = JSON.stringify(row.settings);
    for (const secret of [SECRETS.smtp, SECRETS.resend, SECRETS.twilio, SECRETS.captcha, SECRETS.google, "apple-secret"]) {
      expect(stored).not.toContain(secret);
    }
    const tree = row.settings as Record<string, any>;
    for (const value of [tree.email.smtpUrl, tree.email.resendApiKey, tree.sms.twilioAuthToken, tree.security.captchaSecret, tree.social.google.clientSecret]) {
      expect(isSealedSecret(value)).toBe(true);
    }
    // The in-memory cache still holds plaintext so providers keep working.
    expect(h.ctx.settings.get().email.smtpUrl).toBe(SECRETS.smtp);
  });

  it("reads plaintext rows written by older versions and encrypts them on the next write", async () => {
    const db = await import("../../src/db").then(async (m) => {
      const { createDb, runMigrations } = m;
      const handle = await createDb(":memory:");
      await runMigrations(handle);
      return handle;
    });
    const encryptionKey = "x".repeat(40);
    const settingsModule = await import("@orbitid/shared");
    const legacy = settingsModule.defaultInstanceSettings();
    legacy.email.resendApiKey = "re_legacy_plaintext";
    legacy.security.captchaSecret = "legacy-captcha";
    await db.db.insert(s.instance).values({ id: "default", settings: legacy as never });

    const store = await createSettingsStore(db.db, { encryptionKey });
    // Plaintext reads correctly…
    expect(store.get().email.resendApiKey).toBe("re_legacy_plaintext");
    expect(store.get().security.captchaSecret).toBe("legacy-captcha");

    // …and the next write seals it.
    await store.update({ application: { name: "Next" } });
    const row = (await db.db.select().from(s.instance).where(eq(s.instance.id, "default")))[0]!;
    const tree = row.settings as Record<string, any>;
    expect(isSealedSecret(tree.email.resendApiKey)).toBe(true);
    expect(isSealedSecret(tree.security.captchaSecret)).toBe(true);
    expect(JSON.stringify(row.settings)).not.toContain("re_legacy_plaintext");

    // A fresh store (another process) decrypts it back to the same plaintext.
    const reopened = await createSettingsStore(db.db, { encryptionKey });
    expect(reopened.get().email.resendApiKey).toBe("re_legacy_plaintext");
    await db.close();
  });

  it("does not seal a value twice", async () => {
    const h = await seeded();
    await h.api("PATCH", "/v1/instance", { application: { name: "Again" } });
    await h.api("PATCH", "/v1/instance", { application: { name: "Once more" } });
    expect(h.ctx.settings.get().email.resendApiKey).toBe(SECRETS.resend);
    const row = (await h.ctx.db.select().from(s.instance).where(eq(s.instance.id, "default")))[0]!;
    const value = (row.settings as Record<string, any>).email.resendApiKey as string;
    expect(value.match(/^v1\./g)?.length).toBe(1);
  });

  it("survives an unreadable ciphertext (wrong key) without crashing the instance", async () => {
    const db = await import("../../src/db").then(async (m) => {
      const handle = await m.createDb(":memory:");
      await m.runMigrations(handle);
      return handle;
    });
    const settingsModule = await import("@orbitid/shared");
    const settings = settingsModule.defaultInstanceSettings();
    settings.email.resendApiKey = "v1.AAAA.BBBB.CCCC";
    await db.db.insert(s.instance).values({ id: "default", settings: settings as never });
    const store = await createSettingsStore(db.db, { encryptionKey: "y".repeat(40) });
    expect(store.get().email.resendApiKey).toBe("");
    await db.close();
  });
});

describe("secret helpers", () => {
  it("masks, drops masks from a patch and seals without touching other fields", async () => {
    const settings = (await import("@orbitid/shared")).defaultInstanceSettings();
    settings.email.smtpUrl = SECRETS.smtp;
    settings.email.from = "OrbitID <no-reply@example.com>";

    const masked = maskSecrets(settings) as Record<string, any>;
    expect(masked.email.smtpUrl).toBe("••••");
    expect(masked.email.from).toBe("OrbitID <no-reply@example.com>");

    const patch = unmaskSettingsPatch(settings, { email: { smtpUrl: "••••", from: "New <no-reply@example.com>" } });
    expect((patch.email as Record<string, unknown>).smtpUrl).toBeUndefined();
    expect((patch.email as Record<string, unknown>).from).toBe("New <no-reply@example.com>");

    const sealed = openSecrets("k".repeat(40), settings) as Record<string, any>;
    expect(sealed.email.smtpUrl).toBe(SECRETS.smtp);
  });

  it("keeps webhook endpoint secrets out of list and detail responses", async () => {
    const h = await testApp();
    const created = await h.api("POST", "/v1/webhooks/endpoints", { url: "https://hooks.example.com/abc" });
    const endpoint = await created.json();
    expect(endpoint.secret).toMatch(/^whsec_/);

    const detail = await (await h.api("GET", `/v1/webhooks/endpoints/${endpoint.id}`)).json();
    expect(detail.secret).toBeUndefined();
    const list = await (await h.api("GET", "/v1/webhooks/endpoints")).json();
    expect(JSON.stringify(list)).not.toContain(endpoint.secret);
    // The dedicated, secret-key-only endpoint still returns it for signature verification setup.
    const revealed = await (await h.api("GET", `/v1/webhooks/endpoints/${endpoint.id}/secret`)).json();
    expect(revealed.secret).toBe(endpoint.secret);
  });
});

describe("environment projection", () => {
  it("never includes a secret in the public environment endpoint", async () => {
    const h = await seeded();
    const res = await h.app.request("/v1/client/environment");
    const text = await res.text();
    for (const secret of Object.values(SECRETS)) expect(text).not.toContain(secret.split("\n")[0]!);
    expect(text).not.toContain("••••");
  });
});
