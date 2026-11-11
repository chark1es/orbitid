// SAML IdP metadata import: the entity id, SSO URL and signing certificate come from the document an IdP
// publishes, not from three fields an operator has to retype. Both paths (pasted XML and fetched URL) are real:
// the URL case runs a tiny HTTP server on loopback.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { backend, resetFederationCaches, startFedServer, type FedServer } from "./helpers";
import { makeKeyPair, startSamlIdp, type IdpKeyPair, type SamlIdp } from "./saml-idp";

function metadataXml(keys: IdpKeyPair, entityId: string, ssoUrl: string) {
  const certificate = keys.cert.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  return `<?xml version="1.0" encoding="UTF-8"?>
<md:EntityDescriptor xmlns:md="urn:oasis:names:tc:SAML:2.0:metadata" entityID="${entityId}">
  <md:IDPSSODescriptor protocolSupportEnumeration="urn:oasis:names:tc:SAML:2.0:protocol">
    <md:KeyDescriptor use="signing">
      <ds:KeyInfo xmlns:ds="http://www.w3.org/2000/09/xmldsig#">
        <ds:X509Data><ds:X509Certificate>${certificate}</ds:X509Certificate></ds:X509Data>
      </ds:KeyInfo>
    </md:KeyDescriptor>
    <md:SingleSignOnService Binding="urn:oasis:names:tc:SAML:2.0:bindings:HTTP-Redirect" Location="${ssoUrl}"/>
  </md:IDPSSODescriptor>
</md:EntityDescriptor>`;
}

let sp: FedServer;
let idp: SamlIdp;
let keys: IdpKeyPair;

beforeEach(async () => {
  resetFederationCaches();
  sp = await startFedServer({ secretKey: "sk_test_federation_sp" });
  keys = makeKeyPair("metadata-idp");
  idp = await startSamlIdp(keys);
});

afterEach(async () => {
  await idp.close();
  await sp.close();
  resetFederationCaches();
});

describe("SAML metadata import", () => {
  it("creates a connection from pasted XML, filling entity id, SSO URL and certificate", async () => {
    const res = await backend(sp, "POST", "/v1/enterprise_connections", {
      name: "Acme from metadata",
      protocol: "saml",
      domains: ["metadata.test"],
      active: true,
      idp_metadata_xml: metadataXml(keys, idp.entityId, idp.ssoUrl),
    });
    expect(res.status, res.text).toBe(201);
    const created = res.json<{ id: string; saml: { idp_entity_id: string; idp_sso_url: string; idp_certificate: string } }>();
    expect(created.saml.idp_entity_id).toBe(idp.entityId);
    expect(created.saml.idp_sso_url).toBe(idp.ssoUrl);
    expect(created.saml.idp_certificate).toContain("BEGIN CERTIFICATE");
  });

  it("fetches metadata from a URL through the SSRF guard", async () => {
    const xml = metadataXml(keys, `${idp.entityId}/from-url`, idp.ssoUrl);
    const server: Server = createServer((_req, res) => {
      res.setHeader("content-type", "application/xml");
      res.end(xml);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    try {
      const res = await backend(sp, "POST", "/v1/enterprise_connections", {
        name: "Acme from URL",
        protocol: "saml",
        domains: ["metadata-url.test"],
        active: false,
        idp_metadata_url: `http://127.0.0.1:${port}/metadata`,
      });
      expect(res.status, res.text).toBe(201);
      const created = res.json<{ saml: { idp_entity_id: string } }>();
      expect(created.saml.idp_entity_id).toBe(`${idp.entityId}/from-url`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("lets an explicit field override a value in the metadata", async () => {
    const res = await backend(sp, "POST", "/v1/enterprise_connections", {
      name: "Acme override",
      protocol: "saml",
      domains: ["metadata-override.test"],
      active: false,
      idp_entity_id: "https://explicit.example/entity",
      idp_metadata_xml: metadataXml(keys, idp.entityId, idp.ssoUrl),
    });
    expect(res.status).toBe(201);
    expect(res.json<{ saml: { idp_entity_id: string } }>().saml.idp_entity_id).toBe("https://explicit.example/entity");
  });

  it("refuses a document that is not SAML metadata", async () => {
    const res = await backend(sp, "POST", "/v1/enterprise_connections", {
      name: "Not metadata",
      protocol: "saml",
      domains: ["not-metadata.test"],
      idp_metadata_xml: "<html><body>Hello</body></html>",
    });
    expect(res.status).toBe(422);
    expect(res.text).toMatch(/does not look like SAML/);
  });
});
