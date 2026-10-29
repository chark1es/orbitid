import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitID } from "../orbit";
import {
  ApiMock,
  clearCookies,
  clientJSON,
  environmentJSON,
  fakeJwt,
  publishableKey,
  sessionJSON,
  signInJSON,
  signUpJSON,
  userJSON,
} from "./helpers";

describe("trusted devices, email second factor and guest accounts", () => {
  beforeEach(() => clearCookies());
  afterEach(() => clearCookies());

  function setup(overrides: { environment?: ReturnType<typeof environmentJSON>; user?: ReturnType<typeof userJSON> } = {}) {
    const session = sessionJSON({ id: "sess_1" });
    const user = overrides.user ?? userJSON({ is_anonymous: true });
    const api = new ApiMock((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "GET /v1/client") {
        const client = clientJSON({
          sessions: [{ ...session, user }],
          last_active_session_id: "sess_1",
          sign_in: signInJSON({ id: "sia_1", status: "needs_second_factor" }),
        });
        return { body: { response: client, client } };
      }
      if (key === "GET /v1/client/environment") {
        return { body: { response: overrides.environment ?? environmentJSON() } };
      }
      if (key === "POST /v1/client/sessions/sess_1/tokens") return { body: { jwt: fakeJwt() } };
      if (key === "POST /v1/client/sign_ins/sia_1/prepare_second_factor") {
        return { body: { response: signInJSON({ status: "needs_second_factor" }) } };
      }
      if (key === "POST /v1/client/sign_ins/sia_1/attempt_second_factor") {
        return {
          body: {
            response: signInJSON({ status: "complete", created_session_id: "sess_1", second_factor_verification: { status: "verified", strategy: "email_code", attempts: null, expire_at: null } }),
          },
        };
      }
      if (key === "GET /v1/client/me/trusted_devices") {
        return {
          body: {
            response: [
              { object: "trusted_device", id: "tdev_1", user_id: "user_1", label: "Trusted browser", user_agent: "Mozilla", ip_address: "127.0.0.1", expires_at: Date.now() + 1000, last_used_at: null, revoked_at: null, created_at: Date.now(), updated_at: Date.now() },
            ],
          },
        };
      }
      if (key === "DELETE /v1/client/me/trusted_devices/tdev_1") return { body: { response: { object: "trusted_device", id: "tdev_1", deleted: true } } };
      if (key === "POST /v1/client/sign_ups") {
        const signUp = signUpJSON({ status: "complete", created_session_id: "sess_1", created_user_id: "user_1" });
        const client = clientJSON({ sign_up: signUp, sessions: [{ ...session, user }], last_active_session_id: "sess_1" });
        return { body: { response: signUp, client } };
      }
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    return { api, orbit, user };
  }

  it("sends trust_device when the caller asks to remember the browser", async () => {
    const { api, orbit } = setup();
    await orbit.load();
    await orbit.signIn.attemptSecondFactor({ strategy: "email_code", code: "123456", trustDevice: true });
    const call = api.lastCall("POST", "/v1/client/sign_ins/sia_1/attempt_second_factor");
    expect(call?.body).toMatchObject({ strategy: "email_code", code: "123456", trust_device: true });
    orbit.dispose();
  });

  it("omits trust_device by default", async () => {
    const { api, orbit } = setup();
    await orbit.load();
    await orbit.signIn.attemptSecondFactor({ strategy: "totp", code: "123456" });
    const call = api.lastCall("POST", "/v1/client/sign_ins/sia_1/attempt_second_factor");
    expect(call?.body?.trust_device).toBeUndefined();
    orbit.dispose();
  });

  it("passes the email address id when preparing an email second factor", async () => {
    const { api, orbit } = setup();
    await orbit.load();
    await orbit.signIn.prepareSecondFactor({ strategy: "email_code", emailAddressId: "idn_e1" });
    expect(api.lastCall("POST", "/v1/client/sign_ins/sia_1/prepare_second_factor")?.body).toMatchObject({
      strategy: "email_code",
      email_address_id: "idn_e1",
    });
    orbit.dispose();
  });

  it("creates a guest account with strategy anonymous", async () => {
    const { api, orbit } = setup();
    await orbit.load();
    const signUp = await orbit.signUp.createAnonymous();
    expect(signUp.status).toBe("complete");
    expect(api.lastCall("POST", "/v1/client/sign_ups")?.body).toMatchObject({ strategy: "anonymous" });
    orbit.dispose();
  });

  it("exposes user.isAnonymous", async () => {
    const { orbit } = setup({ user: userJSON({ is_anonymous: true }) });
    await orbit.load();
    expect(orbit.user?.isAnonymous).toBe(true);
    orbit.dispose();
  });

  it("lists and revokes trusted devices", async () => {
    const { api, orbit } = setup();
    await orbit.load();
    const devices = await orbit.user!.getTrustedDevices();
    expect(devices).toHaveLength(1);
    expect(devices[0]!.id).toBe("tdev_1");
    expect(devices[0]!.label).toBe("Trusted browser");
    expect(JSON.stringify(devices[0])).not.toContain("token");
    await devices[0]!.revoke();
    expect(api.lastCall("DELETE", "/v1/client/me/trusted_devices/tdev_1")).toBeDefined();
    orbit.dispose();
  });

  it("reads trusted device settings from the environment", async () => {
    const environment = environmentJSON();
    environment.auth_config.trusted_devices = { enabled: true, days: 14 };
    environment.auth_config.anonymous = { enabled: true };
    const { orbit } = setup({ environment });
    await orbit.load();
    expect(orbit.environment?.authConfig.trustedDevices).toEqual({ enabled: true, days: 14 });
    expect(orbit.environment?.authConfig.anonymous.enabled).toBe(true);
    orbit.dispose();
  });

  it("exposes how a session was created and whether a trusted device skipped the second factor", async () => {
    const api = new ApiMock((call) => {
      const key = `${call.method} ${call.path}`;
      if (key === "GET /v1/client") {
        const session = { ...sessionJSON({ id: "sess_1" }), user: userJSON(), sign_in_method: "passkey" as const, second_factor_skipped_by_trusted_device: true };
        const client = clientJSON({ sessions: [session], last_active_session_id: "sess_1" });
        return { body: { response: client, client } };
      }
      if (key === "GET /v1/client/environment") return { body: { response: environmentJSON() } };
      if (key === "POST /v1/client/sessions/sess_1/tokens") return { body: { jwt: fakeJwt() } };
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    expect(orbit.session?.signInMethod).toBe("passkey");
    expect(orbit.session?.secondFactorSkippedByTrustedDevice).toBe(true);
    orbit.dispose();
  });
});
