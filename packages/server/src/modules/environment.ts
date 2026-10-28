// GET /v1/client/environment
import { Hono } from "hono";
import type { EnvironmentJSON, InstanceSettings } from "@orbitid/shared";
import type { AppContext } from "../context";
import { listEnabledSocialProviders } from "../services/oauth-providers";

const attributeJSON = (a: InstanceSettings["attributes"]["emailAddress"]) => ({
  enabled: a.enabled,
  required: a.required,
  used_for_first_factor: a.usedForFirstFactor,
  used_for_second_factor: a.usedForSecondFactor,
  verifications: a.verifications,
  verify_at_sign_up: a.verifyAtSignUp,
});

/** Public, secret-free environment projection used to render every UI component. */
export function buildEnvironment(ctx: AppContext): EnvironmentJSON {
  const st = ctx.settings.get();
  const social = listEnabledSocialProviders(ctx);
  const enabledSocial = Object.fromEntries(social.map((p) => [p.key, {
    enabled: true,
    name: p.name,
    strategy: p.strategy,
    authenticatable: p.authenticatable,
    logo_url: p.logo_url,
  }]));

  const firstFactors: string[] = [];
  if (st.attributes.emailAddress.enabled && st.attributes.emailAddress.usedForFirstFactor) {
    firstFactors.push("email_code");
    const verifications = st.attributes.emailAddress.verifications;
    if (!verifications.length || verifications.includes("email_link") || verifications.includes("email_code")) firstFactors.push("email_link");
  }
  if (st.attributes.password.enabled && st.attributes.password.usedForFirstFactor) firstFactors.push("password");
  if (st.attributes.phoneNumber.enabled && st.attributes.phoneNumber.usedForFirstFactor) firstFactors.push("phone_code");
  if (st.attributes.passkey.enabled) firstFactors.push("passkey");
  for (const p of social) firstFactors.push(p.strategy);

  const secondFactors: string[] = [];
  if (st.attributes.authenticatorApp.enabled) secondFactors.push("totp");
  if (st.attributes.phoneNumber.enabled && st.attributes.phoneNumber.usedForSecondFactor) secondFactors.push("phone_code");
  if (st.attributes.backupCode.enabled) secondFactors.push("backup_code");

  const identification: string[] = [];
  if (st.attributes.emailAddress.enabled && st.attributes.emailAddress.usedForFirstFactor) identification.push("email_address");
  if (st.attributes.phoneNumber.enabled && st.attributes.phoneNumber.usedForFirstFactor) identification.push("phone_number");
  if (st.attributes.username.enabled && st.attributes.username.usedForFirstFactor) identification.push("username");
  if (st.attributes.password.enabled) identification.push("password");
  if (st.attributes.passkey.enabled) identification.push("passkey");
  for (const p of social) identification.push(p.strategy);

  return {
    object: "environment",
    auth_config: {
      identification_requirements: identification.length ? [identification] : [],
      first_factors: firstFactors,
      second_factors: secondFactors,
      single_session_mode: !st.session.multiSession,
      sign_up_mode: st.signUp.mode,
      legal_consent_required: st.signUp.legalConsentRequired,
    },
    user_settings: {
      attributes: {
        email_address: attributeJSON(st.attributes.emailAddress),
        phone_number: attributeJSON(st.attributes.phoneNumber),
        username: attributeJSON(st.attributes.username),
        first_name: attributeJSON(st.attributes.firstName),
        last_name: attributeJSON(st.attributes.lastName),
        password: attributeJSON(st.attributes.password),
        passkey: attributeJSON(st.attributes.passkey),
        backup_code: attributeJSON(st.attributes.backupCode),
        authenticator_app: attributeJSON(st.attributes.authenticatorApp),
      },
      social: enabledSocial,
      password_settings: {
        min_length: st.password.minLength,
        max_length: st.password.maxLength,
        require_lowercase: st.password.requireLowercase,
        require_uppercase: st.password.requireUppercase,
        require_numbers: st.password.requireNumbers,
        require_special_char: st.password.requireSpecialCharacter,
      },
      username_settings: { min_length: st.username.minLength, max_length: st.username.maxLength },
      sign_up: { mode: st.signUp.mode, progressive: st.signUp.progressive },
      actions: { delete_self: st.userSettings.deleteSelfEnabled, create_organization: st.userSettings.createOrganizationEnabled && st.organizations.enabled && st.organizations.creationEnabled },
      passkey_settings: { allow_autofill: true, show_sign_in_button: true },
    },
    organization_settings: {
      enabled: st.organizations.enabled,
      max_allowed_memberships: st.organizations.maxAllowedMemberships,
      creation_enabled: st.organizations.enabled && st.organizations.creationEnabled,
      domains_enabled: st.organizations.domainsEnabled,
      membership_requests_enabled: st.organizations.membershipRequestsEnabled,
      slug_enabled: st.organizations.slugEnabled,
      force_organization_selection: st.organizations.forceOrganizationSelection,
      creator_role: st.organizations.creatorRole,
      default_role: st.organizations.defaultRole,
    },
    display_config: {
      application_name: st.application.name,
      logo_image_url: st.application.logoUrl,
      home_url: st.application.homeUrl,
      support_email: st.application.supportEmail,
      terms_url: st.application.termsUrl,
      privacy_url: st.application.privacyUrl,
      primary_color: st.branding.primaryColor,
      theme: st.branding.theme,
      branded: st.branding.showPoweredBy,
      captcha_enabled: st.security.captchaProvider !== "none" && !!st.security.captchaSecret,
      captcha_provider: st.security.captchaProvider,
      captcha_site_key: st.security.captchaSiteKey,
    },
  };
}

export default function routes(ctx: AppContext) {
  const app = new Hono();
  app.get("/", (c) => {
    c.header("Cache-Control", "public, max-age=60");
    return c.json(buildEnvironment(ctx));
  });
  return app;
}
