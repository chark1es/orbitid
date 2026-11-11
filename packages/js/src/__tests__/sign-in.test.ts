import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitID } from "../orbit";
import { SignIn } from "../resources/sign-in";
import { FapiClient } from "../fapi";
import {
  ApiMock,
  API_URL,
  clearCookies,
  clientJSON,
  cookieValue,
  environmentJSON,
  fakeJwt,
  publishableKey,
  sessionJSON,
  signInJSON,
  signUpJSON,
} from "./helpers";

function newSlot() {
  const state = {
    signIn: signInJSON() as ReturnType<typeof signInJSON> | null,
    signUp: signUpJSON() as ReturnType<typeof signUpJSON> | null,
    client: clientJSON(),
    session: sessionJSON({ id: "sess_9" }),
    navigate: vi.fn<(url: string) => void>(),
  };
  return state;
}

describe("SignIn", () => {
  beforeEach(() => clearCookies());
  afterEach(() => clearCookies());

  it("runs password sign-in then activates the created session", async () => {
    const slot = newSlot();
    const token = fakeJwt({ sid: "sess_9" });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") return { body: { response: slot.client, client: slot.client } };
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sign_ins") {
        slot.signIn = signInJSON({ status: "needs_first_factor" });
        slot.client = clientJSON({ sign_in: slot.signIn });
        return { body: { response: slot.signIn, client: slot.client } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sign_ins/sia_1/attempt_first_factor") {
        slot.signIn = signInJSON({ status: "complete", created_session_id: "sess_9", first_factor_verification: { status: "verified", strategy: "password", attempts: null, expire_at: null } });
        slot.client = clientJSON({ sign_in: slot.signIn, sessions: [slot.session], last_active_session_id: null });
        return { body: { response: slot.signIn, client: slot.client } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_9/touch") {
        slot.client = clientJSON({ sessions: [slot.session], last_active_session_id: "sess_9" });
        return { body: { response: slot.session, client: slot.client } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_9/tokens") return { body: { jwt: token } };
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
    });

    const orbit = new OrbitID(publishableKey, { fetch: api.fetch, navigate: { push: slot.navigate } });
    await orbit.load();
    expect(orbit.isSignedIn).toBe(false);
    expect(orbit.signIn.status).toBe("needs_identifier");

    const signIn = orbit.signIn;
    await signIn.create({ identifier: "ada@example.com" });
    expect(signIn.status).toBe("needs_first_factor");
    expect(signIn.supportedFirstFactors?.[0]?.strategy).toBe("password");
    expect(orbit.signIn.status).toBe("needs_first_factor");
    expect(api.lastCall("POST", "/v1/client/sign_ins")?.body?.identifier).toBe("ada@example.com");

    await signIn.attemptFirstFactor({ strategy: "password", password: "correct horse" });
    expect(signIn.status).toBe("complete");
    expect(signIn.createdSessionId).toBe("sess_9");
    // The session exists but is not active until setActive.
    expect(orbit.isSignedIn).toBe(false);

    await orbit.setActive({ session: "sess_9" });
    expect(orbit.isSignedIn).toBe(true);
    expect(orbit.session?.id).toBe("sess_9");
    expect(orbit.user?.id).toBe("user_1");
    expect(api.lastCall("POST", "/v1/client/sessions/sess_9/touch")?.body).toEqual({});
    expect(cookieValue("__session")).toBe(token);
    expect(Number(cookieValue("__client_uat"))).toBeGreaterThan(0);
    orbit.dispose();
  });

  it("supports email-code and second-factor steps", async () => {
    const slot = newSlot();
    slot.client = clientJSON({ sign_in: signInJSON({ status: "needs_second_factor" }) });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") return { body: { response: slot.client, client: slot.client } };
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sign_ins/sia_1/prepare_first_factor") {
        return { body: { response: signInJSON({ status: "needs_first_factor" }), client: slot.client } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sign_ins/sia_1/prepare_second_factor") {
        return { body: { response: signInJSON({ status: "needs_second_factor", second_factor_verification: { status: "unverified", strategy: "totp", attempts: 0, expire_at: null } }), client: slot.client } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sign_ins/sia_1/attempt_second_factor") {
        return { body: { response: signInJSON({ status: "complete", created_session_id: "sess_9" }), client: slot.client } };
      }
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const signIn = orbit.signIn;
    await signIn.prepareFirstFactor({ strategy: "email_code", emailAddressId: "idn_e1" });
    expect(api.lastCall("POST", "/v1/client/sign_ins/sia_1/prepare_first_factor")?.body).toEqual({ strategy: "email_code", email_address_id: "idn_e1" });
    await signIn.prepareSecondFactor({ strategy: "totp" });
    await signIn.attemptSecondFactor({ strategy: "totp", code: "123456" });
    expect(signIn.status).toBe("complete");
    orbit.dispose();
  });

  it("navigates to the provider for OAuth/SSO sign-in", async () => {
    const navigate = vi.fn<(url: string) => void>();
    const redirect = "https://accounts.google.com/o/oauth2/v2/auth?client_id=abc";
    const api = new ApiMock((call) => {
      if (call.method === "POST" && call.path === "/v1/client/sign_ins") {
        return {
          body: {
            response: signInJSON({
              status: "needs_first_factor",
              first_factor_verification: {
                status: "unverified",
                strategy: "oauth_google",
                attempts: 0,
                expire_at: null,
                external_verification_redirect_url: redirect,
              },
            }),
          },
        };
      }
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch, navigate: { push: navigate } });
    await orbit.signIn.authenticateWithRedirect({
      strategy: "oauth_google",
      redirectUrl: "https://app.example.com/sso",
      redirectUrlComplete: "https://app.example.com/dashboard",
    });
    const call = api.lastCall("POST", "/v1/client/sign_ins");
    expect(call?.body?.strategy).toBe("oauth_google");
    expect(call?.body?.redirect_url).toBe("https://app.example.com/sso");
    expect(call?.body?.action_complete_redirect_url).toBe("https://app.example.com/dashboard");
    expect(navigate).toHaveBeenCalledWith(redirect);
    orbit.dispose();
  });

  it("transfers a transferable OAuth sign-in into sign-up", async () => {
    const navigate = vi.fn<(url: string) => void>();
    const api = new ApiMock((call) => {
      if (call.method === "POST" && call.path === "/v1/client/sign_ins") return { body: { response: signInJSON({ status: "needs_identifier" }) } };
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch, navigate: { push: navigate } });
    await orbit.signIn.create({ transfer: true });
    expect(api.lastCall("POST", "/v1/client/sign_ins")?.body?.transfer).toBe(true);
    expect(navigate).not.toHaveBeenCalled();
    orbit.dispose();
  });

  it("exposes a reset that has to sign in again with the new password", async () => {
    const failure = {
      code: "needs_second_factor",
      message: "MFA is required. Sign in with your new password to complete a second factor.",
    };
    const api = new ApiMock((call) => {
      if (call.method === "POST" && call.path === "/v1/client/sign_ins/sia_1/reset_password") {
        return {
          body: {
            response: signInJSON({
              status: "needs_first_factor",
              first_factor_verification: {
                status: "unverified",
                strategy: "password",
                attempts: null,
                expire_at: null,
                error: failure,
              },
            }),
          },
        };
      }
      return { status: 404, body: {} };
    });
    const fapi = new FapiClient({ publishableKey, fetch: api.fetch, frontendApi: API_URL });
    const signIn = new SignIn(fapi, signInJSON({ status: "needs_new_password" }));
    await signIn.resetPassword({ password: "N3w-Password!23" });
    expect(signIn.status).toBe("needs_first_factor");
    expect(signIn.supportedFirstFactors?.[0]?.strategy).toBe("password");
    expect(signIn.firstFactorVerification?.strategy).toBe("password");
    expect(signIn.firstFactorVerification?.error).toEqual(failure);
    expect(api.lastCall("POST", "/v1/client/sign_ins/sia_1/reset_password")?.body?.password).toBe("N3w-Password!23");
  });

  it("polls a magic-link flow and can cancel it", async () => {
    vi.useFakeTimers();
    try {
      let polls = 0;
      const api = new ApiMock((call) => {
        if (call.method === "POST" && call.path === "/v1/client/sign_ins/sia_1/prepare_first_factor") {
          return { body: { response: signInJSON({ supported_first_factors: [{ strategy: "email_link", email_address_id: "idn_e1" }] }) } };
        }
        if (call.method === "GET" && call.path === "/v1/client/sign_ins/sia_1") {
          polls += 1;
          return { body: { response: signInJSON({ status: polls >= 2 ? "complete" : "needs_first_factor" }) } };
        }
        return { status: 404, body: {} };
      });
      const fapi = new FapiClient({ publishableKey, fetch: api.fetch, frontendApi: API_URL });
      const signIn = new SignIn(fapi, signInJSON({ supported_first_factors: [{ strategy: "email_link", email_address_id: "idn_e1" }] }));
      const flow = signIn.createEmailLinkFlow({ pollingIntervalMs: 10 });
      expect(signIn.supportedFirstFactors?.[0]?.emailAddressId).toBe("idn_e1");
      const handle = await flow.startEmailLinkFlow({ redirectUrl: "https://app.example.com/continue" });
      expect(api.lastCall("POST", "/v1/client/sign_ins/sia_1/prepare_first_factor")?.body).toEqual({
        strategy: "email_link",
        email_address_id: "idn_e1",
        redirect_url: "https://app.example.com/continue",
      });
      await vi.advanceTimersByTimeAsync(25);
      expect(polls).toBeGreaterThanOrEqual(2);
      expect(signIn.status).toBe("complete");
      handle.cancel();
      await vi.advanceTimersByTimeAsync(50);
      expect(polls).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
