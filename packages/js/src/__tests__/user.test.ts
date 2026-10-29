import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@simplewebauthn/browser", () => ({
  startRegistration: vi.fn(async () => ({ id: "cred_1", rawId: "cred_1", type: "public-key", response: { clientDataJSON: "x" } })),
  startAuthentication: vi.fn(),
}));

import { startRegistration } from "@simplewebauthn/browser";
import { OrbitID } from "../orbit";
import {
  ApiMock,
  clearCookies,
  clientJSON,
  emailJSON,
  environmentJSON,
  fakeJwt,
  publishableKey,
  sessionJSON,
  userJSON,
} from "./helpers";

const now = Date.now();

function passkeyJSON(overrides: Record<string, unknown> = {}) {
  return {
    object: "passkey",
    id: "pkey_1",
    name: "MacBook",
    verification: { status: "verified", strategy: "passkey", attempts: null, expire_at: null },
    last_used_at: null,
    created_at: now,
    updated_at: now,
    ...overrides,
  };
}

describe("user resources", () => {
  beforeEach(() => clearCookies());
  afterEach(() => clearCookies());

  async function setup() {
    let user = userJSON();
    const navigate = vi.fn<(url: string) => void>();
    const api = new ApiMock((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "GET /v1/client") {
        const client = clientJSON({ sessions: [sessionJSON({ user })], last_active_session_id: "sess_1" });
        return { body: { response: client, client } };
      }
      if (key === "GET /v1/client/environment") return { body: { response: environmentJSON() } };
      if (key === "POST /v1/client/sessions/sess_1/tokens") return { body: { jwt: fakeJwt() } };
      if (key === "PATCH /v1/client/me") {
        user = userJSON({ first_name: "Grace", username: "grace", email_addresses: [emailJSON(), emailJSON({ id: "idn_e2", email_address: "new@example.com" })], primary_email_address_id: "idn_e2" });
        return { body: { response: user } };
      }
      if (key === "POST /v1/client/me/change_password") return { body: { response: user } };
      if (key === "POST /v1/client/me/remove_password") {
        user = userJSON({ password_enabled: false });
        return { body: { response: user } };
      }
      if (key === "GET /v1/client/me/email_addresses") return { body: { response: [emailJSON()] } };
      if (key === "POST /v1/client/me/email_addresses") {
        return { body: { response: emailJSON({ id: "idn_e2", email_address: "new@example.com", verification: { status: "unverified", strategy: "email_code", attempts: 0, expire_at: now + 600_000 } }) } };
      }
      if (key.endsWith("/email_addresses/idn_e2/prepare_verification")) {
        return { body: { response: emailJSON({ id: "idn_e2", email_address: "new@example.com", verification: { status: "unverified", strategy: "email_code", attempts: 0, expire_at: now + 600_000 } }) } };
      }
      if (key.endsWith("/email_addresses/idn_e2/attempt_verification")) {
        return { body: { response: emailJSON({ id: "idn_e2", email_address: "new@example.com" }) } };
      }
      if (key.startsWith("DELETE /v1/client/me/email_addresses/")) return { body: { response: { object: "email_address", id: "idn_e2", deleted: true } } };
      if (key === "POST /v1/client/me/phone_numbers") {
        return {
          body: {
            response: {
              object: "phone_number",
              id: "idn_p1",
              phone_number: "+15551234567",
              reserved_for_second_factor: false,
              default_second_factor: false,
              verification: { status: "unverified", strategy: "phone_code", attempts: 0, expire_at: null },
              linked_to: [],
              created_at: now,
              updated_at: now,
            },
          },
        };
      }
      if (key === "PATCH /v1/client/me/phone_numbers/idn_p1") {
        const body = call.body ?? {};
        return {
          body: {
            response: {
              object: "phone_number",
              id: "idn_p1",
              phone_number: "+15551234567",
              reserved_for_second_factor: body.reserved_for_second_factor ?? true,
              default_second_factor: body.default_second_factor ?? false,
              verification: { status: "verified", strategy: "phone_code", attempts: null, expire_at: null },
              linked_to: [],
              created_at: now,
              updated_at: now,
            },
          },
        };
      }
      if (key === "POST /v1/client/me/external_accounts") {
        return {
          body: {
            response: {
              object: "external_account",
              id: "eac_1",
              provider: "google",
              provider_user_id: "google_1",
              identification_id: "eac_1",
              email_address: "ada@gmail.com",
              first_name: "Ada",
              last_name: "Lovelace",
              username: null,
              image_url: null,
              avatar_url: null,
              approved_scopes: "email",
              public_metadata: {},
              label: null,
              verification: null,
              created_at: now,
              updated_at: now,
              external_verification_redirect_url: "https://accounts.google.com/o/oauth2/auth?x=1",
            },
          },
        };
      }
      if (key === "POST /v1/client/me/totp") {
        return { body: { response: { secret: "JBSWY3DPEHPK3PXP", uri: "otpauth://totp/Acme:ada@example.com?secret=JBSWY3DPEHPK3PXP", qr_code: "data:image/png;base64,abc", verified: false } } };
      }
      if (key === "POST /v1/client/me/totp/attempt_verification") {
        return {
          body: {
            response: {
              secret: "JBSWY3DPEHPK3PXP",
              verified: true,
              backup_codes: [
                { object: "backup_code", code: "aaaa-1111", used: false },
                { object: "backup_code", code: "bbbb-2222", used: false },
              ],
            },
          },
        };
      }
      if (key === "DELETE /v1/client/me/totp") return { body: { response: { object: "totp", deleted: true } } };
      if (key === "POST /v1/client/me/backup_codes") {
        return {
          body: {
            response: [
              { object: "backup_code", code: "abcd1234", used: false },
              { object: "backup_code", code: "efgh5678", used: false },
            ],
          },
        };
      }
      if (key === "POST /v1/client/me/passkeys") {
        return {
          body: {
            response: {
              object: "passkey",
              id: "pkey_1",
              name: "Work laptop",
              verification: { status: "unverified", strategy: "passkey", attempts: null, expire_at: null, nonce: "challenge" },
              public_key_credential_creation_options: {
                challenge: "challenge",
                rp: { id: "app.example.com", name: "Acme" },
                user: { id: "dXNlcg", name: "ada@example.com", displayName: "Ada" },
                pubKeyCredParams: [{ type: "public-key", alg: -7 }],
                timeout: 60_000,
                attestation: "none",
              },
              last_used_at: null,
              created_at: now,
              updated_at: now,
            },
          },
        };
      }
      if (key === "POST /v1/client/me/passkeys/pkey_1/attempt_verification") return { body: { response: passkeyJSON() } };
      if (key === "PATCH /v1/client/me/passkeys/pkey_1") return { body: { response: passkeyJSON({ name: "Work laptop" }) } };
      if (key === "DELETE /v1/client/me/passkeys/pkey_1") return { body: { response: { object: "passkey", id: "pkey_1", deleted: true } } };
      if (key === "GET /v1/client/sessions") return { body: { response: [sessionJSON({ id: "sess_1" }), sessionJSON({ id: "sess_2" })] } };
      if (key === "POST /v1/client/me/sessions/sess_2/revoke") return { body: { response: { object: "session", id: "sess_2", status: "revoked" } } };
      if (key === "POST /v1/client/me/profile_image") return { body: { response: userJSON({ has_image: true, image_url: "https://img.example.com/new.png" }) } };
      if (key === "DELETE /v1/client/me/profile_image") return { body: { response: userJSON({ has_image: false }) } };
      if (key === "DELETE /v1/client/me") return { body: { response: { object: "user", id: "user_1", deleted: true } } };
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: key }] } };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch, navigate: { push: navigate } });
    await orbit.load();
    return { orbit, api, navigate };
  }

  it("updates profile fields and metadata with snake_case bodies", async () => {
    const { orbit, api } = await setup();
    const user = orbit.user!;
    await user.update({ firstName: "Grace", username: "grace", publicMetadata: { plan: "pro" } });
    expect(api.lastCall("PATCH", "/v1/client/me")?.body).toEqual({ first_name: "Grace", username: "grace", public_metadata: { plan: "pro" } });
    expect(user.firstName).toBe("Grace");
    expect(user.emailAddresses).toHaveLength(2);
    expect(user.primaryEmailAddress?.id).toBe("idn_e2");
    orbit.dispose();
  });

  it("manages email addresses end to end", async () => {
    const { orbit, api } = await setup();
    const user = orbit.user!;
    const email = await user.createEmailAddress({ email: "new@example.com" });
    expect(api.lastCall("POST", "/v1/client/me/email_addresses")?.body).toEqual({ email_address: "new@example.com" });
    expect(email.id).toBe("idn_e2");
    expect(user.emailAddresses.some((candidate) => candidate.id === "idn_e2")).toBe(true);

    await email.prepareVerification({ strategy: "email_code" });
    expect(email.verification?.status).toBe("unverified");
    await email.attemptVerification({ code: "123456" });
    expect(email.isVerified).toBe(true);
    expect(api.lastCall("POST", "/v1/client/me/email_addresses/idn_e2/attempt_verification")?.body).toEqual({ code: "123456" });

    await email.setAsPrimary();
    expect(api.lastCall("PATCH", "/v1/client/me")?.body).toEqual({ primary_email_address_id: "idn_e2" });
    expect(user.primaryEmailAddress?.id).toBe("idn_e2");
    expect(user.primaryEmailAddressId).toBe("idn_e2");

    await email.destroy();
    expect(api.lastCall("DELETE", "/v1/client/me/email_addresses/idn_e2")).toBeDefined();
    orbit.dispose();
  });

  it("manages phone numbers and second factors", async () => {
    const { orbit, api } = await setup();
    const user = orbit.user!;
    const phone = await user.createPhoneNumber({ phoneNumber: "+15551234567" });
    expect(phone.phoneNumber).toBe("+15551234567");
    await phone.setReservedForSecondFactor({ reserved: true });
    expect(api.lastCall("PATCH", "/v1/client/me/phone_numbers/idn_p1")?.body).toEqual({ reserved_for_second_factor: true });
    await phone.makeDefaultSecondFactor();
    expect(api.lastCall("PATCH", "/v1/client/me/phone_numbers/idn_p1")?.body).toEqual({ default_second_factor: true });
    expect(phone.defaultSecondFactor).toBe(true);
    orbit.dispose();
  });

  it("changes and removes passwords", async () => {
    const { orbit, api } = await setup();
    const user = orbit.user!;
    await user.updatePassword({ currentPassword: "old", newPassword: "new-secret", signOutOfOtherSessions: true });
    expect(api.lastCall("POST", "/v1/client/me/change_password")?.body).toEqual({
      current_password: "old",
      new_password: "new-secret",
      sign_out_of_other_sessions: true,
    });
    await user.removePassword({ currentPassword: "new-secret" });
    expect(user.passwordEnabled).toBe(false);
    orbit.dispose();
  });

  it("sets up TOTP and backup codes", async () => {
    const { orbit, api } = await setup();
    const user = orbit.user!;
    const totp = await user.createTOTP();
    expect(totp.secret).toBe("JBSWY3DPEHPK3PXP");
    expect(user.totpEnabled).toBe(false);
    expect(totp.qrCode).toContain("data:image/png");
    expect(totp.uri).toContain("otpauth://");
    const verified = await user.verifyTOTP({ code: "123456" });
    expect(api.lastCall("POST", "/v1/client/me/totp/attempt_verification")?.body).toEqual({ code: "123456" });
    expect(verified.backupCodes).toEqual(["aaaa-1111", "bbbb-2222"]);
    expect(user.totpEnabled).toBe(true);
    await user.disableTOTP();
    expect(api.lastCall("DELETE", "/v1/client/me/totp")).toBeDefined();
    expect(user.totpEnabled).toBe(false);

    const backup = await user.createBackupCode();
    expect(backup.codes).toEqual(["abcd1234", "efgh5678"]);
    expect(user.backupCodeEnabled).toBe(true);
    orbit.dispose();
  });

  it("registers a passkey through WebAuthn", async () => {
    const { orbit, api } = await setup();
    const user = orbit.user!;
    const passkey = await user.createPasskey({ name: "Work laptop" });
    expect(api.lastCall("POST", "/v1/client/me/passkeys")?.body).toEqual({ name: "Work laptop" });
    expect(startRegistration).toHaveBeenCalledTimes(1);
    expect(startRegistration).toHaveBeenCalledWith({ optionsJSON: expect.objectContaining({ challenge: "challenge" }) });
    expect(api.lastCall("POST", "/v1/client/me/passkeys/pkey_1/attempt_verification")?.body).toMatchObject({
      public_key_credential: { id: "cred_1" },
    });
    expect(passkey.id).toBe("pkey_1");
    expect(user.passkeys.map((item) => item.id)).toContain("pkey_1");

    await passkey.rename({ name: "Work laptop" });
    expect(passkey.name).toBe("Work laptop");
    await passkey.delete();
    orbit.dispose();
  });

  it("links external accounts and navigates to the provider", async () => {
    const { orbit, api, navigate } = await setup();
    const account = await orbit.user!.createExternalAccount({ strategy: "oauth_google", redirectUrl: "/link" });
    expect(api.lastCall("POST", "/v1/client/me/external_accounts")?.body).toEqual({ strategy: "oauth_google", redirect_url: "/link", additional_scopes: undefined });
    expect(account.provider).toBe("google");
    expect(navigate).toHaveBeenCalledWith("https://accounts.google.com/o/oauth2/auth?x=1");
    orbit.dispose();
  });

  it("lists and revokes other sessions and manages the profile image", async () => {
    const { orbit, api } = await setup();
    const user = orbit.user!;
    const sessions = await user.getSessions();
    expect(sessions.map((session) => session.id)).toEqual(["sess_1", "sess_2"]);
    await user.revokeSession("sess_2");
    expect(api.lastCall("POST", "/v1/client/me/sessions/sess_2/revoke")).toBeDefined();

    await user.setProfileImage({ file: new Blob(["image"], { type: "image/png" }) });
    expect(user.hasImage).toBe(true);
    expect(api.lastCall("POST", "/v1/client/me/profile_image")?.body).toBeUndefined();
    await user.deleteProfileImage();
    expect(user.hasImage).toBe(false);
    await user.delete();
    expect(api.lastCall("DELETE", "/v1/client/me")).toBeDefined();
    orbit.dispose();
  });
});
