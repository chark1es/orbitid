import { beforeAll, describe, it, expect, beforeEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { signSamlPost } from "@node-saml/node-saml/lib/saml-post-signing";
import * as s from "../../src/db/schema";
import { findConnectionForIdentifier } from "../../src/services/saml";
import type * as externalIdentity from "../../src/services/external-identity";
import { setup, authHeaders, insertClient, insertClientSession, insertUser, BASE_URL } from "./helpers";

const handleExternalIdentity = vi.hoisted(() =>
  vi.fn(async (_ctx: unknown, flow: { kind: string; clientId: string; redirectUrl: string; connectionId?: string }, profile: { provider: string; email?: string }) => ({
    redirectTo: `${flow.redirectUrl}?provider=${profile.provider}`,
  })),
);
vi.mock("../../src/services/external-identity", async (importOriginal) => {
  const actual = await importOriginal<typeof externalIdentity>();
  return { ...actual, handleExternalIdentity };
});

type Harness = Awaited<ReturnType<typeof setup>>;
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
}

/** Builds a Base64 SAML POST response with a signed Assertion (like a real IdP). */
function signedSamlResponse(opts: AssertionOptions): string {
  const now = new Date();
  const notBefore = new Date(now.getTime() - 60_000).toISOString();
  const notAfter = new Date(now.getTime() + 5 * 60_000).toISOString();
  const attributes = opts.attributes ?? { email: "ada@acme.com", firstName: "Ada", lastName: "Lovelace" };
  const attributeXml = Object.entries(attributes)
    .map(([name, value]) => `<saml:Attribute Name="${name}"><saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${value}</saml:AttributeValue></saml:Attribute>`)
    .join("");
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="_response1" Version="2.0" IssueInstant="${now.toISOString()}" Destination="${opts.destination ?? opts.acsUrl}">
  <saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:Success"/></samlp:Status>
  <saml:Assertion ID="_assertion1" Version="2.0" IssueInstant="${now.toISOString()}">
    <saml:Issuer>${IDP_ENTITY_ID}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${opts.nameID ?? "ada@acme.com"}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">
        <saml:SubjectConfirmationData NotOnOrAfter="${notAfter}" Recipient="${opts.acsUrl}"/>
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

const acs = (h: Harness, id: string, body: Record<string, string>) =>
  h.app.request(`/v1/saml/${id}/acs`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(body).toString(),
  });

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
    expect(findConnectionForIdentifier(h.ctx, "ada@acme.com")?.id).toBe(conn.id);
    expect(findConnectionForIdentifier(h.ctx, "ada@sub.acme.com")).toBeNull();
    expect(findConnectionForIdentifier(h.ctx, "ada@other.test")).toBeNull();

    await h.app.request(`/v1/enterprise_connections/${conn.id}`, { method: "PATCH", headers: authHeaders(), body: json({ allow_subdomains: true }) });
    expect(findConnectionForIdentifier(h.ctx, "ada@sub.acme.com")?.id).toBe(conn.id);

    await h.app.request(`/v1/enterprise_connections/${conn.id}`, { method: "PATCH", headers: authHeaders(), body: json({ active: false }) });
    expect(findConnectionForIdentifier(h.ctx, "ada@acme.com")).toBeNull();
  });
});

describe("SAML service provider", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    handleExternalIdentity.mockClear();
  });

  it("serves SP metadata and starts an SP-initiated login", async () => {
    const conn = await createSamlConnection(h);
    const metadata = await h.app.request(`/v1/saml/${conn.id}/metadata`);
    expect(metadata.status).toBe(200);
    expect(metadata.headers.get("content-type")).toContain("xml");
    const xml = await metadata.text();
    expect(xml).toContain("EntityDescriptor");
    expect(xml).toContain(conn.saml.acs_url);
    expect(xml).toContain(conn.saml.sp_entity_id);

    const client = insertClient(h.ctx);
    const res = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({
      client_id: client.clientId, identifier: "ada@acme.com", redirect_url: "http://localhost:3000/after",
    })}`);
    expect(res.status).toBe(302);
    const location = new URL(res.headers.get("location")!);
    expect(location.origin + location.pathname).toBe(IDP_SSO_URL);
    expect(location.searchParams.get("SAMLRequest")).toBeTruthy();
    expect(location.searchParams.get("RelayState")).toBeTruthy();
  });

  it("validates a signed assertion, maps attributes and continues the identity flow", async () => {
    const conn = await createSamlConnection(h);
    const client = insertClient(h.ctx);
    const start = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({
      client_id: client.clientId, email_address: "ada@acme.com", redirect_url: "http://localhost:3000/after",
    })}`);
    const relayState = new URL(start.headers.get("location")!).searchParams.get("RelayState")!;

    const response = await acs(h, conn.id, {
      SAMLResponse: signedSamlResponse({ spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url }),
      RelayState: relayState,
    });
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost:3000/after?provider=saml_" + conn.id);

    expect(handleExternalIdentity).toHaveBeenCalledTimes(1);
    const [ctxArg, flow, profile] = handleExternalIdentity.mock.calls[0]!;
    expect(ctxArg).toBe(h.ctx);
    expect(flow).toMatchObject({ kind: "sign_in", clientId: client.clientId, redirectUrl: "http://localhost:3000/after", connectionId: conn.id });
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
    const client = insertClient(h.ctx);
    const start = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({
      client_id: client.clientId, identifier: "ada@acme.com", redirect_url: "http://localhost:3000/after",
    })}`);
    const relayState = new URL(start.headers.get("location")!).searchParams.get("RelayState")!;

    const response = await acs(h, conn.id, {
      SAMLResponse: signedSamlResponse({
        spEntityId: conn.saml.sp_entity_id,
        acsUrl: conn.saml.acs_url,
        nameID: "ada-army-id",
        attributes: { mail: "ada@acme.com", givenName: "Ada", sn: "Byron", uid: "army-1" },
      }),
      RelayState: relayState,
    });
    expect(response.status).toBe(302);
    const profile = handleExternalIdentity.mock.calls[0]![2];
    expect(profile).toMatchObject({ providerUserId: "army-1", email: "ada@acme.com", firstName: "Ada", lastName: "Byron" });
  });

  it("rejects an assertion signed by an untrusted key or tampered after signing", async () => {
    const conn = await createSamlConnection(h);
    const client = insertClient(h.ctx);
    const start = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({
      client_id: client.clientId, identifier: "ada@acme.com", redirect_url: "http://localhost:3000/after",
    })}`);
    const relayState = new URL(start.headers.get("location")!).searchParams.get("RelayState")!;

    const wrongKey = await acs(h, conn.id, {
      SAMLResponse: signedSamlResponse({ spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url, key: otherKey, cert: otherCert }),
      RelayState: relayState,
    });
    expect(wrongKey.status).toBe(400);
    expect((await wrongKey.json()).errors[0].code).toBe("verification_failed");

    const tampered = await acs(h, conn.id, {
      SAMLResponse: signedSamlResponse({ spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url, tamper: true }),
      RelayState: relayState,
    });
    expect(tampered.status).toBe(400);
    expect(handleExternalIdentity).not.toHaveBeenCalled();
  });

  it("rejects unknown RelayState and audience mismatches", async () => {
    const conn = await createSamlConnection(h);
    const unknownState = await acs(h, conn.id, {
      SAMLResponse: signedSamlResponse({ spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url }),
      RelayState: "forged-state",
    });
    expect(unknownState.status).toBe(400);

    const client = insertClient(h.ctx);
    const start = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({
      client_id: client.clientId, identifier: "ada@acme.com", redirect_url: "http://localhost:3000/after",
    })}`);
    const relayState = new URL(start.headers.get("location")!).searchParams.get("RelayState")!;
    const wrongAudience = await acs(h, conn.id, {
      SAMLResponse: signedSamlResponse({ spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url, audience: "https://other-sp.example" }),
      RelayState: relayState,
    });
    expect(wrongAudience.status).toBe(400);
    expect(handleExternalIdentity).not.toHaveBeenCalled();
  });

  it("supports IdP-initiated login only when the connection allows it", async () => {
    const conn = await createSamlConnection(h, { allow_idp_initiated: false });
    const clientsBefore = h.ctx.db.select().from(s.clients).all().length;
    const rejected = await acs(h, conn.id, {
      SAMLResponse: signedSamlResponse({ spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url }),
    });
    expect(rejected.status).toBe(400);
    expect(handleExternalIdentity).not.toHaveBeenCalled();

    await h.app.request(`/v1/enterprise_connections/${conn.id}`, { method: "PATCH", headers: authHeaders(), body: json({ allow_idp_initiated: true }) });
    const accepted = await acs(h, conn.id, {
      SAMLResponse: signedSamlResponse({ spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url }),
    });
    expect(accepted.status).toBe(302);
    expect(h.ctx.db.select().from(s.clients).all().length).toBe(clientsBefore + 1);
    const flow = handleExternalIdentity.mock.calls[0]![1];
    expect(flow.kind).toBe("sign_in");
    expect(flow.redirectUrl).toBe("http://localhost:3000");
  });

  it("serves GET /:id/sso for an existing flow and for inline parameters", async () => {
    const conn = await createSamlConnection(h);
    const client = insertClient(h.ctx);
    const inline = await h.app.request(`/v1/saml/${conn.id}/sso?${new URLSearchParams({
      client_id: client.clientId, redirect_url: "http://localhost:3000/after",
    })}`);
    expect(inline.status).toBe(302);
    const state = new URL(inline.headers.get("location")!).searchParams.get("RelayState")!;

    const resumed = await h.app.request(`/v1/saml/${conn.id}/sso?flow=${encodeURIComponent(state)}`);
    expect(resumed.status).toBe(302);
    expect(new URL(resumed.headers.get("location")!).searchParams.get("RelayState")).toBe(state);

    // Resuming does not consume the state: the assertion that comes back still completes the flow.
    const completed = await acs(h, conn.id, {
      SAMLResponse: signedSamlResponse({ spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url }),
      RelayState: state,
    });
    expect(completed.status).toBe(302);
    expect(handleExternalIdentity).toHaveBeenCalledTimes(1);

    const unknown = await h.app.request(`/v1/saml/${conn.id}/sso?flow=missing`);
    expect(unknown.status).toBe(400);
  });

  it("refuses starting SSO with a disallowed redirect URL or an inactive connection", async () => {
    const conn = await createSamlConnection(h);
    const client = insertClient(h.ctx);
    const badRedirect = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({
      client_id: client.clientId, identifier: "ada@acme.com", redirect_url: "https://evil.example/steal",
    })}`);
    expect(badRedirect.status).toBe(422);

    await h.app.request(`/v1/enterprise_connections/${conn.id}`, { method: "PATCH", headers: authHeaders(), body: json({ active: false }) });
    const inactive = await h.app.request(`/v1/client/enterprise/start?${new URLSearchParams({
      client_id: client.clientId, identifier: "ada@acme.com", redirect_url: "http://localhost:3000/after",
    })}`);
    expect(inactive.status).toBe(404);

    const inactiveAcs = await acs(h, conn.id, {
      SAMLResponse: signedSamlResponse({ spEntityId: conn.saml.sp_entity_id, acsUrl: conn.saml.acs_url }),
    });
    expect(inactiveAcs.status).toBe(403);
  });
});
