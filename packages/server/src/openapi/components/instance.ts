/**
 * Instance/environment, signing, testing, health, and OIDC discovery schemas.
 */
import { instanceSettingsSchema } from "@orbitid/shared";
import { arr, bool, enm, freeObject, int, lit, nullable, obj, str, type Schema } from "../schema";
import { fromZod } from "../from-zod";

export const environment: Schema = obj({
  object: lit("environment"),
  auth_config: obj({
    identification_requirements: arr(arr(str()), { description: "One entry per accepted identifier combination." }),
    first_factors: arr(str()),
    second_factors: arr(str()),
    single_session_mode: bool(),
    sign_up_mode: enm(["public", "restricted", "waitlist"]),
    legal_consent_required: bool(),
  }),
  user_settings: obj({
    attributes: freeObject({ description: "Per-attribute settings keyed by `email_address`, `password`, …" }),
    social: freeObject({ description: "Enabled social providers keyed by provider name." }),
    password_settings: obj({
      min_length: int(), max_length: int(), require_lowercase: bool(), require_uppercase: bool(),
      require_numbers: bool(), require_special_char: bool(),
    }),
    username_settings: obj({ min_length: int(), max_length: int() }),
    sign_up: obj({ mode: str(), progressive: bool() }),
    actions: obj({ delete_self: bool(), create_organization: bool() }),
    passkey_settings: obj({ allow_autofill: bool(), show_sign_in_button: bool() }),
  }),
  organization_settings: obj({
    enabled: bool(), max_allowed_memberships: int(), creation_enabled: bool(), domains_enabled: bool(),
    membership_requests_enabled: bool(), slug_enabled: bool(), force_organization_selection: bool(),
    creator_role: str(), default_role: str(), max_created_organizations_per_user: nullable(int()),
  }),
  display_config: obj({
    application_name: str(), logo_image_url: nullable(str()), home_url: str(), support_email: nullable(str()),
    terms_url: nullable(str()), privacy_url: nullable(str()), primary_color: str(), theme: str(), branded: bool(),
    captcha_enabled: bool(), captcha_provider: str(), captcha_site_key: str(),
  }),
});

export const instanceSettings: Schema = fromZod(instanceSettingsSchema);

/**
 * `GET /v1/instance` returns the settings tree inline with the instance identity fields. The tree is derived from
 * `instanceSettingsSchema` in `@orbitid/shared` so a new setting appears here without editing this file; secrets are
 * returned masked as `••••` with a sibling `<field>Set` boolean, which is why the object stays open.
 */
export const instance: Schema = obj(
  {
    object: lit("instance"),
    id: lit("default"),
    environment_type: enm(["production", "development"]),
    publishable_key: str(),
    database: obj({ dialect: enm(["postgres", "sqlite"]), driver: str(), label: str() }),
    ...((instanceSettings.properties as Record<string, Schema>) ?? {}),
  },
  {
    description:
      "Instance settings. Secret values (`smtpUrl`, `twilioAuthToken`, `captchaSecret`, social `clientSecret`) are " +
      "returned as `••••` together with a sibling `<field>Set` boolean; send the tree back without the masked values to " +
      "keep the stored secrets.",
    additional: true,
  },
);

export const instanceStats: Schema = obj({
  users_total: int(),
  users_active_7d: int(),
  sessions_active: int(),
  organizations_total: int(),
  signups_by_day: arr(obj({ date: str({ description: "UTC day, `YYYY-MM-DD`." }), count: int() })),
  signins_by_day: arr(obj({ date: str(), count: int() })),
  banned_users: int(),
  locked_users: int(),
  mfa_enabled_users: int(),
  top_social_providers: arr(obj({ provider: str(), count: int() })),
});

export const signingKey: Schema = obj({ object: lit("signing_key"), kid: str(), algorithm: str(), active: bool() });

export const testingToken: Schema = obj({ object: lit("testing_token"), token: str(), expires_at: int() });

export const totalCount: Schema = obj({ object: lit("total_count"), total_count: int() });

export const health: Schema = obj({
  status: lit("ok"),
  publishable_key: str(),
  database: enm(["postgres", "sqlite"]),
  database_driver: str(),
});
