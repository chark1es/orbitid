// A minimal SAML 2.0 identity provider for the federation tests.
//
// It is a real HTTP server: it serves metadata, accepts a (deflated) AuthnRequest over the HTTP-Redirect
// binding and posts a signed Response back to the SP's ACS. Signing uses `@node-saml/node-saml`'s own
// `signSamlPost`, the same library the server validates with, so a signature that the IdP produces is
// exactly the shape a real deployment emits.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { signSamlPost } from "@node-saml/node-saml/lib/saml-post-signing";

export interface IdpKeyPair {
  privateKey: string;
  cert: string;
}

/** A throwaway RSA key pair + self-signed certificate (openssl is available in the test environment). */
export function makeKeyPair(label = "idp"): IdpKeyPair {
  const dir = mkdtempSync(join(tmpdir(), `orbitid-saml-${label}-`));
  execFileSync("openssl", [
    "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "2", "-subj", `/CN=${label}`,
    "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
  ], { stdio: "pipe" });
  return { privateKey: readFileSync(join(dir, "key.pem"), "utf8"), cert: readFileSync(join(dir, "cert.pem"), "utf8") };
}

export interface AssertionOptions {
  spEntityId: string;
  acsUrl: string;
  destination?: string;
  audience?: string;
  /** Assertion subject; defaults to the email address. */
  nameID?: string;
  attributes?: Record<string, string | string[]>;
  /** Which element gets the signature. `none` leaves the response unsigned. */
  sign?: "assertion" | "response" | "none";
  /** Sign with a different key than the connection's configured certificate. */
  keyPair?: IdpKeyPair;
  inResponseTo?: string | null;
  assertionId?: string;
  responseId?: string;
  issueInstant?: Date;
  notBefore?: Date;
  notOnOrAfter?: Date;
  authnInstant?: Date;
  status?: "success" | "failure";
  /** Injects extra XML inside the Assertion (signature-wrapping attempts). */
  injectAssertionXml?: (assertionId: string, signedXml: string) => string;
}

const ISO = (date: Date) => date.toISOString();

function attributeXml(attributes: Record<string, string | string[]>): string {
  return Object.entries(attributes)
    .map(([name, value]) => {
      const values = Array.isArray(value) ? value : [value];
      const inner = values
        .map((item) => `<saml:AttributeValue xmlns:xs="http://www.w3.org/2001/XMLSchema" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xsi:type="xs:string">${escapeXml(item)}</saml:AttributeValue>`)
        .join("");
      return `<saml:Attribute Name="${escapeXml(name)}" NameFormat="urn:oasis:names:tc:SAML:2.0:attrname-format:basic">${inner}</saml:Attribute>`;
    })
    .join("");
}

const escapeXml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Builds and signs a SAML POST response. Returns the base64 body a browser would post to the ACS. */
export function samlResponse(idp: { entityId: string; keyPair: IdpKeyPair }, opts: AssertionOptions): string {
  const now = opts.issueInstant ?? new Date();
  const notBefore = opts.notBefore ?? new Date(now.getTime() - 60_000);
  const notOnOrAfter = opts.notOnOrAfter ?? new Date(now.getTime() + 5 * 60_000);
  const assertionId = opts.assertionId ?? `_a${randomBytes(12).toString("hex")}`;
  const responseId = opts.responseId ?? `_r${randomBytes(12).toString("hex")}`;
  const inResponseTo = opts.inResponseTo ? ` InResponseTo="${escapeXml(opts.inResponseTo)}"` : "";
  const subjectConfirmationData =
    `<saml:SubjectConfirmationData NotOnOrAfter="${ISO(notOnOrAfter)}" Recipient="${escapeXml(opts.acsUrl)}"${inResponseTo}/>`;
  const attributes = opts.attributes ?? { email: opts.nameID ?? "ada@acme.test", firstName: "Ada", lastName: "Lovelace" };

  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<samlp:Response xmlns:samlp="urn:oasis:names:tc:SAML:2.0:protocol" xmlns:saml="urn:oasis:names:tc:SAML:2.0:assertion" ID="${responseId}" Version="2.0" IssueInstant="${ISO(now)}" Destination="${escapeXml(opts.destination ?? opts.acsUrl)}"${inResponseTo}>
  <saml:Issuer>${escapeXml(idp.entityId)}</saml:Issuer>
  <samlp:Status><samlp:StatusCode Value="urn:oasis:names:tc:SAML:2.0:status:${opts.status === "failure" ? "Requester" : "Success"}"/></samlp:Status>
  <saml:Assertion ID="${assertionId}" Version="2.0" IssueInstant="${ISO(now)}">
    <saml:Issuer>${escapeXml(idp.entityId)}</saml:Issuer>
    <saml:Subject>
      <saml:NameID Format="urn:oasis:names:tc:SAML:1.1:nameid-format:emailAddress">${escapeXml(opts.nameID ?? "ada@acme.test")}</saml:NameID>
      <saml:SubjectConfirmation Method="urn:oasis:names:tc:SAML:2.0:cm:bearer">${subjectConfirmationData}</saml:SubjectConfirmation>
    </saml:Subject>
    <saml:Conditions NotBefore="${ISO(notBefore)}" NotOnOrAfter="${ISO(notOnOrAfter)}">
      <saml:AudienceRestriction><saml:Audience>${escapeXml(opts.audience ?? opts.spEntityId)}</saml:Audience></saml:AudienceRestriction>
    </saml:Conditions>
    <saml:AuthnStatement AuthnInstant="${ISO(opts.authnInstant ?? now)}" SessionIndex="_session${randomBytes(4).toString("hex")}">
      <saml:AuthnContext><saml:AuthnContextClassRef>urn:oasis:names:tc:SAML:2.0:ac:classes:PasswordProtectedTransport</saml:AuthnContextClassRef></saml:AuthnContext>
    </saml:AuthnStatement>
    <saml:AttributeStatement>${attributeXml(attributes)}</saml:AttributeStatement>
  </saml:Assertion>
</samlp:Response>`;

  const keyPair = opts.keyPair ?? idp.keyPair;
  let signed = xml;
  if (opts.sign !== "none") {
    const xpath = opts.sign === "response" ? "//*[local-name(.)='Response']" : "//*[local-name(.)='Assertion']";
    signed = signSamlPost(xml, xpath, { privateKey: keyPair.privateKey, publicCert: keyPair.cert, signatureAlgorithm: "sha256" });
  }
  if (opts.injectAssertionXml) signed = opts.injectAssertionXml(assertionId, signed);
  return Buffer.from(signed, "utf8").toString("base64");
}

export interface CompletedAuthnRequest {
  id: string;
  acsUrl: string;
  issuer: string;
  relayState: string | null;
  destination: string | null;
  issuedAt: string | null;
}

/** Parses a deflated, base64 HTTP-Redirect AuthnRequest (the shape OrbitID sends). */
export function parseAuthnRequest(samlRequest: string): CompletedAuthnRequest {
  const xml = inflateRawSync(Buffer.from(samlRequest, "base64")).toString("utf8");
  const attr = (name: string) => new RegExp(`\\b${name}="([^"]*)"`).exec(xml)?.[1] ?? null;
  return {
    id: attr("ID") ?? "",
    acsUrl: attr("AssertionConsumerServiceURL") ?? "",
    destination: attr("Destination"),
    issuedAt: attr("IssueInstant"),
    issuer: /<saml:Issuer[^>]*>([^<]*)<\/saml:Issuer>/.exec(xml)?.[1] ?? "",
    relayState: null,
  };
}

export interface SamlIdp {
  entityId: string;
  ssoUrl: string;
  keyPair: IdpKeyPair;
  /** Where the IdP posts its response when the AuthnRequest names no AssertionConsumerServiceURL. */
  acsUrl: string;
  /** Every AuthnRequest the SP sent, in order. */
  requests: CompletedAuthnRequest[];
  /** What the next `/sso` call answers with. */
  respond: (request: CompletedAuthnRequest) => { SAMLResponse: string; RelayState: string | null } | { error: string };
  close(): Promise<void>;
}

/**
 * Starts the IdP. The SP is expected to redirect the browser here with `SAMLRequest` and `RelayState`;
 * this server answers with an auto-submitting form (the HTTP-POST binding) unless the test overrides it.
 */
export async function startSamlIdp(keyPair: IdpKeyPair, entityId = "https://idp.acme.test/metadata"): Promise<SamlIdp> {
  const state: SamlIdp = {
    entityId,
    ssoUrl: "",
    keyPair,
    acsUrl: "",
    requests: [],
    respond: () => ({ error: "no response staged" }),
    close: async () => {},
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/metadata") {
      res.writeHead(200, { "content-type": "application/xml" });
      res.end(`<?xml version="1.0"?>
<EntityDescriptor xmlns="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${state.entityId}">
  <IDPSSODescriptor WantAuthnRequestsSigned="false" protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#"><ds:X509Data><ds:X509Certificate>${keyPair.cert.replace(/-----[^-]+-----|\s/g, "")}</ds:X509Certificate></ds:X509Data></ds:KeyInfo>
    </KeyDescriptor>
    <SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${state.ssoUrl}"/>
  </IDPSSODescriptor>
</EntityDescriptor>`);
      return;
    }
    if (url.pathname === "/sso") {
      const samlRequest = url.searchParams.get("SAMLRequest");
      if (!samlRequest) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end("SAMLRequest missing");
        return;
      }
      const parsed = { ...parseAuthnRequest(samlRequest), relayState: url.searchParams.get("RelayState") };
      state.requests.push(parsed);
      const outcome = state.respond(parsed);
      if ("error" in outcome) {
        res.writeHead(400, { "content-type": "text/plain" });
        res.end(outcome.error);
        return;
      }
      const form = `<html><body onload="document.forms[0].submit()"><form method="post" action="${escapeXml(parsed.acsUrl || state.acsUrl)}">
<input type="hidden" name="SAMLResponse" value="${escapeXml(outcome.SAMLResponse)}"/>
${outcome.RelayState ? `<input type="hidden" name="RelayState" value="${escapeXml(outcome.RelayState)}"/>` : ""}
</form></body></html>`;
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(form);
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address() as AddressInfo;
  state.ssoUrl = `http://127.0.0.1:${port}/sso`;
  state.close = async () => { await new Promise<void>((resolve) => server.close(() => resolve())); };
  return state;
}
