import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbitID } from "../orbit";
import { ApiMock, clearCookies, clientJSON, cookieValue, environmentJSON, fakeJwt, publishableKey, sessionJSON, signUpJSON } from "./helpers";

describe("SignUp", () => {
  beforeEach(() => clearCookies());
  afterEach(() => clearCookies());

  it("creates a sign-up, verifies the email, then activates the session", async () => {
    let signUp = signUpJSON();
    let client = clientJSON();
    const session = sessionJSON({ id: "sess_5" });
    const token = fakeJwt({ sid: "sess_5" });
    const api = new ApiMock((call) => {
      if (call.method === "GET" && call.path === "/v1/client") return { body: { response: client, client } };
      if (call.method === "GET" && call.path === "/v1/client/environment") return { body: { response: environmentJSON() } };
      if (call.method === "POST" && call.path === "/v1/client/sign_ups") {
        signUp = signUpJSON({ status: "missing_requirements", email_address: "new@example.com" });
        client = clientJSON({ sign_up: signUp });
        return { body: { response: signUp, client } };
      }
      if (call.method === "PATCH" && call.path === "/v1/client/sign_ups/sua_1") {
        signUp = signUpJSON({ ...signUp, first_name: "New" });
        client = clientJSON({ sign_up: signUp });
        return { body: { response: signUp, client } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sign_ups/sua_1/prepare_verification") {
        signUp = signUpJSON({
          ...signUp,
          verifications: { ...signUp.verifications, email_address: { status: "unverified", strategy: "email_code", attempts: 0, expire_at: null } },
        });
        client = clientJSON({ sign_up: signUp });
        return { body: { response: signUp, client } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sign_ups/sua_1/attempt_verification") {
        signUp = signUpJSON({
          ...signUp,
          status: "complete",
          unverified_fields: [],
          created_session_id: "sess_5",
          created_user_id: "user_5",
          verifications: {
            ...signUp.verifications,
            email_address: { status: "verified", strategy: "email_code", attempts: null, expire_at: null },
          },
        });
        client = clientJSON({ sign_up: signUp, sessions: [session], last_active_session_id: null });
        return { body: { response: signUp, client } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_5/touch") {
        client = clientJSON({ sessions: [session], last_active_session_id: "sess_5" });
        return { body: { response: session, client } };
      }
      if (call.method === "POST" && call.path === "/v1/client/sessions/sess_5/tokens") return { body: { jwt: token } };
      return { status: 404, body: { errors: [{ code: "resource_not_found", message: call.path }] } };
    });

    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.load();
    const signUpResource = orbit.signUp;
    await signUpResource.create({ emailAddress: "new@example.com", password: "super-secret-1" });
    expect(signUpResource.status).toBe("missing_requirements");
    expect(signUpResource.unverifiedFields).toEqual(["email_address"]);
    expect(signUpResource.emailAddressVerification?.status).toBe("unverified");
    expect(api.lastCall("POST", "/v1/client/sign_ups")?.body).toMatchObject({ email_address: "new@example.com", password: "super-secret-1" });

    await signUpResource.update({ firstName: "New" });
    expect(api.lastCall("PATCH", "/v1/client/sign_ups/sua_1")?.body?.first_name).toBe("New");

    await signUpResource.prepareEmailAddressVerification({ strategy: "email_code" });
    expect(api.lastCall("POST", "/v1/client/sign_ups/sua_1/prepare_verification")?.body).toMatchObject({ strategy: "email_code" });

    await signUpResource.attemptEmailAddressVerification({ code: "123456" });
    expect(signUpResource.status).toBe("complete");
    expect(signUpResource.createdSessionId).toBe("sess_5");
    expect(signUpResource.createdUserId).toBe("user_5");
    expect(signUpResource.verifications.emailAddress?.status).not.toBe("unverified");

    await orbit.setActive({ session: signUpResource.createdSessionId });
    expect(orbit.isSignedIn).toBe(true);
    expect(cookieValue("__session")).toBe(token);
    orbit.dispose();
  });

  it("navigates to the provider for OAuth sign-up", async () => {
    const navigate = vi.fn<(url: string) => void>();
    const redirect = "https://github.com/login/oauth/authorize?client_id=x";
    const api = new ApiMock((call) => {
      if (call.method === "POST" && call.path === "/v1/client/sign_ups") {
        return {
          body: {
            response: signUpJSON({
              verifications: {
                email_address: null,
                phone_number: null,
                external_account: { status: "unverified", strategy: "from_oauth_github", attempts: 0, expire_at: null, external_verification_redirect_url: redirect },
                web3_wallet: null,
              },
            }),
          },
        };
      }
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch, navigate: { push: navigate } });
    await orbit.signUp.authenticateWithRedirect({
      strategy: "oauth_github",
      redirectUrl: "https://app.example.com/sso",
      redirectUrlComplete: "https://app.example.com/after",
    });
    expect(navigate).toHaveBeenCalledWith(redirect);
    orbit.dispose();
  });

  it("creates a transferable sign-up", async () => {
    const api = new ApiMock((call) => {
      if (call.method === "POST" && call.path === "/v1/client/sign_ups") return { body: { response: signUpJSON() } };
      return { status: 404, body: {} };
    });
    const orbit = new OrbitID(publishableKey, { fetch: api.fetch });
    await orbit.signUp.create({ transfer: true });
    expect(api.lastCall("POST", "/v1/client/sign_ups")?.body?.transfer).toBe(true);
    orbit.dispose();
  });
});
