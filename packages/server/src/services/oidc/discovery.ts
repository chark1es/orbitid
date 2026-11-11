// OpenID Provider metadata (`/.well-known/openid-configuration` and RFC 8414 authorization-server metadata).
//
// The issuer is always the public origin, never the request's internal origin: discovery, the `iss` claim on every
// token and the advertised endpoints must agree byte for byte or clients reject the tokens.
import type { AppContext } from "../../context";
import { BASE_OIDC_SCOPES, DEVICE_CODE_GRANT_TYPE } from "./shared";

/** Claims the provider can emit from the scopes it supports. */
const CLAIMS_SUPPORTED = [
  "sub", "iss", "aud", "exp", "iat", "auth_time", "nonce", "at_hash", "azp", "sid",
  "name", "given_name", "family_name", "preferred_username", "picture", "locale", "updated_at",
  "email", "email_verified", "phone_number", "phone_number_verified", "groups",
  "org_id", "org_slug", "org_role", "org_permissions", "organizations",
];

export function discoveryDocument(ctx: AppContext, issuer = ctx.env.baseUrl) {
  const base = issuer.replace(/\/+$/, "");
  const settings = ctx.settings.get().oidcProvider;
  const jwtFormat = settings.accessTokenFormat === "jwt";
  const doc: Record<string, unknown> = {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    jwks_uri: `${base}/oauth/jwks`,
    revocation_endpoint: `${base}/oauth/revoke`,
    introspection_endpoint: `${base}/oauth/introspect`,
    end_session_endpoint: `${base}/oauth/end_session`,
    response_types_supported: ["code"],
    response_modes_supported: ["query", "form_post"],
    grant_types_supported: settings.deviceAuthorizationEnabled
      ? ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE]
      : ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: [...BASE_OIDC_SCOPES],
    claims_supported: CLAIMS_SUPPORTED,
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    introspection_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    prompt_values_supported: ["none", "login", "consent", "select_account"],
    request_parameter_supported: false,
    request_uri_parameter_supported: false,
    claims_parameter_supported: false,
    service_documentation: `${base}/docs`,
  };
  if (jwtFormat) {
    doc.access_token_format = "jwt";
    doc.access_token_signing_alg_values_supported = ["RS256"];
    doc.access_token_claims_supported = ["iss", "sub", "aud", "azp", "scope", "iat", "exp", "jti", "sid", "groups", "org_id", "org_slug", "org_role", "org_permissions"];
  }
  if (settings.deviceAuthorizationEnabled) {
    doc.device_authorization_endpoint = `${base}/oauth/device_authorization`;
  }
  return doc;
}
