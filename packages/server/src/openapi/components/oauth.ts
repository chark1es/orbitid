/**
 * OAuth/OIDC application, protocol, token, and enterprise connection schemas.
 */
import { timestamps } from "./shared";
import { arr, bool, enm, freeObject, int, lit, nullable, obj, opt, ref, str, type Schema } from "../schema";

export const oauthApplication: Schema = obj({
  object: lit("oauth_application"),
  id: str(),
  name: str(),
  client_id: str(),
  client_secret: opt(str({ description: "Returned on create and on secret rotation only." })),
  public: bool(),
  redirect_uris: arr(str({ format: "uri" })),
  scopes: str({ description: "Space separated scopes granted to the application." }),
  consent_screen_enabled: bool(),
  pkce_required: bool(),
  ...timestamps,
});

export const enterpriseConnection: Schema = obj({
  object: lit("enterprise_connection"),
  id: str(),
  name: str(),
  protocol: enm(["saml", "oidc"]),
  provider: str(),
  domains: arr(str()),
  active: bool(),
  allow_subdomains: bool(),
  allow_idp_initiated: bool(),
  sync_user_attributes: bool(),
  disable_additional_identifications: bool(),
  saml: opt(obj({
    idp_entity_id: str(),
    idp_sso_url: str(),
    idp_certificate: str(),
    acs_url: str(),
    sp_entity_id: str(),
    sp_metadata_url: str(),
    attribute_mapping: freeObject(),
  })),
  oidc: opt(obj({
    client_id: str(),
    discovery_url: str(),
    auth_url: opt(str()),
    token_url: opt(str()),
    user_info_url: opt(str()),
  })),
  ...timestamps,
});

export const auditLog: Schema = obj({
  object: lit("audit_log"),
  id: str(),
  actor: nullable(str()),
  action: str(),
  target_type: nullable(str()),
  target_id: nullable(str()),
  metadata: freeObject(),
  ip: nullable(str()),
  created_at: int(),
});

export const jwks: Schema = obj({
  keys: arr(obj(
    {
      kty: str(), kid: str(), use: opt(str()), alg: opt(str()), n: opt(str()), e: opt(str()), x: opt(str()), y: opt(str()), crv: opt(str()),
    },
    { description: "JSON Web Key. RSA keys carry `n`/`e`; EC keys carry `x`/`y`/`crv`." },
  )),
});

export const openIdConfiguration: Schema = obj({
  issuer: str(),
  authorization_endpoint: str(),
  token_endpoint: str(),
  userinfo_endpoint: str(),
  jwks_uri: str(),
  registration_endpoint: opt(str()),
  scopes_supported: arr(str()),
  response_types_supported: arr(str()),
  response_modes_supported: opt(arr(str())),
  grant_types_supported: arr(str()),
  subject_types_supported: arr(str()),
  id_token_signing_alg_values_supported: arr(str()),
  token_endpoint_auth_methods_supported: arr(str()),
  code_challenge_methods_supported: arr(str()),
  claims_supported: opt(arr(str())),
});

export const oauthError: Schema = obj({
  error: str({ example: "invalid_request" }),
  error_description: opt(str()),
});

export const oauthTokenResponse: Schema = obj({
  access_token: str(),
  token_type: lit("Bearer"),
  expires_in: int({ description: "Seconds until the access token expires." }),
  refresh_token: opt(str()),
  id_token: opt(str()),
  scope: str(),
});

export const oauthIntrospection: Schema = obj({
  active: bool(),
  scope: opt(str()),
  client_id: opt(str()),
  username: opt(str()),
  token_type: opt(str()),
  exp: opt(int({ description: "Epoch seconds." })),
  iat: opt(int({ description: "Epoch seconds." })),
  sub: opt(str()),
  aud: opt(str()),
  iss: opt(str()),
});

export const oauthApplicationList: Schema = obj({ data: arr(ref("OAuthApplication")), total_count: int() });

export const userInfo: Schema = obj({ sub: str() }, { description: "Claims for the user behind the access token: `sub`, and whichever of `email`, `email_verified`, `name`, `given_name`, `family_name`, `picture` the scopes allow.", additional: true });
