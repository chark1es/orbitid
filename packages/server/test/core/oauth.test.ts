import { afterEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as schema from "../../src/db/schema";
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import { registerOAuthProvider, resetOAuthProviders, type OAuthAdapter } from "../../src/services/oauth-providers";
import type { AppContext } from "../../src/context";
import type { ExternalProfile } from "../../src/services/external-identity";
import { errorsOf, getClient, setup, signUpUser, testClient } from "./helpers";

function fakeGoogle(profile: ExternalProfile) {
  return (): OAuthAdapter => ({
    key: "google",
    async createAuthorizationUrl({ state, codeVerifier, scopes }) {
      const url = new URL("https://fake-google.example/authorize");
      url.searchParams.set("state", state);
      url.searchParams.set("code_challenge", codeVerifier);
      url.searchParams.set("scope", scopes.join(" "));
      return url;
    },
    async exchangeCode({ code }) {
      if (code !== "good-code") throw new OrbitError(400, ErrorCodes.oauth_callback_error, "bad code");
      return { accessToken: "access-token-value", refreshToken: "refresh-token-value", expiresAt: Date.now() + 3_600_000, scopes: "openid email", raw: {} };
    },
    async fetchProfile({ tokens }) {
      return { ...profile, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken, expiresAt: tokens.expiresAt, scopes: tokens.scopes };
    },
  });
}

async function enableGoogle(app: AppContext) {
  await app.settings.update({ social: { google: { enabled: true, clientId: "google-id", clientSecret: "google-secret", scopes: ["openid", "email"] } } });
}

afterEach(() => resetOAuthProviders());

describe("social OAuth", () => {
  it("makes unknown OAuth identities transferable, then completes the transferred sign-up", async () => {
    const { app, ctx } = await setup();
    await enableGoogle(ctx);
    registerOAuthProvider("google", fakeGoogle({ provider: "google", providerUserId: "g-123", email: "oauth@example.com", emailVerified: true, firstName: "Oauth", imageUrl: "https://img.example/a.png" }));

    const client = testClient(app);
    const started = await client.json<{ response: { status: string; id: string; first_factor_verification: { external_verification_redirect_url: string } } }>(
      "/v1/client/sign_ins",
      { body: { strategy: "oauth_google", redirect_url: "http://localhost:3000/done" } },
    );
    expect(started.response.status).toBe("needs_first_factor");
    const authorize = new URL(started.response.first_factor_verification.external_verification_redirect_url);
    expect(authorize.origin).toBe("https://fake-google.example");

    const callback = await client.request(`/v1/oauth_callback/google?state=${authorize.searchParams.get("state")}&code=good-code`);
    expect(callback.status).toBe(302);
    expect(callback.headers.get("location")).toContain("__orbit_status=transferable");

    const transferable = await getClient(client);
    expect(transferable.response.sign_in?.first_factor_verification?.status).toBe("transferable");

    const transferred = await client.json<{ response: { id: string; status: string; email_address: string; missing_fields: string[]; verifications: { external_account: { status: string } } } }>(
      "/v1/client/sign_ups",
      { body: { transfer: true } },
    );
    expect(transferred.response.status).toBe("missing_requirements");
    expect(transferred.response.email_address).toBe("oauth@example.com");
    expect(transferred.response.missing_fields).toEqual(["password"]);
    expect(transferred.response.verifications.external_account.status).toBe("verified");

    const completed = await client.json<{ response: { status: string; created_user_id: string; created_session_id: string } }>(
      `/v1/client/sign_ups/${transferred.response.id}`,
      { method: "PATCH", body: { password: "Sup3rSecret!" } },
    );
    expect(completed.response.status).toBe("complete");
    expect(completed.response.created_session_id).toMatch(/^sess_/);

    const external = ctx.db.select().from(schema.externalAccounts).where(eq(schema.externalAccounts.userId, completed.response.created_user_id)).get()!;
    expect(external.provider).toBe("google");
    expect(external.accessTokenEnc).not.toBe("access-token-value");
    expect(external.accessTokenEnc).toMatch(/^v1\./);
  });

  it("signs in an existing linked OAuth account", async () => {
    const { app, ctx } = await setup();
    await enableGoogle(ctx);
    registerOAuthProvider("google", fakeGoogle({ provider: "google", providerUserId: "g-999", email: "linked@example.com", emailVerified: true, firstName: "Link" }));

    // First flow: sign in with OAuth, transfer to sign-up, set password.
    const first = testClient(app);
    const started = await first.json<{ response: { first_factor_verification: { external_verification_redirect_url: string } } }>("/v1/client/sign_ins", {
      body: { strategy: "oauth_google", redirect_url: "http://localhost:3000/done" },
    });
    const authorize = new URL(started.response.first_factor_verification.external_verification_redirect_url);
    await first.request(`/v1/oauth_callback/google?state=${authorize.searchParams.get("state")}&code=good-code`);
    const transferred = await first.json<{ response: { id: string } }>("/v1/client/sign_ups", { body: { transfer: true } });
    await first.json(`/v1/client/sign_ups/${transferred.response.id}`, { method: "PATCH", body: { password: "Sup3rSecret!" } });

    // Second flow on a fresh client: the linked account signs straight in.
    const second = testClient(app);
    const startedAgain = await second.json<{ response: { first_factor_verification: { external_verification_redirect_url: string } } }>("/v1/client/sign_ins", {
      body: { strategy: "oauth_google", redirect_url: "http://localhost:3000/done" },
    });
    const authorizeAgain = new URL(startedAgain.response.first_factor_verification.external_verification_redirect_url);
    const callback = await second.request(`/v1/oauth_callback/google?state=${authorizeAgain.searchParams.get("state")}&code=good-code`);
    expect(callback.headers.get("location")).toContain("__orbit_status=complete");

    const state = await getClient(second);
    expect(state.response.sessions).toHaveLength(1);
    expect(state.response.sessions[0]!.status).toBe("active");
  });

  it("links an external account through /me/external_accounts and reports redirect errors", async () => {
    const { app, ctx } = await setup();
    await enableGoogle(ctx);
    registerOAuthProvider("google", fakeGoogle({ provider: "google", providerUserId: "g-connect", email: "connect@example.com", emailVerified: true }));
    const user = await signUpUser(app, { email: "connect-owner@example.com" });

    const created = await user.client.json<{ response: { verification: { external_verification_redirect_url: string } } }>("/v1/client/me/external_accounts", {
      body: { strategy: "oauth_google", redirect_url: "http://localhost:3000/account" },
    });
    const authorize = new URL(created.response.verification.external_verification_redirect_url);
    const callback = await user.client.request(`/v1/oauth_callback/google?state=${authorize.searchParams.get("state")}&code=good-code`);
    expect(callback.headers.get("location")).toContain("__orbit_status=connected");

    const accounts = await user.client.json<{ response: { id: string; provider: string; provider_user_id: string }[] }>("/v1/client/me/external_accounts");
    expect(accounts.response).toHaveLength(1);
    expect(accounts.response[0]!.provider).toBe("google");

    const token = await user.client.json<{ response: { token: string; scopes: string } }>(`/v1/client/me/external_accounts/${accounts.response[0]!.id}/access_token`);
    expect(token.response.token).toBe("access-token-value");
    expect(token.response.scopes).toBe("openid email");

    // An invalid code redirects back with __orbit_error instead of throwing.
    const restarted = await user.client.json<{ response: { verification: { external_verification_redirect_url: string } } }>("/v1/client/me/external_accounts", {
      body: { strategy: "oauth_google", redirect_url: "http://localhost:3000/account" },
    });
    const badAuthorize = new URL(restarted.response.verification.external_verification_redirect_url);
    const failed = await user.client.request(`/v1/oauth_callback/google?state=${badAuthorize.searchParams.get("state")}&code=bad`);
    expect(failed.headers.get("location")).toContain("__orbit_error=oauth_callback_error");
  });

  it("signs up through an OAuth strategy and asks for the remaining required fields", async () => {
    const { app, ctx } = await setup();
    await enableGoogle(ctx);
    registerOAuthProvider("google", fakeGoogle({ provider: "google", providerUserId: "g-signup", email: "signup-oauth@example.com", emailVerified: true }));
    const client = testClient(app);
    const created = await client.json<{ response: { id: string; verifications: { external_account: { external_verification_redirect_url: string } } } }>("/v1/client/sign_ups", {
      body: { strategy: "oauth_google", redirect_url: "http://localhost:3000/done" },
    });
    const authorize = new URL(created.response.verifications.external_account.external_verification_redirect_url);
    const callback = await client.request(`/v1/oauth_callback/google?state=${authorize.searchParams.get("state")}&code=good-code`);
    expect(callback.headers.get("location")).toContain("__orbit_status=missing_requirements");

    const state = await getClient(client);
    expect(state.response.sign_up?.status).toBe("missing_requirements");
    const signUp = await client.json<{ response: { id: string; email_address: string; missing_fields: string[] } }>(`/v1/client/sign_ups/${created.response.id}`);
    expect(signUp.response.email_address).toBe("signup-oauth@example.com");
    expect(signUp.response.missing_fields).toEqual(["password"]);

    const completed = await client.json<{ response: { status: string; created_session_id: string } }>(`/v1/client/sign_ups/${created.response.id}`, {
      method: "PATCH",
      body: { password: "Sup3rSecret!" },
    });
    expect(completed.response.status).toBe("complete");
    expect(completed.response.created_session_id).toMatch(/^sess_/);
  });

  it("rejects unconfigured providers", async () => {
    const { app } = await setup();
    const client = testClient(app);
    const res = await client.json("/v1/client/sign_ins", { body: { strategy: "oauth_github" } });
    expect(errorsOf(res)[0]?.code).toBe("oauth_provider_not_enabled");
  });
});

describe("redirect_url validation", () => {
  it("allows relative/configured origins and rejects untrusted ones", async () => {
    const { app, ctx } = await setup();
    const user = await signUpUser(app);
    const client = testClient(app);

    const evil = await client.json("/v1/client/sign_ins", { body: { identifier: user.email, redirect_url: "https://evil.example/steal" } });
    expect(errorsOf(evil)[0]?.code).toBe("form_param_format_invalid");

    const protocolRelative = await client.json("/v1/client/sign_ins", { body: { identifier: user.email, redirect_url: "//evil.example/steal" } });
    expect(errorsOf(protocolRelative)[0]?.code).toBe("form_param_format_invalid");

    const relative = await client.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, redirect_url: "/dashboard" },
    });
    expect(relative.response.status).toBe("needs_first_factor");

    await ctx.settings.update({ application: { allowedRedirectOrigins: ["https://trusted.example"] } });
    const trusted = await client.json<{ response: { status: string } }>("/v1/client/sign_ins", {
      body: { identifier: user.email, redirect_url: "https://trusted.example/welcome" },
    });
    expect(trusted.response.status).toBe("needs_first_factor");
  });
});
