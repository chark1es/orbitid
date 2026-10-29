// A custom OIDC provider (`custom_<key>`) pointed at a second, real OrbitID instance.
//
// Both servers run as real HTTP servers on loopback ports with their own in-memory database. Instance A is
// the identity provider (a genuine OIDC OP); instance B is the relying party. Every step is a real request:
// B's sign-in -> A's authorize -> A's consent -> B's callback -> A's token endpoint -> A's JWKS.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { sha256 } from "../../src/lib/crypto";
import { first } from "../../src/lib/db";
import {
  authorizeAtIdp, authorizeParams, backend, Browser, clientToken, createOAuthApplication, createUser, resetFederationCaches,
  signIn, startFedServer, type FedServer, type OAuthApplication,
} from "./helpers";

const REDIRECT = "http://localhost:3000/done";

let idp: FedServer;   // instance A: the identity provider
let rp: FedServer;    // instance B: the relying party under test
let app: OAuthApplication;
let idpUser: { id: string; email: string; password: string };
let idpBrowser: Browser;

/** A signed-in browser at the IdP, plus the client cookie name the OP expects. */
async function idpSession(): Promise<Browser> {
  const browser = new Browser();
  await signIn(browser, idp, idpUser.email, idpUser.password);
  return browser;
}

async function configureProvider(server: FedServer, opts: { discoveryUrl?: string } = {}) {
  const res = await backend(server, "PATCH", "/v1/instance", {
    social: {
      custom_acme: {
        enabled: true,
        clientId: app.client_id,
        clientSecret: app.client_secret,
        discoveryUrl: opts.discoveryUrl ?? `${idp.url}/.well-known/openid-configuration`,
        scopes: ["openid", "profile", "email"],
        name: "Acme ID",
        authenticatableAtSignIn: true,
      },
    },
  });
  expect(res.status).toBe(200);
}

/** Starts the social sign-in on the relying party and returns the provider's authorize URL. */
async function startSocial(browser: Browser) {
  const res = await browser.request(`${rp.url}/v1/client/sign_ins`, {
    json: { strategy: "oauth_custom_acme", redirect_url: REDIRECT },
  });
  expect(res.status).toBe(200);
  const body = res.json<{ response: { id: string; status: string; first_factor_verification: { external_verification_redirect_url: string | null } } }>();
  expect(body.response.status).toBe("needs_first_factor");
  const url = body.response.first_factor_verification.external_verification_redirect_url;
  expect(url).toBeTruthy();
  return { signInId: body.response.id, authorizeUrl: new URL(url!) };
}

const callbackUrl = (back: URL) => `${rp.url}/v1/oauth_callback/custom_acme${back.search}`;

beforeEach(async () => {
  resetFederationCaches();
  idp = await startFedServer({ secretKey: "sk_test_federation_idp" });
  rp = await startFedServer({ secretKey: "sk_test_federation_rp" });
  idpUser = await createUser(idp, { email: "ada@acme.test", password: "Sup3rSecret!", firstName: "Ada", lastName: "Lovelace" });
  app = await createOAuthApplication(idp, `${rp.url}/v1/oauth_callback/custom_acme`, { name: "Acme RP" });
  await configureProvider(rp);
  idpBrowser = await idpSession();
});

afterEach(async () => {
  await rp.close();
  await idp.close();
  resetFederationCaches();
});

describe("custom OIDC provider against a real OrbitID identity provider", () => {
  it("sends PKCE and a nonce, and completes the authorization-code flow through the real IdP", async () => {
    const browser = new Browser();
    const start = await startSocial(browser);
    expect(start.authorizeUrl.origin).toBe(idp.url);
    expect(start.authorizeUrl.pathname).toBe("/oauth/authorize");
    expect(start.authorizeUrl.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(start.authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(start.authorizeUrl.searchParams.get("nonce")).toBeTruthy();
    expect(start.authorizeUrl.searchParams.get("redirect_uri")).toBe(`${rp.url}/v1/oauth_callback/custom_acme`);

    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(start.authorizeUrl));
    expect(back.origin + back.pathname).toBe(`${rp.url}/v1/oauth_callback/custom_acme`);
    expect(back.searchParams.get("code")).toMatch(/^oac_/);
    expect(back.searchParams.get("state")).toBe(start.authorizeUrl.searchParams.get("state"));

    // The IdP recorded a single-use code bound to the S256 challenge and the nonce.
    const code = first(await idp.ctx.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.tokenHash, sha256(back.searchParams.get("code")!))))!;
    expect(code.kind).toBe("code");
    expect(code.codeChallengeMethod).toBe("S256");
    expect(code.codeChallenge).toBe(start.authorizeUrl.searchParams.get("code_challenge"));
    expect(code.nonce).toBe(start.authorizeUrl.searchParams.get("nonce"));

    const callback = await browser.get(callbackUrl(back));
    expect(callback.status).toBe(302);
    const target = callback.location!;
    expect(target.origin + target.pathname).toBe(REDIRECT);
    expect(target.searchParams.get("__orbit_status")).toBe("transferable");

    // The exchange consumed the code at the IdP.
    const consumed = first(await idp.ctx.db.select().from(s.oauthGrants).where(eq(s.oauthGrants.id, code.id)))!;
    expect(consumed.revoked).toBe(true);
    // An access token was minted for the relying party and stored encrypted at rest on B.
    const rpClient = first(await rp.ctx.db.select().from(s.clients).where(eq(s.clients.tokenHash, sha256(clientToken(browser)))))!;
    expect(rpClient).toBeTruthy();
  });

  it("maps the ID token claims, then links the account on a second login without duplicating the user", async () => {
    const browser = new Browser();
    const start = await startSocial(browser);
    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(start.authorizeUrl));
    await browser.get(callbackUrl(back));

    // No account yet: the flow is transferable to a sign-up carrying the IdP's identity.
    const client = await browser.get(`${rp.url}/v1/client`).then((res) => res.json<{ response: { sign_in: { first_factor_verification: { status: string } } | null } }>());
    expect(client.response.sign_in?.first_factor_verification.status).toBe("transferable");

    const transfer = await browser.request(`${rp.url}/v1/client/sign_ups`, { json: { transfer: true } });
    const signUp = transfer.json<{ response: { id: string; email_address: string; first_name: string; last_name: string; missing_fields: string[]; verifications: { external_account: { strategy: string; status: string } } } }>();
    expect(signUp.response.email_address).toBe("ada@acme.test");
    expect(signUp.response.first_name).toBe("Ada");
    expect(signUp.response.last_name).toBe("Lovelace");
    expect(signUp.response.missing_fields).toEqual(["password"]);
    expect(signUp.response.verifications.external_account).toMatchObject({ strategy: "from_oauth_custom_acme", status: "verified" });

    const completed = await browser.request(`${rp.url}/v1/client/sign_ups/${signUp.response.id}`, {
      method: "PATCH",
      json: { password: "Sup3rSecret!" },
    });
    const done = completed.json<{ response: { status: string; created_user_id: string; created_session_id: string } }>();
    expect(done.response.status).toBe("complete");

    const user = first(await rp.ctx.db.select().from(s.users).where(eq(s.users.id, done.response.created_user_id)))!;
    const external = first(await rp.ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.userId, user.id)))!;
    expect(external.provider).toBe("custom_acme");
    expect(external.providerUserId).toBe(idpUser.id);
    expect(external.emailAddress).toBe("ada@acme.test");
    // The IdP's access token is stored encrypted, never in the clear.
    expect(external.accessTokenEnc).toMatch(/^v1\./);

    // Second login, new browser: the linked account signs straight in.
    const again = new Browser();
    const second = await startSocial(again);
    const backAgain = await authorizeAtIdp(idp, idpBrowser, authorizeParams(second.authorizeUrl));
    const secondCallback = await again.get(callbackUrl(backAgain));
    expect(secondCallback.location!.searchParams.get("__orbit_status")).toBe("complete");

    const state = await again.get(`${rp.url}/v1/client`).then((res) => res.json<{ response: { sessions: { status: string; user: { id: string } }[] } }>());
    expect(state.response.sessions).toHaveLength(1);
    expect(state.response.sessions[0]!.status).toBe("active");
    expect(state.response.sessions[0]!.user.id).toBe(user.id);

    expect((await rp.ctx.db.select().from(s.users)).filter((row) => row.id === user.id)).toHaveLength(1);
    expect(await rp.ctx.db.select().from(s.users)).toHaveLength(1);
    expect((await rp.ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.provider, "custom_acme")))).toHaveLength(1);
  });

  it("refuses to create an account when sign-ups are restricted, and still signs in the linked user", async () => {
    const restricted = await backend(rp, "PATCH", "/v1/instance", { signUp: { mode: "restricted" } });
    expect(restricted.status).toBe(200);

    const browser = new Browser();
    const start = await startSocial(browser);
    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(start.authorizeUrl));
    const landed = await browser.get(callbackUrl(back));
    expect(landed.status).toBe(302);
    // The identity is authenticated but has no account here: the sign-in is transferable, nothing is created yet.
    expect(landed.location!.searchParams.get("__orbit_status")).toBe("transferable");
    expect(await rp.ctx.db.select().from(s.users)).toHaveLength(0);

    // Turning it into a sign-up is what the restriction refuses.
    const transfer = await browser.request(`${rp.url}/v1/client/sign_ups`, { json: { transfer: true } });
    expect(transfer.status).toBe(422);
    expect(transfer.json<{ errors: { code: string }[] }>().errors[0]!.code).toBe("sign_up_restricted");
    expect(await rp.ctx.db.select().from(s.users)).toHaveLength(0);
    expect(await rp.ctx.db.select().from(s.externalAccounts)).toHaveLength(0);

    // An existing, linked account is unaffected by the sign-up mode.
    const allowed = await backend(rp, "PATCH", "/v1/instance", {
      signUp: { mode: "public" },
      restrictions: { allowlistEnabled: true },
    });
    expect(allowed.status).toBe(200);
    await backend(rp, "POST", "/v1/allowlist_identifiers", { identifier: "ada@acme.test" });
    const owner = new Browser();
    const ownerStart = await startSocial(owner);
    const ownerBack = await authorizeAtIdp(idp, idpBrowser, authorizeParams(ownerStart.authorizeUrl));
    await owner.get(callbackUrl(ownerBack));
    const ownerTransfer = await owner.request(`${rp.url}/v1/client/sign_ups`, { json: { transfer: true } });
    const signUpId = ownerTransfer.json<{ response: { id: string } }>().response.id;
    await owner.request(`${rp.url}/v1/client/sign_ups/${signUpId}`, { method: "PATCH", json: { password: "Sup3rSecret!" } });
    const userId = first(await rp.ctx.db.select().from(s.users))!.id;

    await backend(rp, "PATCH", "/v1/instance", { signUp: { mode: "restricted" }, restrictions: { allowlistEnabled: false } });
    const repeat = new Browser();
    const repeatStart = await startSocial(repeat);
    const repeatBack = await authorizeAtIdp(idp, idpBrowser, authorizeParams(repeatStart.authorizeUrl));
    const repeatLanded = await repeat.get(callbackUrl(repeatBack));
    expect(repeatLanded.location!.searchParams.get("__orbit_status")).toBe("complete");
    const sessions = await repeat.get(`${rp.url}/v1/client`).then((res) => res.json<{ response: { sessions: { user: { id: string } }[] } }>());
    expect(sessions.response.sessions[0]!.user.id).toBe(userId);
  });

  it("does not link an unverified email to an existing account", async () => {
    // The IdP's user has a verified address; remove the verification on A and log in again.
    await idp.ctx.db.update(s.emailAddresses).set({ verified: false, verifiedAt: null }).where(eq(s.emailAddresses.userId, idpUser.id));

    // Seed a local account with the same address on the relying party.
    const seeded = await createUser(rp, { email: "ada@acme.test" });
    await rp.ctx.db.update(s.users).set({ passwordHash: null }).where(eq(s.users.id, seeded.id));
    const before = await rp.ctx.db.select().from(s.users);

    const browser = new Browser();
    const start = await startSocial(browser);
    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(start.authorizeUrl));
    const landed = await browser.get(callbackUrl(back));

    // The claim says unverified, so the existing account with that address is not signed in.
    expect(landed.location!.searchParams.get("__orbit_status")).toBe("transferable");
    const after = await rp.ctx.db.select().from(s.users);
    expect(after).toHaveLength(before.length);
    expect(await rp.ctx.db.select().from(s.externalAccounts)).toHaveLength(0);

    // Nor can the unverified identity take over the address by transferring into a sign-up.
    const transfer = await browser.request(`${rp.url}/v1/client/sign_ups`, { json: { transfer: true } });
    expect(transfer.status).toBe(422);
    expect(transfer.json<{ errors: { code: string }[] }>().errors[0]!.code).toBe("form_identifier_exists");
    expect(await rp.ctx.db.select().from(s.externalAccounts)).toHaveLength(0);
    const email = first(await rp.ctx.db.select().from(s.emailAddresses).where(and(eq(s.emailAddresses.userId, seeded.id), eq(s.emailAddresses.email, "ada@acme.test"))))!;
    expect(email.userId).toBe(seeded.id);
  });

  it("keeps the email unverified on sign-up when the IdP says email_verified=false", async () => {
    // The IdP's user exists but the address is not verified there (e.g. a pending invitation).
    await idp.ctx.db.update(s.emailAddresses).set({ verified: false, verifiedAt: null }).where(eq(s.emailAddresses.userId, idpUser.id));

    const browser = new Browser();
    const start = await startSocial(browser);
    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(start.authorizeUrl));
    await browser.get(callbackUrl(back));

    const transfer = await browser.request(`${rp.url}/v1/client/sign_ups`, { json: { transfer: true } });
    const signUp = transfer.json<{ response: { id: string; email_address: string; unverified_fields: string[]; verifications: { email_address: { status: string } } } }>();
    expect(signUp.response.email_address).toBe("ada@acme.test");
    // The claimed address is carried over but must still be proven by the user.
    expect(signUp.response.unverified_fields).toContain("email_address");
    expect(signUp.response.verifications.email_address.status).toBe("unverified");

    const done = await browser.request(`${rp.url}/v1/client/sign_ups/${signUp.response.id}`, {
      method: "PATCH",
      json: { password: "Sup3rSecret!" },
    });
    const body = done.json<{ response: { status: string; unverified_fields: string[] } }>();
    expect(body.response.status).not.toBe("complete");
    expect(body.response.unverified_fields).toContain("email_address");
    const email = first(await rp.ctx.db.select().from(s.emailAddresses).where(eq(s.emailAddresses.email, "ada@acme.test")));
    expect(email).toBeUndefined();
  });

  it("keeps two custom providers' accounts apart", async () => {
    // Regression: every `custom_*` provider used to normalize to the literal provider "custom", so an
    // account linked through one provider matched a second provider's flow for the same subject id.
    const second = await createOAuthApplication(idp, `${rp.url}/v1/oauth_callback/custom_other`, { name: "Other RP" });
    const patched = await backend(rp, "PATCH", "/v1/instance", {
      social: {
        custom_other: {
          enabled: true,
          clientId: second.client_id,
          clientSecret: second.client_secret,
          discoveryUrl: `${idp.url}/.well-known/openid-configuration`,
          scopes: ["openid", "profile", "email"],
        },
      },
    });
    expect(patched.status).toBe(200);

    /** Signs up through `provider` in a fresh browser, with the address already verified at the IdP. */
    const signUpThrough = async (provider: string, email: string) => {
      const browser = new Browser();
      const res = await browser.request(`${rp.url}/v1/client/sign_ins`, {
        json: { strategy: `oauth_${provider}`, redirect_url: REDIRECT },
      });
      const authorizeUrl = new URL(
        res.json<{ response: { first_factor_verification: { external_verification_redirect_url: string } } }>()
          .response.first_factor_verification.external_verification_redirect_url,
      );
      const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(authorizeUrl));
      await browser.get(`${rp.url}/v1/oauth_callback/${provider}${back.search}`);
      const transfer = await browser.request(`${rp.url}/v1/client/sign_ups`, { json: { transfer: true } });
      const signUpId = transfer.json<{ response: { id: string } }>().response.id;
      await browser.request(`${rp.url}/v1/client/sign_ups/${signUpId}`, { method: "PATCH", json: { password: "Sup3rSecret!" } });
      return browser;
    };

    await signUpThrough("custom_acme", "ada@acme.test");
    expect((await rp.ctx.db.select().from(s.externalAccounts)).map((row) => row.provider)).toEqual(["custom_acme"]);

    // A different IdP user through the other provider gets its own account (different subject)...
    const otherUser = await createUser(idp, { email: "grace@other.test", password: "Sup3rSecret!", firstName: "Grace" });
    const otherIdpBrowser = new Browser();
    await signIn(otherIdpBrowser, idp, otherUser.email, otherUser.password);
    const previous = idpBrowser;
    idpBrowser = otherIdpBrowser;
    try {
      await signUpThrough("custom_other", otherUser.email);
    } finally {
      idpBrowser = previous;
    }
    const providers = (await rp.ctx.db.select().from(s.externalAccounts)).map((row) => row.provider).sort();
    expect(providers).toEqual(["custom_acme", "custom_other"]);
    expect(await rp.ctx.db.select().from(s.users)).toHaveLength(2);

    // ...and the first provider's linked account is not reachable through the second one.
    const linked = first(await rp.ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.provider, "custom_acme")))!;
    expect(linked.providerUserId).toBe(idpUser.id);
    const otherLinked = first(await rp.ctx.db.select().from(s.externalAccounts).where(eq(s.externalAccounts.provider, "custom_other")))!;
    expect(otherLinked.providerUserId).toBe(otherUser.id);
  });

  it("signs in an existing local account only when the IdP verifies the email", async () => {
    const seeded = await createUser(rp, { email: "ada@acme.test" });

    const browser = new Browser();
    const start = await startSocial(browser);
    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(start.authorizeUrl));
    const landed = await browser.get(callbackUrl(back));
    expect(landed.location!.searchParams.get("__orbit_status")).toBe("complete");

    const sessions = await browser.get(`${rp.url}/v1/client`).then((res) => res.json<{ response: { sessions: { user: { id: string } }[] } }>());
    expect(sessions.response.sessions[0]!.user.id).toBe(seeded.id);
    const external = first(await rp.ctx.db.select().from(s.externalAccounts))!;
    expect(external.userId).toBe(seeded.id);
    expect(external.provider).toBe("custom_acme");
  });
});
