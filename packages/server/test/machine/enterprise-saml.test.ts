import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync, } from "node:child_process";
import { inflateRawSync } from "node:zlib";
import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { signSamlPost } from "@node-saml/node-saml/lib/saml-post-signing";
import * as s from "../../src/db/schema";
import { findConnectionForIdentifier } from "../../src/services/saml";
import type * as externalIdentity from "../../src/services/external-identity";
import { setup, authHeaders, insertClient, insertClientSession, insertUser, BASE_URL } from "./helpers";
import { first } from "../../src/lib/db";

const handleExternalIdentity = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, flow: { kind: string; clientId: string; redirectUrl: string; connectionId?: string }, profile: { provider: string; email?: string }) => ({
    redirectTo: `${flow.redirectUrl}?provider=${profile.provider}`,
  })),
);
vi.mock("../../src/services/external-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof externalIdentity>();
  return { ...actual, handleExternalIdentity };
});

type Harness = Awaited<Awaited<ReturnType<typeof setup>>>;
const json = (body: unknown) => JSON.stringify(body);
const IDP_ENTITY_ID = "https://idp.acme.test/metadata";
const IDP_SSO_URL = "https://idp.acme.test/sso";

let idpKey = "";
let idpCert = "";
let otherKey = "";
let otherCert = "";

function makeKeyPair(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), `orbitid-saml-${prefix}-`));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${prefix}-idp`,
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "pipe" });
  return { key: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
}

beforeAll(() => {
  const a = makeKeyPair("primary");
  idpKey = a.key;
  idpCert = a.cert;
  const b = makeKeyPair("attacker");
  otherKey = b.key;
  otherCert = b.cert;
}, 60_000);

interface AssertionOptions {
  spEntityId: string;
  acsUrl: string;
  nameID?: string;
  attributes?: Record<string, string>;
  key?: string;
  cert?: string;
  tamper?: boolean;
  destination?: string;
  audience?: string;
  /** ID of the AuthnRequest this response answers (omit for IdP-initiated responses). */
  inResponseTo?: string;
  assertionId?: string;
  validForMs?: number;
}

/** Builds a Base64 SAML POST response with a signed Assertion (like a real IdP). */
function signedSamlResponse(opts: AssertionOptions): string {
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000).toISOString();
  const notAfter = new Date(now.getTime() + (opts.validForMs ?? 5 * 60_000)).toISOString();
  const attributes = opts.attributes ?? { email: "ada@acme.com", firstName: "Ada", lastName: "Lovelace" };
  const attributeXml = Object.entries(attributes)
    .map(([name, value]) => `<saml:Attribute Name="${name}"><saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${value}</saml:AttributeValue></saml:Attribute>`)
    .join("");
  const assertionId = opts.assertionId ?? `_assertion${randomBytes(8).toString("hex")}`;
  const inResponseTo = opts.inResponseTo ? ` InResponseTo="${opts.inResponseTo}"` : "";
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response${randomBytes(8).toString("hex")}" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${opts.destination ?? opts.acsUrl}"${inResponseTo}>
  <saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${now.toISOString()}">
    <saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.nameID ?? "ada@acme.com"}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData NotOnOrAfter="${notAfter}" Recipient="${opts.acsUrl}"${inResponseTo}/>
      </saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${notBefore}" NotOnOrAfter="${notAfter}">
      <saml:AudienceRestriction><saml:Audience>${opts.audience ?? opts.spEntityId}</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${now.toISOString()}" SessionIndex="_session1">
      <saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>
    </saml:AuthnStatement>
    <saml:AttributeStatement>${attributeXml}</saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;
  const signed = signSamlPost(xml, "//*[local-name(.)='Assertion']", { privateKey: opts.key ?? idpKey, publicCert: opts.cert ?? idpCert, signatureAlgorithm: "sha256" });
  const finalXml = opts.tamper ? signed.replace(">Ada<", ">Mallory<") : signed;
  return Buffer.from(finalXml, "utf8").toString("base64");
}

async function createSamlConnection(h: Harness, overrides: Record<string, unknown> = {}) {
  const res = await h.app.request("/v1/enterprise_connections", {
    method: "POST",
    headers: authHeaders(),
    body: json({
      name: "Acme SAML",
      protocol: "saml",
      domains: ["acme.com"],
      active: true,
      idp_entity_id: IDP_ENTITY_ID,
      idp_sso_url: IDP_SSO_URL,
      idp_certificate: idpCert,
      ...overrides,
    }),
  });
  expect(res.status).toBe(201);
  return res.json();
}

const acs = (h: Harness, id: string, body: Record<string, string>, cookie?: string) =>
  h.app.request(`/v1/saml/${id}/acs`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", ...(cookie ? { cookie } : {}) },
    body: new URLSearchParams(body).toString(),
  });

/** What a browser does: start the flow carrying its client cookie, keep the binding cookie the server sets. */
async function startSaml(h: Harness, params: Record<string, string> = { identifier: "ada@acme.com" }, existing?: Awaited<ReturnType<typeof insertClient>>) {
  const client = existing ?? await insertClient(h.ctx);
  const res = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({
    client_id: client.clientId, redirect_url: "http://localhost:3000/after", ...params,
  })}`, { headers: { cookie: `__client=${client.token}` } });
  const binding = /__orbit_oauth=([^;]+)/.exec(res.headers.get("set-cookie") ?? "")?.[1];
  const location = res.headers.get("location") ? new URL(res.headers.get("location")!) : null;
  const samlRequest = location?.searchParams.get("SAMLRequest");
  const requestId = samlRequest ? /ID="([^"]+)"/.exec(inflateRawSync(Buffer.from(samlRequest, "base64")).toString("utf8"))?.[1] : undefined;
  return {
    res, client, requestId,
    relayState: location?.searchParams.get("RelayState") ?? undefined,
    cookie: `__client=${client.token}${binding ? `; __orbit_oauth=${binding}` : ""}`,
  };
}

describe("enterprise connections — backend CRUD", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    handleExternalIdentity.mockClear();
  });

  it("creates a SAML connection and returns SP endpoints", async () => {
    const conn = await createSamlConnection(h);
    expect(conn.object).toBe("enterprise_connection");
    expect(conn.id).toMatch(/^ent_/);
    expect(conn.saml.acs_url).toBe(`${BASE_URL}/v1/saml/${conn.id}/acs`);
    expect(conn.saml.sp_entity_id).toBe(`${BASE_URL}/v1/saml/${conn.id}`);
    expect(conn.saml.sp_metadata_url).toBe(`${BASE_URL}/v1/saml/${conn.id}/metadata`);
    expect(conn.saml.attribute_mapping).toEqual({ email: "email", first_name: "firstName", last_name: "lastName", user_id: "nameID" });
    expect(conn.saml.idp_certificate).toContain("BEGIN CERTIFICATE");
    expect(conn.domains).toEqual(["acme.com"]);

    const list = await h.app.request("/v1/enterprise_connections?protocol=saml&active=true", { headers: authHeaders() });
    expect((await list.json()).total_count).toBe(1);

    const patched = await h.app.request(`/v1/enterprise_connections/${conn.id}`, {
      method: "PATCH", headers: authHeaders(), body: json({ domains: ["acme.com", "acme.test"], active: false, allow_subdomains: true }),
    });
    const patchedBody = await patched.json();
    expect(patchedBody.domains).toEqual(["acme.com", "acme.test"]);
    expect(patchedBody.allow_subdomains).toBe(true);
    expect(patchedBody.active).toBe(false);

    const deleted = await h.app.request(`/v1/enterprise_connections/${conn.id}`, { method: "DELETE", headers: authHeaders() });
    expect((await deleted.json()).deleted).toBe(true);
  });

  it("validates certificates, domains and required protocol fields", async () => {
    const badCert = await h.app.request("/v1/enterprise_connections", {
      method: "POST", headers: authHeaders(),
      body: json({ name: "x", protocol: "saml", idp_entity_id: "e", idp_sso_url: IDP_SSO_URL, idp_certificate: "not a cert" }),
    });
    expect(badCert.status).toBe(422);
    expect((await badCert.json()).errors[0].code).toBe("form_param_format_invalid");

    const missingSaml = await h.app.request("/v1/enterprise_connections", {
      method: "POST", headers: authHeaders(), body: json({ name: "x", protocol: "saml" }),
    });
    expect(missingSaml.status).toBe(422);

    const missingOidc = await h.app.request("/v1/enterprise_connections", {
      method: "POST", headers: authHeaders(), body: json({ name: "x", protocol: "oidc" }),
    });
    expect(missingOidc.status).toBe(422);
    expect((await missingOidc.json()).errors[0].meta.param_name).toBe("client_id");

    const badDomain = await h.app.request("/v1/enterprise_connections", {
      method: "POST", headers: authHeaders(),
      body: json({ name: "x", protocol: "saml", domains: ["not a domain"], idp_entity_id: "e", idp_sso_url: IDP_SSO_URL, idp_certificate: idpCert }),
    });
    expect(badDomain.status).toBe(422);
  });

  it("matches connections by email domain, including subdomains when allowed", async () => {
    const conn = await createSamlConnection(h, { domains: ["acme.com"], allow_subdomains: false, active: true });
    expect((await findConnectionForIdentifier(h.ctx, "ada@acme.com"))?.id).toBe(conn.id);
    expect(await findConnectionForIdentifier(h.ctx, "ada@sub.acme.com")).toBeNull();
    expect(await findConnectionForIdentifier(h.ctx, "ada@other.test")).toBeNull();

    await h.app.request(`/v1/enterprise_connections/${conn.id}`, { method: "PATCH", headers: authHeaders(), body: json({ allow_subdomains: true }) });
    expect((await findConnectionForIdentifier(h.ctx, "ada@sub.acme.com"))?.id).toBe(conn.id);

    await h.app.request(`/v1/enterprise_connections/${conn.id}`, { method: "PATCH", headers: authHeaders(), body: json({ active: false }) });
    expect(await findConnectionForIdentifier(h.ctx, "ada@acme.com")).toBeNull();
  });
});

describe("SAML service provider", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    handleExternalIdentity.mockClear();
  });

  const response = (conn: { saml: { sp_entity_id: string; acs_url: string } }, extra: Partial<AssertionOptions> = {}) =>
    signedSamlResponse({ spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url, ...extra });

  it("serves SP metadata and starts an SP-initiated login", async () => {
    const conn = await createSamlConnection(h);
    const metadata = await h.app.request(`/v1/saml/${conn.id}/metadata`);
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toContain("xml");
    const xml = await metadata.text();
    expect(xml).toContain("EntityDescriptor");
    expect(xml).toContain(conn.saml.acs_url);
    expect(xml).toContain(conn.saml.sp_entity_id);

    const start = await startSaml(h);
    expect(start.res.status).toBe(302);
    const location = new URL(start.res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(IDP_SSO_URL);
    expect(start.requestId).toBeTruthy();
    expect(start.relayState).toBeTruthy();
    expect(start.cookie).toContain("__orbit_oauth=");
  });

  it("validates a signed assertion, maps attributes and continues the identity flow", async () => {
    const conn = await createSamlConnection(h);
    const start = await startSaml(h, { email_address: "ada@acme.com" });

    const res = await acs(h, conn.id, { SAMLResponse: response(conn, { inResponseTo: start.requestId }), RelayState: start.relayState! }, start.cookie);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("http://localhost:3000/after?provider=saml_" + conn.id);

    expect(handleExternalIdentity).toHaveBeenCalledTimes(1);
    const [ctxArg, flow, profile] = handleExternalIdentity.mock.calls[0]!;
    expect(ctxArg).toBe(h.ctx);
    expect(flow).toMatchObject({ kind: "sign_in", clientId: start.client.clientId, redirectUrl: "http://localhost:3000/after", connectionId: conn.id });
    expect(profile).toMatchObject({
      provider: `saml_${conn.id}`,
      providerUserId: "ada@acme.com",
      email: "ada@acme.com",
      emailVerified: true,
      firstName: "Ada",
      lastName: "Lovelace",
    });
  });

  it("honours a custom attribute mapping", async () => {
    const conn = await createSamlConnection(h, {
      attribute_mapping: { email: "mail", first_name: "givenName", last_name: "sn", user_id: "uid" },
    });
    const start = await startSaml(h);

    const res = await acs(h, conn.id, {
      SAMLResponse: response(conn, {
        inResponseTo: start.requestId,
        nameID: "ada-army-id",
        attributes: { mail: "ada@acme.com", givenName: "Ada", sn: "Byron", uid: "army-1" },
      }),
      RelayState: start.relayState!,
    }, start.cookie);
    expect(res.status).toBe(302);
    const profile = handleExternalIdentity.mock.calls[0]![2];
    expect(profile).toMatchObject({ providerUserId: "army-1", email: "ada@acme.com", firstName: "Ada", lastName: "Byron" });
  });

  it("rejects an assertion signed by an untrusted key or tampered after signing", async () => {
    const conn = await createSamlConnection(h);
    const start = await startSaml(h);

    const wrongKey = await acs(h, conn.id, {
      SAMLResponse: response(conn, { inResponseTo: start.requestId, key: otherKey, cert: otherCert }),
      RelayState: start.relayState!,
    }, start.cookie);
    expect(wrongKey.status).toBe(400);
    expect((await wrongKey.json()).errors[0].code).toBe("verification_failed");

    const tampered = await acs(h, conn.id, {
      SAMLResponse: response(conn, { inResponseTo: start.requestId, tamper: true }),
      RelayState: start.relayState!,
    }, start.cookie);
    expect(tampered.status).toBe(400);
    expect(handleExternalIdentity).not.toHaveBeenCalled();
  });

  it("rejects unknown RelayState and audience mismatches", async () => {
    const conn = await createSamlConnection(h);
    const unknownState = await acs(h, conn.id, { SAMLResponse: response(conn), RelayState: "forged-state" });
    expect(unknownState.status).toBe(400);

    const start = await startSaml(h);
    const wrongAudience = await acs(h, conn.id, {
      SAMLResponse: response(conn, { inResponseTo: start.requestId, audience: "https://other-sp.example" }),
      RelayState: start.relayState!,
    }, start.cookie);
    expect(wrongAudience.status).toBe(400);
    expect(handleExternalIdentity).not.toHaveBeenCalled();
  });

  it("only accepts a response to a request the service provider issued, once", async () => {
    const conn = await createSamlConnection(h);
    const start = await startSaml(h);

    const unsolicited = await acs(h, conn.id, { SAMLResponse: response(conn, { inResponseTo: "_never_issued" }), RelayState: start.relayState! }, start.cookie);
    expect(unsolicited.status).toBe(400);

    // The failed attempt consumed the RelayState, so start again and answer correctly.
    const second = await startSaml(h);
    const captured = response(conn, { inResponseTo: second.requestId, assertionId: "_captured" });
    expect((await acs(h, conn.id, { SAMLResponse: captured, RelayState: second.relayState! }, second.cookie)).status).toBe(302);

    // An attacker replays the captured response with a flow they started themselves.
    const attacker = await startSaml(h);
    const replay = await acs(h, conn.id, { SAMLResponse: captured, RelayState: attacker.relayState! }, attacker.cookie);
    expect(replay.status).toBe(400);
    expect(handleExternalIdentity).toHaveBeenCalledTimes(1);
  });

  it("remembers an assertion for as long as it is valid, and the OAuth callback cannot clear the cache", async () => {
    const conn = await createSamlConnection(h);
    const start = await startSaml(h);
    const longLived = response(conn, { inResponseTo: start.requestId, assertionId: "_long_lived", validForMs: 3 * 60 * 60_000 });
    expect((await acs(h, conn.id, { SAMLResponse: longLived, RelayState: start.relayState! }, start.cookie)).status).toBe(302);

    const row = (await h.ctx.db.select().from(s.oauthStates).where(eq(s.oauthStates.provider, "saml_cache"))).find((r) => r.state.includes("_long_lived"))!;
    expect(row.expiresAt - Date.now()).toBeGreaterThan(2 * 60 * 60_000);

    // The generic OAuth callback must not be able to consume replay-protection rows.
    await h.app.request(`/v1/oauth_callback/saml_cache?state=${encodeURIComponent(row.state)}`);
    expect(first(await h.ctx.db.select().from(s.oauthStates).where(eq(s.oauthStates.state, row.state)))).toBeTruthy();
  });

  it("will not complete a flow in a browser other than the one that started it", async () => {
    const conn = await createSamlConnection(h);
    const start = await startSaml(h);
    const victim = await acs(h, conn.id, { SAMLResponse: response(conn, { inResponseTo: start.requestId }), RelayState: start.relayState! }, `__client=${(await insertClient(h.ctx)).token}`);
    expect(victim.status).toBe(400);
    expect(handleExternalIdentity).not.toHaveBeenCalled();
  });

  it("binds the flow to the browser's own client, whatever client_id the link carries", async () => {
    await createSamlConnection(h);
    const victim = await insertClient(h.ctx);
    const attacker = await insertClient(h.ctx);
    const noCookie = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({ client_id: victim.clientId, identifier: "ada@acme.com" })}`);
    expect(noCookie.status).toBe(422);
    const wrongClient = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({ client_id: victim.clientId, identifier: "ada@acme.com" })}`, {
      headers: { cookie: `__client=${attacker.token}` },
    });
    expect(wrongClient.status).toBe(422);
  });

  it("supports IdP-initiated login only when the connection allows it, and hands the browser its client", async () => {
    const conn = await createSamlConnection(h, { allow_idp_initiated: false });
    const clientsBefore = (await h.ctx.db.select().from(s.clients)).length;
    const rejected = await acs(h, conn.id, { SAMLResponse: response(conn) });
    expect(rejected.status).toBe(400);
    expect(handleExternalIdentity).not.toHaveBeenCalled();

    await h.app.request(`/v1/enterprise_connections/${conn.id}`, { method: "PATCH", headers: authHeaders(), body: json({ allow_idp_initiated: true }) });
    const accepted = await acs(h, conn.id, { SAMLResponse: response(conn) });
    expect(accepted.status).toBe(302);
    expect((await h.ctx.db.select().from(s.clients)).length).toBe(clientsBefore + 1);
    expect(accepted.headers.get("set-cookie")).toMatch(/__client=[^;]+/);
    const flow = handleExternalIdentity.mock.calls[0]![1];
    expect(flow.kind).toBe("sign_in");
    expect(flow.redirectUrl).toBe("http://localhost:3000");
  });

  it("serves GET /:id/sso for an existing flow and for inline parameters", async () => {
    const conn = await createSamlConnection(h);
    const client = await insertClient(h.ctx);
    const inline = await h.app.request(`/v1/saml/${conn.id}/sso?${new URLSearchParams({
      client_id: client.clientId, redirect_url: "http://localhost:3000/after",
    })}`, { headers: { cookie: `__client=${client.token}` } });
    expect(inline.status).toBe(302);
    const binding = /__orbit_oauth=([^;]+)/.exec(inline.headers.get("set-cookie") ?? "")?.[1];
    const inlineLocation = new URL(inline.headers.get("location")!);
    const state = inlineLocation.searchParams.get("RelayState")!;
    const requestId = /ID="([^"]+)"/.exec(inflateRawSync(Buffer.from(inlineLocation.searchParams.get("SAMLRequest")!, "base64")).toString("utf8"))![1];

    const resumed = await h.app.request(`/v1/saml/${conn.id}/sso?flow=${encodeURIComponent(state)}`);
    expect(resumed.status).toBe(302);
    expect(new URL(resumed.headers.get("location")!).searchParams.get("RelayState")).toBe(state);

    // Resuming does not consume the state: the assertion that comes back still completes the flow.
    const resumedRequestId = /ID="([^"]+)"/.exec(inflateRawSync(Buffer.from(new URL(resumed.headers.get("location")!).searchParams.get("SAMLRequest")!, "base64")).toString("utf8"))![1];
    expect(resumedRequestId).not.toBe(requestId);
    const completed = await acs(h, conn.id, { SAMLResponse: response(conn, { inResponseTo: resumedRequestId }), RelayState: state }, `__client=${client.token}; __orbit_oauth=${binding}`);
    expect(completed.status).toBe(302);
    expect(handleExternalIdentity).toHaveBeenCalledTimes(1);

    const unknown = await h.app.request(`/v1/saml/${conn.id}/sso?flow=missing`);
    expect(unknown.status).toBe(400);
  });

  it("refuses starting SSO with a disallowed redirect URL or an inactive connection", async () => {
    const conn = await createSamlConnection(h);
    const bad = await startSaml(h, { identifier: "ada@acme.com", redirect_url: "https://evil.example/steal" });
    expect(bad.res.status).toBe(422);

    await h.app.request(`/v1/enterprise_connections/${conn.id}`, { method: "PATCH", headers: authHeaders(), body: json({ active: false }) });
    const inactive = await startSaml(h);
    expect(inactive.res.status).toBe(404);

    const inactiveAcs = await acs(h, conn.id, { SAMLResponse: response(conn) });
    expect(inactiveAcs.status).toBe(403);
  });
});
