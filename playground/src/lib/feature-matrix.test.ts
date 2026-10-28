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
});
