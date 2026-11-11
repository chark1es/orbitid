/** Publishable key format: `pk_(test|live)_<base64url(frontendApiUrl)>`; secret key: `sk_(test|live)_<random>`. */
export function encodePublishableKey(frontendApi: string, env: "test" | "live" = "test"): string {
  const b64 = btoa(frontendApi).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  return `pk_${env}_${b64}`;
}
export function decodePublishableKey(pk: string): { frontendApi: string; env: "test" | "live" } {
  const m = /^pk_(test|live)_([A-Za-z0-9_-]+)$/.exec(pk);
  if (!m) throw new Error("Invalid OrbitID publishable key");
  const b64 = m[2]!.replace(/-/g, "+").replace(/_/g, "/");
  return { frontendApi: atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)), env: m[1] as "test" | "live" };
}
export const isPublishableKey = (k: string) => /^pk_(test|live)_/.test(k);
export const isSecretKey = (k: string) => /^sk_(test|live)_/.test(k);

/** Cookie names. */
/**
 * Browsers cap a cookie's lifetime at 400 days. The browser-owned cookies (`__client`, `__session`,
 * `__client_uat`) use the cap and are rewritten on every use, so a browser that comes back after months is
 * still signed in instead of arriving with a cookie the browser already dropped.
 */
export const COOKIE_MAX_AGE_SECONDS = 400 * 24 * 60 * 60;

/**
 * `sessions.expire_at` for a session whose operator set no maximum lifetime (`session.lifetimeSeconds: 0`,
 * the default). A real date is still stored so sorting, stats and the dashboard keep working; no code path
 * ever compares it as "expired" while the policy says unlimited. Kept below `Number.MAX_SAFE_INTEGER` for
 * SQLite integers and Postgres `bigint` read as a JS number.
 */
export const SESSION_NEVER_EXPIRES_AT = 8_640_000_000_000_000;

export const COOKIES = {
  session: "__session", client: "__client", clientUat: "__client_uat", handshake: "__orbit_handshake", devBrowser: "__orbit_db_jwt",
  /** Remembers a browser that may skip the second factor (`settings.session.trustedDevicesEnabled`). */
  trustedDevice: "__orbit_trusted",
  /** Dashboard operator session, minted by exchanging the instance secret key. HttpOnly, `Path=/v1`, `SameSite=Strict`. */
  operator: "__orbit_operator",
} as const;
/** ID prefixes. */
export const ID_PREFIX = {
  user: "user", session: "sess", client: "client", signIn: "sia", signUp: "sua", email: "idn_e", phone: "idn_p", external: "eac", passkey: "pkey",
  org: "org", membership: "orgmem", invitation: "orginv", domain: "orgdmn", request: "orgmreq", role: "role", permission: "perm",
  appInvitation: "inv", waitlist: "wle", allow: "alid", block: "blid", jwtTemplate: "jtmpl", actorToken: "act", signInToken: "sit",
  webhook: "we", webhookEvent: "evt", delivery: "whd", apiKey: "ak", machine: "mch", m2mToken: "mt", oauthApp: "oa", oauthGrant: "oag", enterprise: "ent", audit: "aud", verification: "ver",
  trustedDevice: "tdev", operatorSession: "osess",
} as const;
