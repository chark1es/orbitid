import type { EnterpriseConnectionJSON } from "@orbitid/shared";
import { formatJson } from "../_config/settings";

export type Protocol = "saml" | "oidc";

export interface SsoForm {
  name: string;
  protocol: Protocol;
  domains: string[];
  idpEntityId: string;
  idpSsoUrl: string;
  idpCertificate: string;
  attributeMappingText: string;
  discoveryUrl: string;
  clientId: string;
  clientSecret: string;
  allowSubdomains: boolean;
  allowIdpInitiated: boolean;
  syncUserAttributes: boolean;
  disableAdditionalIdentifications: boolean;
}

export const EMPTY_FORM: SsoForm = {
  name: "",
  protocol: "saml",
  domains: [""],
  idpEntityId: "",
  idpSsoUrl: "",
  idpCertificate: "",
  attributeMappingText: formatJson({
    email: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/emailaddress",
    first_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/givenname",
    last_name: "http://schemas.xmlsoap.org/ws/2005/05/identity/claims/surname",
  }),
  discoveryUrl: "",
  clientId: "",
  clientSecret: "",
  allowSubdomains: false,
  allowIdpInitiated: false,
  syncUserAttributes: true,
  disableAdditionalIdentifications: false,
};

export function samlSpDetails(connection: EnterpriseConnectionJSON, apiUrl: string) {
  return {
    acsUrl: connection.saml?.acs_url || `${apiUrl}/v1/saml/${connection.id}/acs`,
    entityId: connection.saml?.sp_entity_id || `${apiUrl}/v1/saml/${connection.id}`,
    metadataUrl: connection.saml?.sp_metadata_url || `${apiUrl}/v1/saml/${connection.id}/metadata`,
  };
}
