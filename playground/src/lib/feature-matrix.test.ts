import { describe, expect, it } from "vitest";
import {
  buildFeatureMatrix,
  countFeatureStatuses,
  findFeatureRow,
  STATUS_LABEL,
} from "./feature-matrix";
import { environmentFixture } from "./__fixtures__/environment";

describe("buildFeatureMatrix", () => {
  const sections = buildFeatureMatrix(environmentFixture);

  it("covers every section the setup page shows", () => {
    expect(sections.map((section) => section.id)).toEqual([
      "identifiers",
      "first-factors",
      "second-factors",
      "social",
      "sign-up",
      "password",
      "passkeys",
      "organizations",
      "session",
      "trusted-devices",
      "guests",
      "email",
      "oidc",
      "handshake",
      "branding",
      "captcha",
    ]);
  });

  it("describes identifiers with required and verification state", () => {
    expect(findFeatureRow(sections, "identifier.email_address")).toMatchObject({
      status: "enabled",
      value: "Required, verified at sign-up",
      tryHref: "/sign-up",
    });
    expect(findFeatureRow(sections, "identifier.email_address")?.detail).toBe(
      "Verification: email code, email link.",
    );
    expect(findFeatureRow(sections, "identifier.phone_number")).toMatchObject({
      status: "enabled",
      value: "Optional, no verification at sign-up",
    });
    expect(findFeatureRow(sections, "identifier.username")).toMatchObject({
      status: "off",
      value: "Not collected",
    });
  });

  it("marks offered first factors on and absent ones off", () => {
    expect(findFeatureRow(sections, "firstFactor.password")?.status).toBe("enabled");
    expect(findFeatureRow(sections, "firstFactor.phone_code")?.status).toBe("off");
    expect(findFeatureRow(sections, "firstFactor.phone_code")?.value).toBe("Not offered");
  });

  it("treats enterprise SSO without a connection as needs config", () => {
    expect(findFeatureRow(sections, "firstFactor.enterprise_sso")).toMatchObject({
      status: "needs-config",
      value: "No connection",
    });
  });

  it("lists only enabled social providers and keeps their strategy", () => {
    const social = sections.find((section) => section.id === "social");
    expect(social?.rows.map((row) => row.id)).toEqual(["social.google", "social.github"]);
    expect(findFeatureRow(sections, "social.google")?.strategy).toBe("oauth_google");
    expect(findFeatureRow(sections, "social.github")?.label).toBe("GitHub");
  });

  it("falls back to a single off row when no provider is configured", () => {
    const empty = buildFeatureMatrix({
      ...environmentFixture,
      user_settings: { ...environmentFixture.user_settings, social: {} },
    });
    expect(findFeatureRow(empty, "social.none")).toMatchObject({ status: "off", tryHref: "/sign-in" });
  });

  it("sends a waitlist instance to the waitlist page", () => {
    expect(findFeatureRow(sections, "signUp.mode")).toMatchObject({
      status: "enabled",
      value: "Waitlist",
      tryHref: "/waitlist",
    });
    expect(findFeatureRow(sections, "signUp.legalConsent")?.status).toBe("enabled");
  });

  it("marks restricted sign-up as needing allowlist configuration", () => {
    const restricted = buildFeatureMatrix({
      ...environmentFixture,
      auth_config: { ...environmentFixture.auth_config, sign_up_mode: "restricted" },
    });
    expect(findFeatureRow(restricted, "signUp.mode")).toMatchObject({
      status: "needs-config",
      tryHref: "/sign-up",
    });
  });

  it("summarises the password policy", () => {
    expect(findFeatureRow(sections, "password.policy")).toMatchObject({
      status: "enabled",
      value: "8 to 72 characters",
      detail: "Requires number.",
    });
  });

  it("reports organization features from the environment", () => {
    expect(findFeatureRow(sections, "organizations.enabled")?.detail).toBe("3 memberships per user.");
    expect(findFeatureRow(sections, "organizations.domains")?.status).toBe("off");
    expect(findFeatureRow(sections, "organizations.requests")?.status).toBe("enabled");
    expect(findFeatureRow(sections, "organizations.roles")?.value).toBe(
      "Creator org:admin, new members org:member",
    );
  });

  it("marks session lifetime as needing the secret key when settings are absent", () => {
    expect(findFeatureRow(sections, "session.lifetime")).toMatchObject({
      status: "needs-config",
      value: "Not exposed by the public environment",
    });
    expect(findFeatureRow(sections, "session.mode")?.value).toBe("Multiple sessions allowed");
  });

  it("reads session lifetime and MFA from the instance snapshot when present", () => {
    const enriched = buildFeatureMatrix(environmentFixture, {
      session: { lifetimeSeconds: 604800, tokenLifetimeSeconds: 60 },
      mfa: { required: true },
    });
    expect(findFeatureRow(enriched, "session.lifetime")).toMatchObject({
      status: "enabled",
      value: "7 days",
      detail: "Session tokens last 1 minute and refresh automatically.",
    });
    expect(findFeatureRow(enriched, "session.mfaRequired")?.status).toBe("enabled");
  });

  it("reports branding and captcha from the display config", () => {
    expect(findFeatureRow(sections, "branding.application")?.value).toBe("Test instance");
    expect(findFeatureRow(sections, "captcha.enabled")).toMatchObject({
      status: "enabled",
      value: "Cloudflare Turnstile",
    });
  });

  it("gives every row a path to the page that exercises it", () => {
    for (const section of sections) {
      expect(section.rows.length).toBeGreaterThan(0);
      for (const row of section.rows) {
        expect(row.tryHref.startsWith("/")).toBe(true);
        expect(STATUS_LABEL[row.status]).toBeTruthy();
      }
    }
  });

  it("counts statuses across all rows", () => {
    const counts = countFeatureStatuses(sections);
    const total = sections.reduce((sum, section) => sum + section.rows.length, 0);
    expect(counts.enabled + counts.off + counts["needs-config"]).toBe(total);
    expect(counts.enabled).toBeGreaterThan(0);
    expect(counts.off).toBeGreaterThan(0);
  });

  it("lists the new server features without the secret key, marking the unreadable ones", () => {
    const secretRows = ["email.transport", "oidc.deviceFlow", "oidc.accessTokens"];
    for (const id of secretRows) {
      expect(findFeatureRow(sections, id)).toMatchObject({
        status: "needs-config",
        value: "Not exposed by the public environment",
      });
      expect(findFeatureRow(sections, id)?.detail).toContain("ORBITID_SECRET_KEY");
    }
    // These two come from the public environment alone.
    expect(findFeatureRow(sections, "trustedDevices.enabled")).toMatchObject({
      status: "enabled",
      value: "Remembered for 30 days",
      tryHref: "/account",
    });
    expect(findFeatureRow(sections, "anonymous.enabled")).toMatchObject({
      status: "enabled",
      tryHref: "/guest",
    });
    expect(findFeatureRow(sections, "handshake.enabled")).toMatchObject({
      status: "enabled",
      value: "GET /v1/client/handshake",
      tryHref: "/api-lab",
    });
  });

  it("reports email code as a second factor from the public environment", () => {
    const withoutEmail = buildFeatureMatrix({
      ...environmentFixture,
      auth_config: { ...environmentFixture.auth_config, second_factors: ["totp", "backup_code"] },
    });
    expect(findFeatureRow(sections, "secondFactor.email_code")).toMatchObject({
      status: "off",
      value: "Not offered",
      tryHref: "/account",
    });
    expect(findFeatureRow(withoutEmail, "email.secondFactor")).toMatchObject({
      status: "off",
      value: "Not offered",
    });
    const withEmail = buildFeatureMatrix({
      ...environmentFixture,
      auth_config: { ...environmentFixture.auth_config, second_factors: ["totp", "email_code"] },
    });
    expect(findFeatureRow(withEmail, "email.secondFactor")).toMatchObject({
      status: "enabled",
      value: "Offered after the first factor",
    });
  });

  it("reads the mail transport from the instance snapshot and never prints a secret", () => {
    const resend = buildFeatureMatrix(environmentFixture, {
      email: { provider: "auto", resendApiKeySet: true, smtpUrlSet: true },
    });
    const transport = findFeatureRow(resend, "email.transport");
    expect(transport).toMatchObject({ status: "enabled", value: "Resend" });
    expect(transport?.detail).toContain("Inferred from the stored credentials");

    const smtp = buildFeatureMatrix(environmentFixture, {
      email: { provider: "auto", resendApiKeySet: false, smtpUrlSet: true },
    });
    expect(findFeatureRow(smtp, "email.transport")).toMatchObject({ status: "enabled", value: "SMTP" });

    const consoleTransport = buildFeatureMatrix(environmentFixture, {
      email: { provider: "auto", resendApiKeySet: false, smtpUrlSet: false },
    });
    expect(findFeatureRow(consoleTransport, "email.transport")).toMatchObject({
      status: "off",
      value: "Print to server log",
    });

    const explicit = buildFeatureMatrix(environmentFixture, {
      email: { provider: "resend", resendApiKeySet: false, smtpUrlSet: true },
    });
    expect(findFeatureRow(explicit, "email.transport")).toMatchObject({
      status: "needs-config",
      value: "Resend",
    });
    expect(findFeatureRow(explicit, "email.transport")?.detail).toContain("Sending fails until an API key");
    expect(JSON.stringify(explicit)).not.toContain("re_");
  });

  it("reports guest retention, device flow and JWT tokens from the instance snapshot", () => {
    const enriched = buildFeatureMatrix(environmentFixture, {
      anonymous: { enabled: true, retentionSeconds: 2_592_000 },
      oidcProvider: {
        accessTokenFormat: "jwt",
        deviceAuthorizationEnabled: true,
        deviceCodeLifetimeSeconds: 600,
        deviceCodeIntervalSeconds: 5,
      },
    });
    expect(findFeatureRow(enriched, "anonymous.enabled")?.detail).toBe(
      "Guests with no activity for 30 days are deleted.",
    );
    expect(findFeatureRow(enriched, "oidc.deviceFlow")).toMatchObject({
      status: "enabled",
      tryHref: "/device",
    });
    expect(findFeatureRow(enriched, "oidc.deviceFlow")?.detail).toContain("one poll every 5 seconds");
    expect(findFeatureRow(enriched, "oidc.accessTokens")).toMatchObject({ status: "enabled" });

    const indefinite = buildFeatureMatrix(environmentFixture, { anonymous: { enabled: true, retentionSeconds: 0 } });
    expect(findFeatureRow(indefinite, "anonymous.enabled")?.detail).toBe(
      "Guest accounts are kept indefinitely; cleanup is off.",
    );

    const off = buildFeatureMatrix(environmentFixture, {
      anonymous: { enabled: true, retentionSeconds: 86_400 },
      oidcProvider: { accessTokenFormat: "opaque", deviceAuthorizationEnabled: false, deviceCodeIntervalSeconds: 5 },
    });
    expect(findFeatureRow(off, "oidc.deviceFlow")).toMatchObject({ status: "off", value: "Endpoints answer 404" });
    expect(findFeatureRow(off, "oidc.accessTokens")?.value).toBe("Opaque tokens, checked at userinfo");
  });

  it("explains trusted devices that are switched off", () => {
    const off = buildFeatureMatrix({
      ...environmentFixture,
      auth_config: { ...environmentFixture.auth_config, trusted_devices: { enabled: false, days: 30 } },
    });
    expect(findFeatureRow(off, "trustedDevices.enabled")).toMatchObject({
      status: "off",
      value: "Remembered browsers are not offered",
    });
  });
});
