// Enterprise OIDC connections pointed at a second, real OrbitID instance.
//
// The interesting part is routing: an identifier whose domain belongs to an active connection is sent to
// the IdP by the *sign-in* endpoint itself (`enterprise_sso` first factor), with no hint from the client.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import * as s from "../../src/db/schema";
import { first } from "../../src/lib/db";
import {
  authorizeAtIdp, authorizeParams, backend, Browser, createOAuthApplication, createUser, resetFederationCaches, signIn,
  startFedServer, type FedServer, type OAuthApplication,
} from "./helpers";

const REDIRECT = "http://localhost:3000/done";
const DOMAIN = "acme.test";

let idp: FedServer;
let rp: FedServer;
let app: OAuthApplication;
let idpUser: { id: string; email: string; password: string };
let idpBrowser: Browser;
let connectionId: string;

const callbackUrl = (connection: string, back: URL) => `${rp.url}/v1/client/enterprise/oidc_callback/${connection}${back.search}`;

async function createConnection(overrides: Record<string, unknown> = {}) {
  // The redirect URI must be registered on the IdP before the connection can be used.
  const res = await backend(rp, "POST", "/v1/enterprise_connections", {
    name: "Acme OIDC",
    protocol: "oidc",
    provider: "custom",
    domains: [DOMAIN],
    active: true,
    client_id: app.client_id,
    client_secret: app.client_secret,
    discovery_url: `${idp.url}/.well-known/openid-configuration`,
    ...overrides,
  });
  expect(res.status).toBe(201);
  return res.json<{ id: string }>().id;
}

beforeEach(async () => {
  resetFederationCaches();
  idp = await startFedServer({ secretKey: "sk_test_federation_idp" });
  rp = await startFedServer({ secretKey: "sk_test_federation_rp" });
  idpUser = await createUser(idp, { email: `ada@${DOMAIN}`, password: "Sup3rSecret!", firstName: "Ada", lastName: "Lovelace" });
  // An enterprise connection uses its own client; the redirect URI depends on the connection id, so it is
  // created first with a placeholder and patched once the id is known.
  app = await createOAuthApplication(idp, `${rp.url}/v1/client/enterprise/oidc_callback/placeholder`, { name: "Acme Enterprise" });
  connectionId = await createConnection();
  const patched = await backend(idp, "PATCH", `/v1/oauth_applications/${app.id}`, {
    redirect_uris: [`${rp.url}/v1/client/enterprise/oidc_callback/${connectionId}`],
  });
  expect(patched.status).toBe(200);
  idpBrowser = new Browser();
  await signIn(idpBrowser, idp, idpUser.email, idpUser.password);
});

afterEach(async () => {
  await rp.close();
  await idp.close();
  resetFederationCaches();
});

describe("enterprise OIDC connection against a real identity provider", () => {
  it("routes a matching email domain to the IdP without the client naming a connection", async () => {
    const browser = new Browser();
    const created = await browser.request(`${rp.url}/v1/client/sign_ins`, {
      json: { identifier: `ada@${DOMAIN}`, redirect_url: REDIRECT },
    });
    expect(created.status).toBe(200);
    const body = created.json<{ response: { status: string; supported_first_factors: { strategy: string }[]; first_factor_verification: { external_verification_redirect_url: string | null } } }>();
    expect(body.response.status).toBe("needs_first_factor");
    // No such account exists here yet, so there is no factor list — the domain alone picked the connection.
    expect(body.response.first_factor_verification.external_verification_redirect_url).toContain("/v1/client/enterprise/start");

    // Follow the start link the way the browser does.
    const start = await browser.request(body.response.first_factor_verification.external_verification_redirect_url!, { method: "GET" });
    expect(start.status).toBe(302);
    const authorizeUrl = start.location!;
    expect(authorizeUrl.origin).toBe(idp.url);
    expect(authorizeUrl.searchParams.get("client_id")).toBe(app.client_id);
    expect(authorizeUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizeUrl.searchParams.get("nonce")).toBeTruthy();
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(`${rp.url}/v1/client/enterprise/oidc_callback/${connectionId}`);
  });

  it("completes the redirect flow and creates the user, external account and session", async () => {
    const browser = new Browser();
    const created = await browser.request(`${rp.url}/v1/client/sign_ins`, {
      json: { identifier: `ada@${DOMAIN}`, redirect_url: REDIRECT },
    });
    const start = await browser.request(
      created.json<{ response: { first_factor_verification: { external_verification_redirect_url: string } } }>().response.first_factor_verification.external_verification_redirect_url,
    );
    expect(start.status).toBe(302);
    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(start.location!));
    const landing = await browser.get(callbackUrl(connectionId, back));

    expect(landing.status).toBe(302);
    expect(landing.location!.searchParams.get("__orbit_status")).toBe("transferable");

    const transfer = await browser.request(`${rp.url}/v1/client/sign_ups`, { json: { transfer: true } });
    const signUp = transfer.json<{ response: { id: string; email_address: string; first_name: string; missing_fields: string[] } }>();
    expect(signUp.response.email_address).toBe(`ada@${DOMAIN}`);
    expect(signUp.response.first_name).toBe("Ada");
    const done = await browser.request(`${rp.url}/v1/client/sign_ups/${signUp.response.id}`, {
      method: "PATCH",
      json: { password: "Sup3rSecret!" },
    });
    const completed = done.json<{ response: { status: string; created_user_id: string } }>();
    expect(completed.response.status).toBe("complete");

    const external = first(await rp.ctx.db.select().from(s.externalAccounts))!;
    expect(external.provider).toBe(`oidc_${connectionId}`);
    expect(external.providerUserId).toBe(idpUser.id);
    expect(external.userId).toBe(completed.response.created_user_id);
    const sessions = await browser.get(`${rp.url}/v1/client`).then((res) => res.json<{ response: { sessions: { status: string }[] } }>());
    expect(sessions.response.sessions).toHaveLength(1);
    expect(sessions.response.sessions[0]!.status).toBe("active");
  });

  it("signs the same user in on a second visit without creating a duplicate", async () => {
    const connect = async () => {
      const browser = new Browser();
      const created = await browser.request(`${rp.url}/v1/client/sign_ins`, {
        json: { identifier: `ada@${DOMAIN}`, redirect_url: REDIRECT },
      });
      const start = await browser.request(
        created.json<{ response: { first_factor_verification: { external_verification_redirect_url: string } } }>().response.first_factor_verification.external_verification_redirect_url,
      );
      const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(start.location!));
      return { browser, landing: await browser.get(callbackUrl(connectionId, back)) };
    };

    const firstVisit = await connect();
    const transfer = await firstVisit.browser.request(`${rp.url}/v1/client/sign_ups`, { json: { transfer: true } });
    const signUpId = transfer.json<{ response: { id: string } }>().response.id;
    await firstVisit.browser.request(`${rp.url}/v1/client/sign_ups/${signUpId}`, { method: "PATCH", json: { password: "Sup3rSecret!" } });
    const userId = first(await rp.ctx.db.select().from(s.users))!.id;

    const second = await connect();
    expect(second.landing.location!.searchParams.get("__orbit_status")).toBe("complete");
    const sessions = await second.browser.get(`${rp.url}/v1/client`).then((res) => res.json<{ response: { sessions: { user: { id: string } }[] } }>());
    expect(sessions.response.sessions[0]!.user.id).toBe(userId);
    expect(await rp.ctx.db.select().from(s.users)).toHaveLength(1);
    expect(await rp.ctx.db.select().from(s.externalAccounts)).toHaveLength(1);
  });

  it("refuses a callback in another browser and a replayed state", async () => {
    const browser = new Browser();
    const created = await browser.request(`${rp.url}/v1/client/sign_ins`, {
      json: { identifier: `ada@${DOMAIN}`, redirect_url: REDIRECT },
    });
    const start = await browser.request(
      created.json<{ response: { first_factor_verification: { external_verification_redirect_url: string } } }>().response.first_factor_verification.external_verification_redirect_url,
    );
    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(start.location!));

    const victim = new Browser();
    const foreign = await victim.get(callbackUrl(connectionId, back));
    expect(foreign.status).toBe(400);
    expect(await rp.ctx.db.select().from(s.users)).toHaveLength(0);

    // The failed attempt consumed the state, so even the right browser cannot reuse it.
    const replay = await browser.get(callbackUrl(connectionId, back));
    expect(replay.status).toBe(400);
    expect(await rp.ctx.db.select().from(s.users)).toHaveLength(0);
  });

  it("does not route a domain that no active connection claims", async () => {
    const browser = new Browser();
    const res = await browser.request(`${rp.url}/v1/client/sign_ins`, {
      json: { identifier: "someone@other.test", redirect_url: REDIRECT },
    });
    // No connection, no account: the ordinary enumeration-protected "not found" answer.
    expect(res.status).toBe(422);
    expect(res.json<{ errors: { code: string }[] }>().errors[0]!.code).toBe("form_identifier_not_found");
  });

  it("stops routing once the connection is deactivated", async () => {
    await backend(rp, "PATCH", `/v1/enterprise_connections/${connectionId}`, { active: false });
    const browser = new Browser();
    const res = await browser.request(`${rp.url}/v1/client/sign_ins`, {
      json: { identifier: `ada@${DOMAIN}`, redirect_url: REDIRECT },
    });
    expect(res.status).toBe(422);
    expect(await rp.ctx.db.select().from(s.externalAccounts)).toHaveLength(0);
  });

  it("refuses additional identifications for a user linked to a restricted connection", async () => {
    await backend(rp, "PATCH", `/v1/enterprise_connections/${connectionId}`, { disable_additional_identifications: true });
    const local = await createUser(rp, { email: "linked@other.test" });
    const now = Date.now();
    await rp.ctx.db.insert(s.externalAccounts).values({
      id: "eac_linked", userId: local.id, provider: `oidc_${connectionId}`, providerUserId: "linked-subject",
      emailAddress: local.email, firstName: "Linked", lastName: "User", approvedScopes: "", createdAt: now, updatedAt: now,
    });
    const browser = new Browser();
    await signIn(browser, rp, local.email, local.password);

    const refused = async (path: string, body: unknown) => {
      const res = await browser.request(`${rp.url}${path}`, { json: body });
      expect(res.status, path).toBe(403);
      expect(res.json<{ errors: { code: string }[] }>().errors[0]!.code, path).toBe("not_allowed_access");
    };
    await refused("/v1/client/me/email_addresses", { email_address: "extra@other.test" });
    await refused("/v1/client/me/phone_numbers", { phone_number: "+15550004444" });
    await refused("/v1/client/me/change_password", { new_password: "N3wSup3rSecret!" });
    await refused("/v1/client/me/external_accounts", { strategy: "oauth_google" });

    // A pending address cannot be verified either.
    await rp.ctx.db.insert(s.emailAddresses).values({
      id: "idn_e_pending", userId: local.id, email: "pending@other.test", verified: false, createdAt: now, updatedAt: now,
    });
    await refused("/v1/client/me/email_addresses/idn_e_pending/prepare_verification", {});
    await refused("/v1/client/me/email_addresses/idn_e_pending/attempt_verification", { code: "123456" });
  });

  it("syncs first/last name and avatar from the IdP on each SSO sign-in", async () => {
    const local = await createUser(rp, {
      email: `ada@${DOMAIN}`, password: "Sup3rSecret!", firstName: "Old", lastName: "Name",
    });
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
    const dataUrl = `data:image/png;base64,${png}`;
    const uploaded = await backend(idp, "POST", `/v1/users/${idpUser.id}/profile_image`, { file: dataUrl });
    expect(uploaded.status).toBe(200);

    const browser = new Browser();
    const created = await browser.request(`${rp.url}/v1/client/sign_ins`, {
      json: { identifier: `ada@${DOMAIN}`, redirect_url: REDIRECT },
    });
    const start = await browser.request(
      created.json<{ response: { first_factor_verification: { external_verification_redirect_url: string } } }>().response.first_factor_verification.external_verification_redirect_url,
    );
    const back = await authorizeAtIdp(idp, idpBrowser, authorizeParams(start.location!));
    const landing = await browser.get(callbackUrl(connectionId, back));
    expect(landing.status).toBe(302);
    expect(landing.location!.searchParams.get("__orbit_status")).toBe("complete");

    const updated = first(await rp.ctx.db.select().from(s.users).where(eq(s.users.id, local.id)))!;
    expect(updated.firstName).toBe("Ada");
    expect(updated.lastName).toBe("Lovelace");
    expect(updated.imageUrl).toBe(dataUrl);
  });

  it("serves the connection over the Backend API without leaking the client secret", async () => {
    const listed = await backend(rp, "GET", "/v1/enterprise_connections");
    expect(listed.text).not.toContain(app.client_secret);
    const row = listed.json<{ data: { id: string; protocol: string; oidc: { client_id: string; discovery_url: string } }[] }>().data[0]!;
    expect(row.id).toBe(connectionId);
    expect(row.protocol).toBe("oidc");
    expect(row.oidc.client_id).toBe(app.client_id);
    expect(row.oidc.discovery_url).toBe(`${idp.url}/.well-known/openid-configuration`);
    const stored = first(await rp.ctx.db.select().from(s.enterpriseConnections).where(eq(s.enterpriseConnections.id, connectionId)))!;
    expect((stored.config as Record<string, unknown>).clientSecretEnc).toMatch(/^v1\./);
  });
});
