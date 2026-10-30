import type { EnvironmentJSON } from "@orbitid/shared";
import { type FeatureRow } from "./types";
import { attribute } from "./shared";

export function socialRows(env: EnvironmentJSON): FeatureRow[] {
  const social = env.user_settings?.social ?? {};
  const rows = Object.entries(social)
    .filter(([, config]) => config.enabled)
    .map(([key, config]) => {
      const strategy = config.strategy || `oauth_${key}`;
      return {
        id: `social.${key}`,
        label: config.name || key,
        status: "enabled" as const,
        value: config.authenticatable ? "Offered at sign-in and sign-up" : "Offered at sign-up only",
        detail: `Strategy ${strategy}. Client credentials are set on the instance.`,
        tryHref: "/sign-in",
        strategy,
      };
    });
  if (rows.length) return rows;
  return [
    {
      id: "social.none",
      label: "Social providers",
      status: "off",
      value: "None configured",
      detail: "Add a provider's client ID and secret in the dashboard to enable a Continue with button.",
      tryHref: "/sign-in",
    },
  ];
}

export function signUpRows(env: EnvironmentJSON): FeatureRow[] {
  const mode = env.auth_config?.sign_up_mode ?? "public";
  const detail =
    mode === "public"
      ? "Anyone with a valid identifier can create an account."
      : mode === "restricted"
        ? "Only allowlisted identifiers can sign up. Add them in the dashboard."
        : "New users join the waitlist and wait for an invitation.";
  const rows: FeatureRow[] = [
    {
      id: "signUp.mode",
      label: "Sign-up mode",
      status: mode === "restricted" ? "needs-config" : "enabled",
      value: mode.charAt(0).toUpperCase() + mode.slice(1),
      detail,
      tryHref: mode === "waitlist" ? "/waitlist" : "/sign-up",
    },
    {
      id: "signUp.legalConsent",
      label: "Legal consent",
      status: env.auth_config?.legal_consent_required ? "enabled" : "off",
      value: env.auth_config?.legal_consent_required ? "Required at sign-up" : "Not required",
      tryHref: "/sign-up",
    },
  ];
  if (env.user_settings?.sign_up?.progressive) {
    rows.push({
      id: "signUp.progressive",
      label: "Progressive sign-up",
      status: "enabled",
      value: "Users can add missing fields later",
      tryHref: "/sign-up",
    });
  }
  return rows;
}

export function passwordRows(env: EnvironmentJSON): FeatureRow[] {
  const attr = attribute(env, "password");
  const policy = env.user_settings?.password_settings;
  const enabled = Boolean(attr?.enabled);
  const requirements = policy
    ? [
        policy.require_lowercase ? "lowercase" : null,
        policy.require_uppercase ? "uppercase" : null,
        policy.require_numbers ? "number" : null,
        policy.require_special_char ? "symbol" : null,
      ].filter(Boolean)
    : [];
  return [
    {
      id: "password.policy",
      label: "Password",
      status: enabled ? "enabled" : "off",
      value: enabled && policy ? `${policy.min_length} to ${policy.max_length} characters` : "Not offered",
      detail: policy
        ? requirements.length
          ? `Requires ${requirements.join(", ")}.`
          : "No character requirements beyond the length."
        : undefined,
      tryHref: "/sign-up",
    },
  ];
}

export function passkeyRows(env: EnvironmentJSON): FeatureRow[] {
  const attr = attribute(env, "passkey");
  const settings = env.user_settings?.passkey_settings;
  return [
    {
      id: "passkey.enabled",
      label: "Passkeys",
      status: attr?.enabled ? "enabled" : "off",
      value: attr?.enabled ? "Registration and sign-in available" : "Not offered",
      detail:
        attr?.enabled && settings
          ? `${settings.show_sign_in_button ? "Shown" : "Hidden"} on the sign-in form, ${settings.allow_autofill ? "autofill allowed" : "autofill off"}.`
          : "Turn on passkeys in the dashboard to offer WebAuthn.",
      tryHref: "/account",
    },
  ];
}
