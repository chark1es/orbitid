import type { AuthMethod } from "@orbitid/shared";

/** Maps a sign-in or verification strategy name to the method shown in the dashboard. */
export function authMethodOf(strategy: string | null | undefined): AuthMethod | null {
  if (!strategy) return null;
  if (strategy.startsWith("oauth_")) return "oauth";
  if (strategy.startsWith("reset_password")) return "password";
  switch (strategy) {
    case "password": case "email_code": case "email_link": case "passkey": case "ticket": return strategy;
    case "phone_code": return "sms";
    case "enterprise_sso": case "saml": return "sso";
    default: return null;
  }
}
