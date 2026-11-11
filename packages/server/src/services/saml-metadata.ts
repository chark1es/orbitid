// SAML identity-provider metadata import.
//
// Operators usually paste a metadata URL or upload the XML file an IdP produces. Both carry the entity id,
// the SSO endpoint and the signing certificate that a connection needs; parsing them here keeps the wizard
// from asking for values the IdP already published.
import { ErrorCodes, OrbitError } from "@orbitid/shared";
import type { AppContext } from "../context";
import { assertPublicUrl, safeFetch } from "../lib/safe-fetch";

export interface IdpMetadata {
  entityId?: string;
  ssoUrl?: string;
  certificate?: string;
}

const attr = (xml: string, tag: string, name: string): string | undefined => {
  const element = new RegExp(`<[^>]*${tag}\\b[^>]*>`, "i").exec(xml)?.[0];
  if (!element) return undefined;
  const match = new RegExp(`${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, "i").exec(element);
  return match?.[2] ?? match?.[3] ?? undefined;
};

const decodeXmlEntities = (value: string) =>
  value
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");

/** The Redirect binding is what OrbitID sends, so it is preferred over the POST binding when both exist. */
function singleSignOnUrl(xml: string): string | undefined {
  const services = [...xml.matchAll(/<[^>]*SingleSignOnService\b[^>]*>/gi)].map((match) => match[0]);
  const redirect = services.find((element) => /HTTP-Redirect/i.test(attr(element, "SingleSignOnService", "Binding") ?? ""));
  const chosen = redirect ?? services[0];
  return chosen ? attr(chosen, "SingleSignOnService", "Location") : undefined;
}

function signingCertificate(xml: string): string | undefined {
  // SAML metadata marks the signing key with `use="signing"`; fall back to the first certificate in the document.
  const signingBlock = /<[^>]*KeyDescriptor\b[^>]*use\s*=\s*["']signing["'][^>]*>([\s\S]*?)<\/[^>]*KeyDescriptor>/i.exec(xml)?.[1];
  const raw = (/<(?:\w+:)?X509Certificate>([\s\S]*?)<\/(?:\w+:)?X509Certificate>/i.exec(signingBlock ?? xml)?.[1] ?? "").replace(/\s+/g, "");
  if (!raw) return undefined;
  return `-----BEGIN CERTIFICATE-----\n${raw.match(/.{1,64}/g)?.join("\n") ?? raw}\n-----END CERTIFICATE-----\n`;
}

/** Parses an IdP metadata document. Returns only what it finds; the caller decides what is still required. */
export function parseIdpMetadata(xml: string): IdpMetadata {
  if (!xml.trim()) throw new OrbitError(422, ErrorCodes.form_param_format_invalid, "The SAML metadata document is empty", { param_name: "idp_metadata_xml" });
  const entityId = attr(xml, "EntityDescriptor", "entityID") ?? attr(xml, "EntitiesDescriptor", "entityID");
  const ssoUrl = singleSignOnUrl(xml);
  const certificate = signingCertificate(xml);
  if (!entityId && !ssoUrl && !certificate) {
    throw new OrbitError(
      422,
      ErrorCodes.form_param_format_invalid,
      "That document does not look like SAML identity-provider metadata: no entity id, SSO URL or signing certificate was found",
      { param_name: "idp_metadata_xml" },
    );
  }
  return {
    entityId: entityId ? decodeXmlEntities(entityId) : undefined,
    ssoUrl: ssoUrl ? decodeXmlEntities(ssoUrl) : undefined,
    certificate,
  };
}

/** Fetches metadata from an operator-supplied URL through the SSRF guard and parses it. */
export async function fetchIdpMetadata(ctx: AppContext, url: string): Promise<IdpMetadata> {
  await assertPublicUrl(ctx, url, "idp_metadata_url");
  let body: string;
  try {
    const res = await safeFetch(ctx, url, { timeoutMs: 10_000, maxBytes: 512 * 1024, headers: { accept: "application/xml, text/xml, */*" } });
    if (!res.ok) {
      throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `Metadata request failed (${res.status})`, { param_name: "idp_metadata_url" });
    }
    body = res.body;
  } catch (err) {
    if (err instanceof OrbitError) throw err;
    throw new OrbitError(422, ErrorCodes.form_param_format_invalid, `Could not fetch the metadata URL: ${(err as Error).message}`, { param_name: "idp_metadata_url" });
  }
  return parseIdpMetadata(body);
}

export interface SamlMetadataInput {
  idpMetadataUrl?: string;
  idpMetadataXml?: string;
}

/**
 * Resolves metadata input into connection fields. Explicit form fields always win, so an operator can correct
 * a value the document got wrong (for example when the IdP publishes multiple certificates).
 */
export async function resolveSamlMetadata(ctx: AppContext, input: SamlMetadataInput): Promise<IdpMetadata> {
  if (!input.idpMetadataUrl?.trim() && !input.idpMetadataXml?.trim()) return {};
  const parsed = input.idpMetadataUrl?.trim()
    ? await fetchIdpMetadata(ctx, input.idpMetadataUrl.trim())
    : parseIdpMetadata(input.idpMetadataXml!);
  return parsed;
}
