// Session JWT claims that belong to the server.
//
// Neither a JWT template nor `settings.session.customClaims` may set them: they say who the caller is and what
// the session may do. Kept in its own module (no imports) so the Backend API can enforce the list without
// depending on the token-signing service.
export const RESERVED_SESSION_CLAIMS: readonly string[] = [
  "iss", "sub", "sid", "iat", "nbf", "exp", "jti", "azp", "act", "sts", "fva", "anonymous",
  "org_id", "org_slug", "org_role", "org_permissions", "roles", "role_permissions",
];
