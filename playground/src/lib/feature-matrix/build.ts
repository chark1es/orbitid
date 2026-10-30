import type { EnvironmentJSON } from "@orbitid/shared";
import { type FeatureStatus, type FeatureRow, type FeatureSection, type InstanceSnapshot } from "./types";
import {
  IDENTIFIERS,
  FIRST_FACTORS,
  SECOND_FACTORS,
  attribute,
  enabledWords,
  verificationDetail,
} from "./shared";
import { socialRows, signUpRows, passwordRows, passkeyRows } from "./rows-auth";
import {
  organizationRows,
  sessionRows,
  brandingRows,
  captchaRows,
  emailRows,
  trustedDeviceRows,
  anonymousRows,
  oidcRows,
  handshakeRows,
} from "./rows-platform";

/** Builds every row the setup page shows from the instance's public environment plus optional settings. */
export function buildFeatureMatrix(env: EnvironmentJSON, instance?: InstanceSnapshot): FeatureSection[] {
  const identifiers: FeatureRow[] = IDENTIFIERS.map(({ key, label }) => {
    const attr = attribute(env, key);
    return {
      id: `identifier.${key}`,
      label,
      status: attr?.enabled ? "enabled" : "off",
      value: attr?.enabled ? enabledWords(attr) : "Not collected",
      detail: attr?.enabled ? verificationDetail(attr) : undefined,
      tryHref: "/sign-up",
    };
  });

  const firstFactors: FeatureRow[] = FIRST_FACTORS.map(({ factor, label, value, detail }) => {
    const on = (env.auth_config?.first_factors ?? []).includes(factor);
    return {
      id: `firstFactor.${factor}`,
      label,
      status: on ? "enabled" : factor === "enterprise_sso" ? "needs-config" : "off",
      value: on ? value : factor === "enterprise_sso" ? "No connection" : "Not offered",
      detail: on ? detail : factor === "enterprise_sso" ? detail : "Turn it on in the dashboard under User and authentication.",
      tryHref: "/sign-in",
    };
  });

  const secondFactors: FeatureRow[] = SECOND_FACTORS.map(({ factor, label, value, detail }) => {
    const on = (env.auth_config?.second_factors ?? []).includes(factor);
    return {
      id: `secondFactor.${factor}`,
      label,
      status: on ? "enabled" : "off",
      value: on ? value : "Not offered",
      detail: on ? detail : "Turn it on in the dashboard under User and authentication.",
      tryHref: "/account",
    };
  });

  return [
    {
      id: "identifiers",
      title: "Identifiers",
      hint: "What the instance collects at sign-up.",
      rows: identifiers,
    },
    {
      id: "first-factors",
      title: "First factors",
      hint: "Ways a user can prove who they are.",
      rows: firstFactors,
    },
    {
      id: "second-factors",
      title: "Second factors",
      hint: "Additional checks after the first factor.",
      rows: secondFactors,
    },
    {
      id: "social",
      title: "Social providers",
      hint: "Providers with client credentials on the instance.",
      rows: socialRows(env),
    },
    {
      id: "sign-up",
      title: "Sign-up",
      rows: signUpRows(env),
    },
    {
      id: "password",
      title: "Password policy",
      rows: passwordRows(env),
    },
    {
      id: "passkeys",
      title: "Passkeys",
      rows: passkeyRows(env),
    },
    {
      id: "organizations",
      title: "Organizations",
      rows: organizationRows(env),
    },
    {
      id: "session",
      title: "Sessions",
      rows: sessionRows(env, instance),
    },
    {
      id: "trusted-devices",
      title: "Trusted devices",
      hint: "Browsers that may skip the second factor.",
      rows: trustedDeviceRows(env),
    },
    {
      id: "guests",
      title: "Guest accounts",
      hint: "Accounts with no identifier yet.",
      rows: anonymousRows(env, instance),
    },
    {
      id: "email",
      title: "Email",
      hint: "How codes and links leave the server.",
      rows: emailRows(env, instance),
    },
    {
      id: "oidc",
      title: "OIDC provider",
      hint: "How OrbitID issues tokens to your applications.",
      rows: oidcRows(instance),
    },
    {
      id: "handshake",
      title: "Handshake",
      hint: "How a hard navigation finds a live session.",
      rows: handshakeRows(env),
    },
    {
      id: "branding",
      title: "Branding",
      rows: brandingRows(env),
    },
    {
      id: "captcha",
      title: "Captcha",
      rows: captchaRows(env),
    },
  ];
}

export function findFeatureRow(sections: FeatureSection[], id: string): FeatureRow | undefined {
  for (const section of sections) {
    const row = section.rows.find((item) => item.id === id);
    if (row) return row;
  }
  return undefined;
}

export function countFeatureStatuses(sections: FeatureSection[]): Record<FeatureStatus, number> {
  const counts: Record<FeatureStatus, number> = { enabled: 0, off: 0, "needs-config": 0 };
  for (const section of sections) {
    for (const row of section.rows) counts[row.status] += 1;
  }
  return counts;
}
