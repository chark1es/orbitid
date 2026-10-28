/** OAuth 2.0 / OpenID Connect provider, discovery documents and application management. */
import { arr, int, obj, opt, ref, str } from "../schema";
import { backendListParams, idPath, op, queryParam, type DocumentedOperation } from "../operation";
import * as body from "../requests";
import { ok } from "./common";

/** Browser endpoints answer with a `302` and a `Location` header, not a body. */
const redirect = (description: string) => ({
  success: {
    status: 302 as const,
    description,
    headers: { Location: { type: "string", description: "Where the browser goes next." } },
  },
});

export const oauthPaths: DocumentedOperation[] = [
  op("get", "/.well-known/openid-configuration", "OAuth/OIDC", "getOpenIdConfiguration", "Read the OIDC discovery document", {
    security: "none",
    description: "Issuer, endpoints and capabilities. Public; standard OIDC clients discover everything from here.",
    success: { status: 200, schema: ref("OpenIdConfiguration") },
    errors: [],
  }),
  op("get", "/.well-known/jwks.json", "Health", "getJwks", "Read the session signing keys", {
    security: "none",
    description: "Public JWKS used to verify session JWTs offline. Cache it; keys rotate with `POST /v1/instance/signing_keys/rotate`.",
    success: { status: 200, schema: ref("Jwks"), headers: { "cache-control": { type: "string" } } },
    errors: [],
  }),
  op("get", "/v1/jwks", "Health", "getJwksV1", "Read the session signing keys (legacy path)", {
    security: "none",
    description: "Alias of `/.well-known/jwks.json` kept for clients configured against `/v1/jwks`.",
    success: { status: 200, schema: ref("Jwks") },
    errors: [],
  }),
  op("get", "/oauth/jwks", "OAuth/OIDC", "getOAuthJwks", "Read the id_token signing keys", {
    security: "none",
    description: "JWKS advertised by the discovery document as `jwks_uri`.",
    success: { status: 200, schema: ref("Jwks") },
    errors: [],
  }),
  op("get", "/oauth/authorize", "OAuth/OIDC", "authorize", "Authorization endpoint", {
    security: "none",
    description:
      "Standard authorization code flow. PKCE (`S256`) is required for public clients. Without a session the browser is " +
      "sent to the app's sign-in page and brought back; with consent enabled the consent screen data comes from " +
      "`/oauth/consent_info`. Ends in a redirect carrying `code` and `state`, or `error` and `error_description`.",
    parameters: [
      queryParam("response_type", { type: "string", enum: ["code"] }, "Only `code` is supported."),
      queryParam("client_id", { type: "string" }),
      queryParam("redirect_uri", { type: "string" }, "Must match a registered redirect URI exactly."),
      queryParam("scope", { type: "string" }, "Space separated. `openid` is required for OIDC."),
      queryParam("state", { type: "string" }, "Returned unchanged in the redirect."),
      queryParam("code_challenge", { type: "string" }),
      queryParam("code_challenge_method", { type: "string", enum: ["S256", "plain"] }),
      queryParam("nonce", { type: "string" }, "Included in the id_token."),
      queryParam("prompt", { type: "string", enum: ["none", "consent", "login"] }),
    ],
    ...redirect("Redirect to the client's `redirect_uri` (302)."),
    errors: [400],
  }),
  op("get", "/oauth/consent_info", "OAuth/OIDC", "getConsentInfo", "Read consent screen data", {
    security: "frontend",
    description: "Application name, requested scopes and descriptions for the consent screen.",
    parameters: [queryParam("client_id", { type: "string" }), queryParam("scope", { type: "string" }), queryParam("redirect_url", { type: "string" })],
    success: {
      status: 200,
      schema: obj({
        application: obj({ id: str(), name: str(), client_id: str() }),
        scopes: arr(obj({ scope: str(), description: str() })),
        redirect_url: { type: ["string", "null"] },
      }),
    },
    errors: [400, 401, 404],
  }),
  op("post", "/oauth/consent", "OAuth/OIDC", "submitConsent", "Submit the consent decision", {
    security: "frontend",
    description: "Records the grant for this user and application and returns where to send the browser next.",
    body: { schema: body.oauthConsent },
    success: { status: 200, schema: obj({ redirect_url: str() }) },
    errors: [400, 401, 404, 422],
  }),
  op("post", "/oauth/token", "OAuth/OIDC", "token", "Token endpoint", {
    security: "none",
    description:
      "Exchanges an authorization code or a refresh token for an access token, and (with the `openid` scope) an " +
      "id_token. Confidential clients authenticate with HTTP Basic (`client_id:client_secret`) or with `client_id` and " +
      "`client_secret` in the body. Errors use the OAuth error shape, not the OrbitID error envelope.",
    body: { schema: body.oauthTokenRequest, contentType: "application/x-www-form-urlencoded" },
    success: { status: 200, schema: ref("OAuthTokenResponse") },
    errors: [400, 401],
    errorShape: "oauth",
  }),
  op("get", "/oauth/userinfo", "OAuth/OIDC", "getUserInfo", "Read user claims", {
    security: "oauth",
    description: "OIDC userinfo for the access token in `Authorization: Bearer` (or `?access_token=`).",
    success: { status: 200, schema: ref("UserInfo") },
    errors: [401],
    errorShape: "oauth",
  }),
  op("post", "/oauth/userinfo", "OAuth/OIDC", "postUserInfo", "Read user claims (POST)", {
    security: "oauth",
    description: "Same claims as the GET form, for clients that must not put tokens in a URL.",
    success: { status: 200, schema: ref("UserInfo") },
    errors: [401],
    errorShape: "oauth",
  }),
  op("post", "/oauth/device_authorization", "OAuth/OIDC", "startDeviceAuthorization", "Start a device authorization (RFC 8628)", {
    security: "none",
    description:
      "For a CLI or TV: returns a `device_code` to poll the token endpoint with (`grant_type=urn:ietf:params:oauth:grant-type:device_code`) and a " +
      "`user_code` to show. Confidential clients authenticate with their secret; public clients send `client_id` only. Disabled unless " +
      "`oidcProvider.deviceAuthorizationEnabled` is on.",
    body: { schema: obj({ client_id: str(), client_secret: opt(str()), scope: opt(str()) }), contentType: "application/x-www-form-urlencoded" },
    success: {
      status: 200,
      schema: obj({
        device_code: str(),
        user_code: str({ example: "ABCD-EFGH" }),
        verification_uri: str({ format: "uri" }),
        verification_uri_complete: str({ format: "uri" }),
        expires_in: int(),
        interval: int(),
      }),
    },
    errors: [401, 404, 429],
    errorShape: "oauth",
  }),
  op("get", "/oauth/device", "OAuth/OIDC", "deviceVerificationPage", "Device verification page", {
    security: "none",
    description: "A server-rendered page where the user types the code shown on the device and approves it. It signs the user in through the application's own sign-in page when needed.",
    parameters: [queryParam("user_code", str(), "Prefills the code box.")],
    success: { status: 200, schema: str(), contentType: "text/html" },
    errors: [404, 429],
  }),
  op("post", "/oauth/device", "OAuth/OIDC", "decideDeviceVerificationPage", "Submit the device verification form", {
    security: "frontendOptional",
    description: "Same-origin form post that approves or denies a code. Cross-site posts are refused.",
    body: { schema: obj({ user_code: str(), action: { type: "string", enum: ["approve", "deny"] } }), contentType: "application/x-www-form-urlencoded" },
    success: { status: 200, schema: str(), contentType: "text/html" },
    errors: [403, 404, 429],
  }),
  op("post", "/oauth/revoke", "OAuth/OIDC", "revokeToken", "Revoke a token", {
    security: "none",
    description: "RFC 7009. Answers 200 with an empty body whether or not the token existed.",
    body: { schema: body.oauthRevoke, contentType: "application/x-www-form-urlencoded" },
    success: { status: 200, schema: { type: "null" }, description: "Empty body." },
    errors: [400, 401],
    errorShape: "oauth",
  }),
  op("post", "/oauth/introspect", "OAuth/OIDC", "introspectToken", "Introspect a token", {
    security: "none",
    description: "RFC 7662. Returns `active: false` for unknown, expired or revoked tokens.",
    body: { schema: body.oauthIntrospect, contentType: "application/x-www-form-urlencoded" },
    success: { status: 200, schema: ref("OAuthIntrospection") },
    errors: [400, 401],
    errorShape: "oauth",
  }),
  op("post", "/oauth/m2m/token", "OAuth/OIDC", "machineClientCredentials", "Mint a machine token with client credentials", {
    security: "machineSecret",
    description:
      "`client_credentials` grant for a machine: `machine_id` + `machine_secret` (body or HTTP Basic). Equivalent to " +
      "`POST /v1/m2m/tokens` without the secret key, so a machine can mint its own tokens.",
    body: { schema: body.m2mOAuthToken, contentType: "application/x-www-form-urlencoded" },
    success: {
      status: 200,
      schema: obj({
        access_token: str(),
        token_type: { const: "Bearer" },
        expires_in: { type: "integer" },
        token_format: { type: "string", enum: ["opaque", "jwt"] },
        machine_token: ref("MachineToken"),
        scope: str(),
      }),
    },
    errors: [400, 401, 429],
    errorShape: "oauth",
  }),

  // ───────────── application management (Backend API) ─────────────
  op("get", "/v1/oauth_applications", "OAuth/OIDC", "listOAuthApplications", "List OAuth applications", {
    security: "backend",
    parameters: backendListParams,
    ...ok(ref("OAuthApplicationList")),
    errors: [429],
  }),
  op("post", "/v1/oauth_applications", "OAuth/OIDC", "createOAuthApplication", "Create an OAuth application", {
    security: "backend",
    description: "`client_secret` is returned once, in this response. Public clients get no secret and must use PKCE.",
    body: { schema: body.oauthApplicationCreate },
    success: { status: 201, schema: ref("OAuthApplication") },
    errors: [422],
  }),
  op("get", "/v1/oauth_applications/{id}", "OAuth/OIDC", "getOAuthApplication", "Read an OAuth application", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("OAuthApplication")),
    errors: [404],
  }),
  op("patch", "/v1/oauth_applications/{id}", "OAuth/OIDC", "updateOAuthApplication", "Update an OAuth application", {
    security: "backend",
    parameters: [idPath],
    body: { schema: body.oauthApplicationUpdate },
    ...ok(ref("OAuthApplication")),
    errors: [404, 422],
  }),
  op("delete", "/v1/oauth_applications/{id}", "OAuth/OIDC", "deleteOAuthApplication", "Delete an OAuth application", {
    security: "backend",
    description: "Revokes the client. Existing access tokens stop introspecting as active.",
    parameters: [idPath],
    ...ok(obj({ object: { const: "oauth_application" }, id: str(), deleted: { const: true } })),
    errors: [404],
  }),
  op("post", "/v1/oauth_applications/{id}/rotate_secret", "OAuth/OIDC", "rotateOAuthApplicationSecret", "Rotate the client secret", {
    security: "backend",
    description: "Returns the application with the new `client_secret`, once.",
    parameters: [idPath],
    ...ok(ref("OAuthApplication")),
    errors: [404],
  }),
];

export const ssoPaths: DocumentedOperation[] = [
  op("get", "/v1/enterprise_connections", "Enterprise SSO", "listEnterpriseConnections", "List enterprise connections", {
    security: "backend",
    description: "Filter with `protocol` (`saml`/`oidc`) and `active`.",
    parameters: [...backendListParams, queryParam("protocol", { type: "string", enum: ["saml", "oidc"] }), queryParam("active", { type: "boolean" })],
    success: { status: 200, schema: obj({ data: arr(ref("EnterpriseConnection")), total_count: { type: "integer" } }) },
    errors: [429],
  }),
  op("post", "/v1/enterprise_connections", "Enterprise SSO", "createEnterpriseConnection", "Create an enterprise connection", {
    security: "backend",
    description: "SAML connections need the IdP certificate and SSO URL; OIDC connections need a discovery URL and client credentials.",
    body: { schema: body.enterpriseConnectionCreate },
    success: { status: 201, schema: ref("EnterpriseConnection") },
    errors: [422],
  }),
  op("get", "/v1/enterprise_connections/{id}", "Enterprise SSO", "getEnterpriseConnection", "Read an enterprise connection", {
    security: "backend",
    parameters: [idPath],
    ...ok(ref("EnterpriseConnection")),
    errors: [404],
  }),
  op("patch", "/v1/enterprise_connections/{id}", "Enterprise SSO", "updateEnterpriseConnection", "Update an enterprise connection", {
    security: "backend",
    parameters: [idPath],
    body: { schema: body.enterpriseConnectionUpdate },
    ...ok(ref("EnterpriseConnection")),
    errors: [404, 422],
  }),
  op("delete", "/v1/enterprise_connections/{id}", "Enterprise SSO", "deleteEnterpriseConnection", "Delete an enterprise connection", {
    security: "backend",
    parameters: [idPath],
    ...ok(obj({ object: { const: "enterprise_connection" }, id: str(), deleted: { const: true } })),
    errors: [404],
  }),
  op("get", "/v1/saml/{id}/metadata", "Enterprise SSO", "getSamlMetadata", "Read the SAML service provider metadata", {
    security: "none",
    description: "XML metadata to upload to the identity provider: entity id, ACS URL and signing certificate.",
    parameters: [idPath],
    success: { status: 200, contentType: "application/xml", schema: str(), description: "SP metadata XML." },
    errors: [404],
  }),
  op("get", "/v1/saml/{id}/sso", "Enterprise SSO", "startSamlSso", "Start a SAML sign-in", {
    security: "none",
    description: "Redirects to the IdP with a signed AuthnRequest. `?flow=` resumes an existing flow instead of starting one.",
    parameters: [idPath, queryParam("flow", { type: "string" }, "Relay state of an existing flow.")],
    ...redirect("Redirect to the identity provider (302)."),
    errors: [400, 403, 404],
  }),
  op("post", "/v1/saml/{id}/acs", "Enterprise SSO", "samlAcs", "SAML assertion consumer service", {
    security: "none",
    description:
      "Receives the IdP's SAML response (`SAMLResponse` form field), validates the signature and audience, then creates " +
      "the session and redirects to the app. IdP-initiated responses are only accepted when the connection allows them.",
    parameters: [idPath],
    body: { schema: obj({ SAMLResponse: str(), RelayState: opt(str()) }), contentType: "application/x-www-form-urlencoded" },
    ...redirect("Redirect to the app (302)."),
    errors: [400, 403, 404],
  }),
];
