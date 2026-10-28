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
export const COOKIES = {
  session: "__session", client: "__client", clientUat: "__client_uat", handshake: "__orbit_handshake", devBrowser: "__orbit_db_jwt",
  /** Remembers a browser that may skip the second factor (`settings.session.trustedDevicesEnabled`). */
  trustedDevice: "__orbit_trusted",
} as const;
/** ID prefixes. */
export const ID_PREFIX = {
  user: "user", session: "sess", client: "client", signIn: "sia", signUp: "sua", email: "idn_e", phone: "idn_p", external: "eac", passkey: "pkey",
  org: "org", membership: "orgmem", invitation: "orginv", domain: "orgdmn", request: "orgmreq", role: "role", permission: "perm",
  appInvitation: "inv", waitlist: "wle", allow: "alid", block: "blid", jwtTemplate: "jtmpl", actorToken: "act", signInToken: "sit",
  webhook: "we", webhookEvent: "evt", delivery: "whd", apiKey: "ak", machine: "mch", m2mToken: "mt", oauthApp: "oa", oauthGrant: "oag", enterprise: "ent", audit: "aud", verification: "ver",
  trustedDevice: "tdev",
} as const;
