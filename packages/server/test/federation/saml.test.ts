// A real SP-initiated SAML flow: instance B is the service provider and the IdP is a separate HTTP server
// (`saml-idp.ts`) that signs with the same library the server validates with.
//
// Each test drives the browser exactly as a person would: sign-in -> the SP's `enterprise/start` -> the IdP
// -> the IdP's auto-submitting form -> the SP's ACS. The IdP builds its response from the AuthnRequest it
// actually received, so request/response correlation is exercised for real rather than simulated.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as s from "../../src/db/schema";
import { first } from "../../src/lib/db";
import { backend, Browser, createUser, resetFederationCaches, startFedServer, type FedServer } from "./helpers";
import { makeKeyPair, samlResponse, startSamlIdp, type AssertionOptions, type IdpKeyPair, type SamlIdp } from "./saml-idp";

const REDIRECT = "http://localhost:3000/done";
const DOMAIN = "acme.test";

let sp: FedServer;
let idp: SamlIdp;
let idpKeys: IdpKeyPair;
let attackerKeys: IdpKeyPair;
let connectionId: string;
let conn: { id: string; saml: { acs_url: string; sp_entity_id: string; sp_metadata_url: string } };

async function createConnection(overrides: Record<string, unknown> = {}, keys: IdpKeyPair = idpKeys) {
  const res = await backend(sp, "POST", "/v1/enterprise_connections", {
    name: "Acme SAML",
    protocol: "saml",
    domains: [DOMAIN],
    active: true,
    idp_entity_id: idp.entityId,
    idp_sso_url: idp.ssoUrl,
    idp_certificate: keys.cert,
    ...overrides,
  });
  expect(res.status).toBe(201);
  const created = res.json<typeof conn>();
  conn = created;
  idp.acsUrl = created.saml.acs_url;
  return created;
}

/** Sign in with a domain-routed identifier and follow the SP's redirect to the IdP. */
async function startFlow(browser: Browser, identifier = `ada@${DOMAIN}`) {
  const created = await browser.request(`${sp.url}/v1/client/sign_ins`, {
    json: { identifier, redirect_url: REDIRECT },
  });
  expect(created.status).toBe(200);
  const body = created.json<{ response: { status: string; first_factor_verification: { external_verification_redirect_url: string } } }>();
  expect(body.response.status).toBe("needs_first_factor");
  const start = await browser.get(body.response.first_factor_verification.external_verification_redirect_url);
  expect(start.status).toBe(302);
  const idpUrl = start.location!;
  expect(idpUrl.origin + idpUrl.pathname).toBe(idp.ssoUrl);
  return idpUrl;
}

/** Reads the auto-submitting form the IdP served (the HTTP-POST binding). */
function readPostForm(html: string): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const match of html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)"\/>/g)) {
    fields[match[1]!] = match[2]!
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  }
  return fields;
}

/**
 * Runs the IdP half with the assertion built from the AuthnRequest it receives, then posts the form to the
 * ACS. `patch` can override any assertion field (or `relayState`, or `raw` to replace the whole body).
 */
async function finishFlow(
  browser: Browser,
  idpUrl: URL,
  patch: (request: { id: string; issuer: string }) => (Partial<AssertionOptions> & { relayState?: string }) = () => ({}),
) {
  let posted: Record<string, string> | null = null;
  idp.respond = (request) => {
    const extra = patch(request);
    const response = samlResponse(idp, {
      spEntityId: conn.saml.sp_entity_id,
      acsUrl: conn.saml.acs_url,
      inResponseTo: request.id,
      nameID: `ada@${DOMAIN}`,
      ...extra,
    });
    return { SAMLResponse: response, RelayState: extra.relayState ?? request.relayState };
  };
  const atIdp = await browser.get(idpUrl.toString());
  if (atIdp.status !== 200) return { atIdp, posted, acs: null };
  posted = readPostForm(atIdp.text);
  return { atIdp, posted, acs: await browser.request(conn.saml.acs_url, { form: posted }) };
}

/** The happy path: a correctly signed assertion for the routed user. */
async function login(browser: Browser, patch?: Parameters<typeof finishFlow>[2]) {
  const idpUrl = await startFlow(browser);
  return finishFlow(browser, idpUrl, patch);
}

async function exchangeForAccount(browser: Browser) {
  const transfer = await browser.request(`${sp.url}/v1/client/sign_ups`, { json: { transfer: true } });
  const signUp = transfer.json<{ response: { id: string; email_address: string; first_name: string; last_name: string } }>();
  const done = await browser.request(`${sp.url}/v1/client/sign_ups/${signUp.response.id}`, {
    method: "PATCH",
    json: { password: "Sup3rSecret!" },
  });
  expect(done.json<{ response: { status: string } }>().response.status).toBe("complete");
  return signUp.response;
}

async function expectNothingCreated() {
  expect(await sp.ctx.db.select().from(s.users)).toHaveLength(0);
  expect(await sp.ctx.db.select().from(s.externalAccounts)).toHaveLength(0);
  expect(await sp.ctx.db.select().from(s.sessions)).toHaveLength(0);
}

beforeEach(async () => {
  resetFederationCaches();
  sp = await startFedServer({ secretKey: "sk_test_federation_sp" });
  idpKeys = makeKeyPair("primary-idp");
  attackerKeys = makeKeyPair("attacker-idp");
  idp = await startSamlIdp(idpKeys);
  await createConnection();
  connectionId = conn.id;
});

afterEach(async () => {
  await idp.close();
  await sp.close();
  resetFederationCaches();
});

describe("SAML service provider — real SP-initiated flow", () => {
  it("routes by email domain, sends an AuthnRequest, and accepts a correctly signed assertion", async () => {
    const browser = new Browser();
    const { atIdp, posted, acs } = await login(browser);
    expect(atIdp.text).toContain("SAMLResponse");
    expect(posted!.SAMLResponse).toBeTruthy();
    expect(posted!.RelayState).toBeTruthy();

    expect(acs!.status).toBe(302);
    expect(acs!.location!.searchParams.get("__orbit_status")).toBe("transferable");

    // The AuthnRequest named the SP as issuer and the IdP as destination.
    const request = idp.requests.at(-1)!;
    expect(request.issuer).toBe(conn.saml.sp_entity_id);
    expect(request.destination).toBe(idp.ssoUrl);
    expect(request.relayState).toBe(posted!.RelayState);

    // The SP publishes metadata the operator hands to the IdP.
    const metadata = await browser.get(conn.saml.sp_metadata_url);
    expect(metadata.status).toBe(200);
    expect(metadata.text).toContain(conn.saml.acs_url);
    expect(metadata.text).toContain(conn.saml.sp_entity_id);

    const signUp = await exchangeForAccount(browser);
    expect(signUp.email_address).toBe(`ada@${DOMAIN}`);
    expect(signUp.first_name).toBe("Ada");
    expect(signUp.last_name).toBe("Lovelace");

    const external = first(await sp.ctx.db.select().from(s.externalAccounts))!;
    expect(external.provider).toBe(`saml_${connectionId}`);
    expect(external.providerUserId).toBe(`ada@${DOMAIN}`);
    expect(external.emailAddress).toBe(`ada@${DOMAIN}`);
  });

  it("honours a custom attribute mapping", async () => {
    // Only one connection may claim the domain, or routing and the assertion land on different ones.
    await backend(sp, "PATCH", `/v1/enterprise_connections/${connectionId}`, { active: false });
    const mapped = await createConnection({
      attribute_mapping: { email: "mail", first_name: "givenName", last_name: "sn", user_id: "uid" },
    });
    connectionId = mapped.id;
    const browser = new Browser();
    const { acs } = await login(browser, () => ({
      nameID: "ada-army-id",
      attributes: { mail: `ada@${DOMAIN}`, givenName: "Ada", sn: "Byron", uid: "army-1" },
    }));
    expect(acs!.location!.searchParams.get("__orbit_status")).toBe("transferable");
    const signUp = await exchangeForAccount(browser);
    expect(signUp).toMatchObject({ email_address: `ada@${DOMAIN}`, first_name: "Ada", last_name: "Byron" });
    expect(first(await sp.ctx.db.select().from(s.externalAccounts))!.providerUserId).toBe("army-1");
  });

  it("refuses an unsigned response", async () => {
    const browser = new Browser();
    const { acs } = await login(browser, () => ({ sign: "none" }));
    expect(acs!.status).toBe(400);
    expect(acs!.json<{ errors: { code: string }[] }>().errors[0]!.code).toBe("verification_failed");
    await expectNothingCreated();
  });

  it("refuses a response whose Response element is signed but whose assertion is not", async () => {
    const browser = new Browser();
    const { acs } = await login(browser, () => ({ sign: "response" }));
    // `wantAssertionsSigned: true`: signing the envelope around an unsigned assertion is not enough.
    expect(acs!.status).toBe(400);
    await expectNothingCreated();
  });

  it("refuses an assertion signed by a key the connection does not trust", async () => {
    const browser = new Browser();
    const { acs } = await login(browser, () => ({ keyPair: attackerKeys }));
    expect(acs!.status).toBe(400);
    await expectNothingCreated();
  });

  it("refuses an assertion tampered with after signing", async () => {
    const browser = new Browser();
    const { acs } = await login(browser, (request) => ({
      inResponseTo: request.id,
      injectAssertionXml: (_id, signedXml) => signedXml.replace(`>ada@${DOMAIN}<`, ">mallory@acme.test<"),
    }));
    expect(acs!.status).toBe(400);
    await expectNothingCreated();
  });

  it("refuses a signature-wrapping attempt (a forged assertion beside the genuine signature)", async () => {
    const wrapping = new Browser();
    const { acs: wrapped } = await login(wrapping, () => ({
      injectAssertionXml: (_assertionId, signedXml) => {
        const forged = `<saml:Assertion ID="_forged" Version="2.0" IssueInstant="${new Date().toISOString()}">
  <saml:Issuer>${idp.entityId}</saml:Issuer>
  <saml:Subject><saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">mallory@acme.test</saml:NameID>
    <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer"><saml:SubjectConfirmationData NotOnOrAfter="${new Date(Date.now() + 300_000).toISOString()}" Recipient="${conn.saml.acs_url}"/></saml:SubjectConfirmation>
  </saml:Subject>
  <saml:Conditions NotBefore="${new Date(Date.now() - 60_000).toISOString()}" NotOnOrAfter="${new Date(Date.now() + 300_000).toISOString()}"><saml:AudienceRestriction><saml:Audience>${conn.saml.sp_entity_id}</saml:Audience></saml:AudienceRestriction></saml:Conditions>
</saml:Assertion>`;
        // Inserted *inside* the Response before the genuine assertion, so a parser that picks the first
        // assertion would read the forged one while the signature still verifies for the real one.
        return signedXml.replace(/<saml:Assertion\b/, `${forged}<saml:Assertion`);
      },
    }));
    // Two assertions are ambiguous, so the message must be refused outright.
    expect(wrapped!.status).toBe(400);
    expect(wrapped!.json<{ errors: { code: string }[] }>().errors[0]!.code).toBe("verification_failed");
    expect(await sp.ctx.db.select().from(s.externalAccounts)).toHaveLength(0);
    expect(await sp.ctx.db.select().from(s.users)).toHaveLength(0);
  });

  it("refuses an expired assertion and one used before its NotBefore", async () => {
    const expired = new Browser();
    const expiredResult = await login(expired, () => ({
      notBefore: new Date(Date.now() - 3_600_000),
      notOnOrAfter: new Date(Date.now() - 1_800_000),
    }));
    expect(expiredResult.acs!.status).toBe(400);

    const future = new Browser();
    const futureResult = await login(future, () => ({
      notBefore: new Date(Date.now() + 3_600_000),
      notOnOrAfter: new Date(Date.now() + 7_200_000),
    }));
    expect(futureResult.acs!.status).toBe(400);
    await expectNothingCreated();
  });

  it("refuses a replayed assertion, even in a flow the attacker started", async () => {
    const browser = new Browser();
    const firstLanding = await login(browser, () => ({ assertionId: "_captured" }));
    expect(firstLanding.acs!.status).toBe(302);
    await exchangeForAccount(browser);
    expect(await sp.ctx.db.select().from(s.externalAccounts)).toHaveLength(1);

    // The attacker starts their own flow and replays the captured response (with their RelayState).
    const attacker = new Browser();
    const attackerUrl = await startFlow(attacker);
    const replay = await attacker.request(conn.saml.acs_url, {
      form: { SAMLResponse: firstLanding.posted!.SAMLResponse, RelayState: attackerUrl.searchParams.get("RelayState")! },
    });
    expect(replay.status).toBe(400);
    expect(replay.json<{ errors: { code: string }[] }>().errors[0]!.code).toBe("verification_failed");
    // No session was created for the attacker.
    const sessions = await attacker.get(`${sp.url}/v1/client`).then((res) => res.json<{ response: { sessions: unknown[] } }>());
    expect(sessions.response.sessions).toHaveLength(0);
  });

  it("refuses an assertion for another audience or another ACS destination", async () => {
    const wrongAudience = new Browser();
    const audienceResult = await login(wrongAudience, () => ({ audience: "https://other-sp.example" }));
    expect(audienceResult.acs!.status).toBe(400);

    const wrongDestination = new Browser();
    const destinationResult = await login(wrongDestination, () => ({ destination: "https://other-sp.example/acs" }));
    expect(destinationResult.acs!.status).toBe(400);
    await expectNothingCreated();
  });

  it("refuses an unsolicited response and an unknown RelayState", async () => {
    const browser = new Browser();
    const unsolicited = samlResponse(idp, {
      spEntityId: conn.saml.sp_entity_id,
      acsUrl: conn.saml.acs_url,
      inResponseTo: null,
    });
    const res = await browser.request(conn.saml.acs_url, { form: { SAMLResponse: unsolicited } });
    expect(res.status).toBe(400);

    const { acs } = await login(browser, () => ({ relayState: "forged-relay-state" }));
    expect(acs!.status).toBe(400);
    await expectNothingCreated();
  });

  it("refuses an assertion that answers a different AuthnRequest", async () => {
    const browser = new Browser();
    const { acs } = await login(browser, () => ({ inResponseTo: "_never-issued" }));
    expect(acs!.status).toBe(400);
    await expectNothingCreated();
  });

  it("refuses an assertion that arrives in a different browser", async () => {
    const initiator = new Browser();
    const idpUrl = await startFlow(initiator);
    const result = await finishFlow(initiator, idpUrl);
    expect(result.acs!.status).toBe(302);

    const victim = new Browser();
    const victimUrl = await startFlow(victim);
    const hijacked = await victim.request(conn.saml.acs_url, {
      form: { SAMLResponse: result.posted!.SAMLResponse, RelayState: victimUrl.searchParams.get("RelayState")! },
    });
    // The captured response is bound to the initiator's browser and is also now replayed.
    expect(hijacked.status).toBe(400);
  });

  it("signs the same existing account in on a second assertion without duplicating it", async () => {
    const browser = new Browser();
    const firstLanding = await login(browser);
    expect(firstLanding.acs!.location!.searchParams.get("__orbit_status")).toBe("transferable");
    await exchangeForAccount(browser);
    const userId = first(await sp.ctx.db.select().from(s.users))!.id;

    const again = new Browser();
    const landing = await login(again);
    expect(landing.acs!.location!.searchParams.get("__orbit_status")).toBe("complete");
    const sessions = await again.get(`${sp.url}/v1/client`).then((res) => res.json<{ response: { sessions: { user: { id: string } }[] } }>());
    expect(sessions.response.sessions[0]!.user.id).toBe(userId);
    expect(await sp.ctx.db.select().from(s.users)).toHaveLength(1);
    expect(await sp.ctx.db.select().from(s.externalAccounts)).toHaveLength(1);
  });

  it("links an assertion to an existing local user with the same verified email", async () => {
    const seeded = await createUser(sp, { email: `ada@${DOMAIN}` });
    const browser = new Browser();
    const landing = await login(browser);
    expect(landing.acs!.location!.searchParams.get("__orbit_status")).toBe("complete");
    const sessions = await browser.get(`${sp.url}/v1/client`).then((res) => res.json<{ response: { sessions: { user: { id: string } }[] } }>());
    expect(sessions.response.sessions[0]!.user.id).toBe(seeded.id);
    expect(first(await sp.ctx.db.select().from(s.externalAccounts))!.userId).toBe(seeded.id);
  });

  it("accepts IdP-initiated login only when the connection allows it", async () => {
    await backend(sp, "PATCH", `/v1/enterprise_connections/${connectionId}`, { active: false });
    const replacement = await createConnection({ allow_idp_initiated: false });
    connectionId = replacement.id;
    const unsolicited = () => samlResponse(idp, {
      spEntityId: conn.saml.sp_entity_id,
      acsUrl: conn.saml.acs_url,
      inResponseTo: null,
    });
    expect((await new Browser().request(conn.saml.acs_url, { form: { SAMLResponse: unsolicited() } })).status).toBe(400);

    await backend(sp, "PATCH", `/v1/enterprise_connections/${connectionId}`, { allow_idp_initiated: true });
    const browser = new Browser();
    const accepted = await browser.request(conn.saml.acs_url, { form: { SAMLResponse: unsolicited() } });
    expect(accepted.status).toBe(302);
    // The browser that started nothing still gets a client (and so a session once the flow completes).
    expect(accepted.headers.getSetCookie().some((line) => line.startsWith("__client="))).toBe(true);
    expect(accepted.location!.searchParams.get("__orbit_status")).toBe("transferable");
  });

  it("stops routing and accepting assertions once the connection is deactivated", async () => {
    await backend(sp, "PATCH", `/v1/enterprise_connections/${connectionId}`, { active: false });
    const browser = new Browser();
    const created = await browser.request(`${sp.url}/v1/client/sign_ins`, {
      json: { identifier: `ada@${DOMAIN}`, redirect_url: REDIRECT },
    });
    expect(created.status).toBe(422);

    const acs = await browser.request(conn.saml.acs_url, {
      form: { SAMLResponse: samlResponse(idp, { spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url, inResponseTo: null }), RelayState: "x" },
    });
    expect(acs.status).toBe(403);
    await expectNothingCreated();
  });

  it("refuses a status=failure response", async () => {
    const browser = new Browser();
    const { acs } = await login(browser, () => ({ status: "failure" }));
    expect(acs!.status).toBe(400);
    await expectNothingCreated();
  });

  it("does not leak the IdP certificate or any response body in an error message", async () => {
    const browser = new Browser();
    const { acs } = await login(browser, () => ({ sign: "none" }));
    expect(acs!.text).not.toContain("BEGIN CERTIFICATE");
    expect(acs!.text).not.toContain("SAMLResponse");
  });
});
