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

export type ApplicationRow = typeof s.oauthApplications.$inferSelect;
export type GrantRow = typeof s.oauthGrants.$inferSelect;
export type DeviceCodeRow = typeof s.deviceCodes.$inferSelect;

/** Scopes every application supports; per-app custom scopes are added on top. */
export const BASE_OIDC_SCOPES = ["openid", "profile", "email", "organizations", "offline_access"] as const;
export const SCOPE_DESCRIPTIONS: Record<string, string> = {
  openid: "Authenticate you and read your OrbitID user id",
  profile: "Read your name, username and profile picture",
  email: "Read your email address and whether it is verified",
  organizations: "Read the organizations you belong to and your role in them",
  offline_access: "Stay signed in after you leave (refresh token)",
};

/** RFC 8628 grant type. */
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;
export const AUTHORIZATION_CODE_TTL_SECONDS = 10 * 60;
export const ID_TOKEN_TTL_SECONDS = 60 * 60;

/** RFC 6749 error surfaced on OAuth endpoints (`{ error, error_description }`, not the OrbitID error envelope). */
export class OAuthError extends Error {
  constructor(public status: number, public error: string, description: string) {
    super(description);
    this.name = "OAuthError";
  }
}
