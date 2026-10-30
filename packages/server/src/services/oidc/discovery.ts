// OIDC/OAuth2 provider service: applications, authorization codes, tokens, consent, device grant.
//
// Storage notes:
//  - codes/access/refresh tokens are random opaque strings; only sha256 hashes are stored in `oauth_grants`.
//  - `family_id` ties the access and refresh tokens of one authorization together (refresh rotation and reuse
//    detection); `session_id` keeps `sid` and the org claims tied to the authorizing session; `nonce` is the
//    OIDC nonce of an authorization code.
import { createHash, randomInt } from "node:crypto";
import { and, asc, count, desc, eq, gt, inArray } from "drizzle-orm";
import { createLocalJWKSet, jwtVerify } from "jose";
import { ErrorCodes, ID_PREFIX, OrbitError, type OAuthApplicationJSON } from "@orbitid/shared";
import type { AppContext } from "../../context";
import * as s from "../../db/schema";
import { randomToken, safeEqual, sha256 } from "../../lib/crypto";
import { newId } from "../../lib/ids";
import { getMembershipContext } from "../orgs";
import { getJwks, signJwt } from "../tokens";
import { first } from "../../lib/db";
import { BASE_OIDC_SCOPES, DEVICE_CODE_GRANT_TYPE } from "./shared";

export function discoveryDocument(ctx: AppContext) {
  const base = ctx.env.baseUrl;
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
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: settings.deviceAuthorizationEnabled
      ? ["authorization_code", "refresh_token", DEVICE_CODE_GRANT_TYPE]
      : ["authorization_code", "refresh_token"],
    subject_types_supported: ["public"],
    id_token_signing_alg_values_supported: ["RS256"],
    scopes_supported: [...BASE_OIDC_SCOPES],
    token_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post", "none"],
    revocation_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    introspection_endpoint_auth_methods_supported: ["client_secret_basic", "client_secret_post"],
    code_challenge_methods_supported: ["S256"],
    claims_supported: [
      "sub", "iss", "aud", "exp", "iat", "nonce", "name", "given_name", "family_name", "preferred_username", "picture",
      "email", "email_verified", "org_id", "org_slug", "org_role", "org_permissions", "organizations",
    ],
    prompt_values_supported: ["consent", "none"],
  };
  if (jwtFormat) {
    doc.access_token_format = "jwt";
    doc.access_token_signing_alg_values_supported = ["RS256"];
    doc.access_token_claims_supported = ["iss", "sub", "aud", "azp", "scope", "iat", "exp", "jti", "sid", "org_id", "org_slug", "org_role", "org_permissions"];
  }
  if (settings.deviceAuthorizationEnabled) {
    doc.device_authorization_endpoint = `${base}/oauth/device_authorization`;
  }
  return doc;
}
