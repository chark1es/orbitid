-- Baseline schema, byte-for-byte the tables, columns, constraints and indexes produced by
-- the TypeScript server's drizzle Postgres migrations 0000..0009.
-- DO NOT EDIT: a running TS deployment upgrades to this schema in place (see src/db/mod.rs).

-- >>> 0000_jazzy_shen.sql
CREATE TABLE "actor_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"actor" jsonb NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" bigint NOT NULL,
	"session_max_duration_seconds" bigint DEFAULT 1800 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "actor_tokens_token_hash_unique" UNIQUE("token_hash")
);


CREATE TABLE "allowlist_identifiers" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"identifier_type" text NOT NULL,
	"invitation_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "allowlist_identifiers_identifier_unique" UNIQUE("identifier")
);


CREATE TABLE "api_keys" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"subject" text NOT NULL,
	"prefix" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scopes" jsonb NOT NULL,
	"claims" jsonb,
	"revoked" boolean DEFAULT false NOT NULL,
	"revocation_reason" text,
	"expires_at" bigint,
	"last_used_at" bigint,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "api_keys_secret_hash_unique" UNIQUE("secret_hash")
);


CREATE TABLE "audit_logs" (
	"id" text PRIMARY KEY NOT NULL,
	"actor" text,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" text,
	"metadata" jsonb NOT NULL,
	"ip" text,
	"created_at" bigint NOT NULL
);


CREATE TABLE "blocklist_identifiers" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"identifier_type" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "blocklist_identifiers_identifier_unique" UNIQUE("identifier")
);


CREATE TABLE "clients" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"last_active_session_id" text,
	"ip" text,
	"user_agent" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "clients_token_hash_unique" UNIQUE("token_hash")
);


CREATE TABLE "email_addresses" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"email" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" bigint,
	"verified_strategy" text,
	"reserved" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "enterprise_connections" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"protocol" text NOT NULL,
	"provider" text DEFAULT 'custom' NOT NULL,
	"domains" jsonb NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"allow_subdomains" boolean DEFAULT false NOT NULL,
	"allow_idp_initiated" boolean DEFAULT false NOT NULL,
	"sync_user_attributes" boolean DEFAULT true NOT NULL,
	"disable_additional_identifications" boolean DEFAULT false NOT NULL,
	"config" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "external_accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"provider" text NOT NULL,
	"provider_user_id" text NOT NULL,
	"email_address" text DEFAULT '' NOT NULL,
	"first_name" text DEFAULT '' NOT NULL,
	"last_name" text DEFAULT '' NOT NULL,
	"username" text,
	"image_url" text,
	"approved_scopes" text DEFAULT '' NOT NULL,
	"access_token_enc" text,
	"refresh_token_enc" text,
	"token_expires_at" bigint,
	"public_metadata" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "instance" (
	"id" text PRIMARY KEY NOT NULL,
	"settings" jsonb NOT NULL,
	"secret_key_hash" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_hash" text NOT NULL,
	"redirect_url" text,
	"public_metadata" jsonb NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "invitations_token_hash_unique" UNIQUE("token_hash")
);


CREATE TABLE "jwt_templates" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"claims" jsonb NOT NULL,
	"lifetime" bigint DEFAULT 60 NOT NULL,
	"allowed_clock_skew" bigint DEFAULT 5 NOT NULL,
	"custom_signing_key" boolean DEFAULT false NOT NULL,
	"signing_algorithm" text DEFAULT 'RS256' NOT NULL,
	"signing_key_enc" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "jwt_templates_name_unique" UNIQUE("name")
);


CREATE TABLE "m2m_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"machine_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"claims" jsonb,
	"revoked" boolean DEFAULT false NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	CONSTRAINT "m2m_tokens_token_hash_unique" UNIQUE("token_hash")
);


CREATE TABLE "machines" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"secret_hash" text NOT NULL,
	"scoped_machines" jsonb NOT NULL,
	"default_token_ttl" bigint DEFAULT 3600 NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "machines_secret_hash_unique" UNIQUE("secret_hash")
);


CREATE TABLE "oauth_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret_hash" text,
	"is_public" boolean DEFAULT false NOT NULL,
	"redirect_uris" jsonb NOT NULL,
	"scopes" text DEFAULT 'openid profile email' NOT NULL,
	"consent_screen_enabled" boolean DEFAULT true NOT NULL,
	"pkce_required" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "oauth_applications_client_id_unique" UNIQUE("client_id")
);


CREATE TABLE "oauth_consents" (
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"scopes" text NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "oauth_consents_application_id_user_id_pk" PRIMARY KEY("application_id","user_id")
);


CREATE TABLE "oauth_grants" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"application_id" text NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"scopes" text NOT NULL,
	"redirect_uri" text,
	"code_challenge" text,
	"code_challenge_method" text,
	"nonce" text,
	"revoked" boolean DEFAULT false NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "oauth_grants_token_hash_unique" UNIQUE("token_hash")
);


CREATE TABLE "oauth_states" (
	"state" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"code_verifier" text,
	"nonce" text,
	"flow" jsonb NOT NULL,
	"expires_at" bigint NOT NULL
);


CREATE TABLE "organization_domains" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"name" text NOT NULL,
	"enrollment_mode" text DEFAULT 'manual_invitation' NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"affiliation_email_address" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "organization_invitations" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"email" text NOT NULL,
	"role_key" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"token_hash" text NOT NULL,
	"inviter_user_id" text,
	"redirect_url" text,
	"public_metadata" jsonb NOT NULL,
	"private_metadata" jsonb NOT NULL,
	"expires_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "organization_invitations_token_hash_unique" UNIQUE("token_hash")
);


CREATE TABLE "organization_membership_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "organization_memberships" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"user_id" text NOT NULL,
	"role_key" text NOT NULL,
	"public_metadata" jsonb NOT NULL,
	"private_metadata" jsonb NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "organizations" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"slug" text,
	"image_url" text,
	"has_image" boolean DEFAULT false NOT NULL,
	"max_allowed_memberships" bigint DEFAULT 5 NOT NULL,
	"admin_delete_enabled" boolean DEFAULT true NOT NULL,
	"public_metadata" jsonb NOT NULL,
	"private_metadata" jsonb NOT NULL,
	"created_by" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);


CREATE TABLE "passkeys" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"credential_id" text NOT NULL,
	"public_key" text NOT NULL,
	"counter" bigint DEFAULT 0 NOT NULL,
	"transports" jsonb,
	"device_type" text,
	"backed_up" boolean DEFAULT false NOT NULL,
	"last_used_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "passkeys_credential_id_unique" UNIQUE("credential_id")
);


CREATE TABLE "permissions" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"type" text DEFAULT 'user' NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "permissions_key_unique" UNIQUE("key")
);


CREATE TABLE "phone_numbers" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text,
	"phone" text NOT NULL,
	"verified" boolean DEFAULT false NOT NULL,
	"verified_at" bigint,
	"reserved_for_second_factor" boolean DEFAULT false NOT NULL,
	"default_second_factor" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "rate_limits" (
	"key" text PRIMARY KEY NOT NULL,
	"count" bigint NOT NULL,
	"reset_at" bigint NOT NULL
);


CREATE TABLE "role_permissions" (
	"role_id" text NOT NULL,
	"permission_id" text NOT NULL,
	CONSTRAINT "role_permissions_role_id_permission_id_pk" PRIMARY KEY("role_id","permission_id")
);


CREATE TABLE "roles" (
	"id" text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"is_creator_eligible" boolean DEFAULT false NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "roles_key_unique" UNIQUE("key")
);


CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"user_id" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"last_active_at" bigint NOT NULL,
	"last_active_organization_id" text,
	"expire_at" bigint NOT NULL,
	"abandon_at" bigint NOT NULL,
	"actor" jsonb,
	"first_factor_verified_at" bigint,
	"second_factor_verified_at" bigint,
	"ip" text,
	"user_agent" text,
	"city" text,
	"country" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "sign_in_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "sign_in_tokens_token_hash_unique" UNIQUE("token_hash")
);


CREATE TABLE "sign_ins" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"status" text NOT NULL,
	"identifier" text,
	"user_id" text,
	"state" jsonb NOT NULL,
	"created_session_id" text,
	"abandon_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "sign_ups" (
	"id" text PRIMARY KEY NOT NULL,
	"client_id" text NOT NULL,
	"status" text NOT NULL,
	"fields" jsonb NOT NULL,
	"unsafe_metadata" jsonb NOT NULL,
	"verifications" jsonb NOT NULL,
	"invitation_id" text,
	"org_invitation_id" text,
	"created_session_id" text,
	"created_user_id" text,
	"abandon_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "signing_keys" (
	"kid" text PRIMARY KEY NOT NULL,
	"alg" text NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_jwk_enc" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" bigint NOT NULL,
	"rotated_at" bigint
);


CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"external_id" text,
	"username" text,
	"username_lower" text,
	"first_name" text,
	"last_name" text,
	"image_url" text,
	"has_image" boolean DEFAULT false NOT NULL,
	"password_hash" text,
	"password_updated_at" bigint,
	"primary_email_address_id" text,
	"primary_phone_number_id" text,
	"public_metadata" jsonb NOT NULL,
	"private_metadata" jsonb NOT NULL,
	"unsafe_metadata" jsonb NOT NULL,
	"banned" boolean DEFAULT false NOT NULL,
	"locked" boolean DEFAULT false NOT NULL,
	"lockout_expires_at" bigint,
	"failed_attempts" bigint DEFAULT 0 NOT NULL,
	"totp_secret_enc" text,
	"totp_verified" boolean DEFAULT false NOT NULL,
	"backup_codes" jsonb,
	"delete_self_enabled" boolean DEFAULT true NOT NULL,
	"create_organization_enabled" boolean DEFAULT true NOT NULL,
	"create_organizations_limit" bigint,
	"legal_accepted_at" bigint,
	"last_sign_in_at" bigint,
	"last_active_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "users_external_id_unique" UNIQUE("external_id"),
	CONSTRAINT "users_username_lower_unique" UNIQUE("username_lower")
);


CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"strategy" text NOT NULL,
	"identifier" text NOT NULL,
	"owner_id" text NOT NULL,
	"code_hash" text,
	"token_hash" text,
	"attempts" bigint DEFAULT 0 NOT NULL,
	"max_attempts" bigint DEFAULT 5 NOT NULL,
	"redirect_url" text,
	"data" jsonb,
	"consumed_at" bigint,
	"verified_at" bigint,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL
);


CREATE TABLE "waitlist_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"invitation_id" text,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "waitlist_entries_email_unique" UNIQUE("email")
);


CREATE TABLE "webhook_deliveries" (
	"id" text PRIMARY KEY NOT NULL,
	"endpoint_id" text NOT NULL,
	"event_id" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempt" bigint DEFAULT 0 NOT NULL,
	"response_code" bigint,
	"response_body" text,
	"next_attempt_at" bigint,
	"created_at" bigint NOT NULL
);


CREATE TABLE "webhook_endpoints" (
	"id" text PRIMARY KEY NOT NULL,
	"url" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"event_types" jsonb NOT NULL,
	"secret" text NOT NULL,
	"disabled" boolean DEFAULT false NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL
);


CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"created_at" bigint NOT NULL
);


ALTER TABLE "actor_tokens" ADD CONSTRAINT "actor_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "email_addresses" ADD CONSTRAINT "email_addresses_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "external_accounts" ADD CONSTRAINT "external_accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "m2m_tokens" ADD CONSTRAINT "m2m_tokens_machine_id_machines_id_fk" FOREIGN KEY ("machine_id") REFERENCES "public"."machines"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_application_id_oauth_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."oauth_applications"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "oauth_consents" ADD CONSTRAINT "oauth_consents_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_application_id_oauth_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."oauth_applications"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "oauth_grants" ADD CONSTRAINT "oauth_grants_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "organization_domains" ADD CONSTRAINT "organization_domains_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "organization_invitations" ADD CONSTRAINT "organization_invitations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "organization_membership_requests" ADD CONSTRAINT "organization_membership_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "organization_membership_requests" ADD CONSTRAINT "organization_membership_requests_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "organization_memberships" ADD CONSTRAINT "organization_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "passkeys" ADD CONSTRAINT "passkeys_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "phone_numbers" ADD CONSTRAINT "phone_numbers_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fk" FOREIGN KEY ("role_id") REFERENCES "public"."roles"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_permissions_id_fk" FOREIGN KEY ("permission_id") REFERENCES "public"."permissions"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sign_in_tokens" ADD CONSTRAINT "sign_in_tokens_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sign_ins" ADD CONSTRAINT "sign_ins_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "sign_ups" ADD CONSTRAINT "sign_ups_client_id_clients_id_fk" FOREIGN KEY ("client_id") REFERENCES "public"."clients"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_endpoint_id_webhook_endpoints_id_fk" FOREIGN KEY ("endpoint_id") REFERENCES "public"."webhook_endpoints"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "webhook_deliveries" ADD CONSTRAINT "webhook_deliveries_event_id_webhook_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."webhook_events"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "ak_subject_idx" ON "api_keys" USING btree ("subject");

CREATE INDEX "audit_created_idx" ON "audit_logs" USING btree ("created_at");

CREATE UNIQUE INDEX "email_unique_verified" ON "email_addresses" USING btree ("email") WHERE "email_addresses"."verified" = true;

CREATE INDEX "email_user_idx" ON "email_addresses" USING btree ("user_id");

CREATE INDEX "email_addr_idx" ON "email_addresses" USING btree ("email");

CREATE UNIQUE INDEX "ext_provider_uid" ON "external_accounts" USING btree ("provider","provider_user_id");

CREATE INDEX "ext_user_idx" ON "external_accounts" USING btree ("user_id");

CREATE UNIQUE INDEX "od_org_name" ON "organization_domains" USING btree ("organization_id","name");

CREATE INDEX "oi_org_idx" ON "organization_invitations" USING btree ("organization_id");

CREATE INDEX "oi_email_idx" ON "organization_invitations" USING btree ("email");

CREATE UNIQUE INDEX "om_org_user" ON "organization_memberships" USING btree ("organization_id","user_id");

CREATE INDEX "om_user_idx" ON "organization_memberships" USING btree ("user_id");

CREATE UNIQUE INDEX "phone_unique_verified" ON "phone_numbers" USING btree ("phone") WHERE "phone_numbers"."verified" = true;

CREATE INDEX "phone_user_idx" ON "phone_numbers" USING btree ("user_id");

CREATE INDEX "sess_user_idx" ON "sessions" USING btree ("user_id");

CREATE INDEX "sess_client_idx" ON "sessions" USING btree ("client_id");

CREATE INDEX "ver_owner_idx" ON "verifications" USING btree ("owner_id","purpose");

CREATE INDEX "ver_token_idx" ON "verifications" USING btree ("token_hash");

CREATE INDEX "wd_due_idx" ON "webhook_deliveries" USING btree ("status","next_attempt_at");
-- >>> 0001_clumsy_vermin.sql
ALTER TABLE "sessions" ADD COLUMN "auth_method" text;
-- >>> 0002_military_screwball.sql
CREATE TABLE "device_codes" (
	"id" text PRIMARY KEY NOT NULL,
	"application_id" text NOT NULL,
	"device_code_hash" text NOT NULL,
	"user_code" text NOT NULL,
	"scopes" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"user_id" text,
	"interval_seconds" bigint DEFAULT 5 NOT NULL,
	"last_polled_at" bigint,
	"expires_at" bigint NOT NULL,
	"created_at" bigint NOT NULL,
	CONSTRAINT "device_codes_device_code_hash_unique" UNIQUE("device_code_hash"),
	CONSTRAINT "device_codes_user_code_unique" UNIQUE("user_code")
);


CREATE TABLE "trusted_devices" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"label" text,
	"user_agent" text,
	"ip_address" text,
	"expires_at" bigint NOT NULL,
	"last_used_at" bigint,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "trusted_devices_token_hash_unique" UNIQUE("token_hash")
);


ALTER TABLE "users" ADD COLUMN "is_anonymous" boolean DEFAULT false NOT NULL;

ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_application_id_oauth_applications_id_fk" FOREIGN KEY ("application_id") REFERENCES "public"."oauth_applications"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "device_codes" ADD CONSTRAINT "device_codes_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

ALTER TABLE "trusted_devices" ADD CONSTRAINT "trusted_devices_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "trusted_devices_user_idx" ON "trusted_devices" USING btree ("user_id");
-- >>> 0003_burly_komodo.sql
ALTER TABLE "oauth_grants" ADD COLUMN "family_id" text;

ALTER TABLE "oauth_grants" ADD COLUMN "session_id" text;

CREATE INDEX "oauth_grants_family_idx" ON "oauth_grants" USING btree ("family_id");

UPDATE "oauth_grants" SET "family_id" = "nonce", "nonce" = NULL WHERE "kind" IN ('access', 'refresh');
-- >>> 0004_operator_sessions.sql
CREATE TABLE "operator_sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token_hash" text NOT NULL,
	"key_fingerprint" text NOT NULL,
	"user_agent" text,
	"ip_address" text,
	"expires_at" bigint NOT NULL,
	"revoked_at" bigint,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "operator_sessions_token_hash_unique" UNIQUE("token_hash")
);


CREATE INDEX "operator_sessions_expires_idx" ON "operator_sessions" USING btree ("expires_at");
-- >>> 0005_user_roles.sql
CREATE TABLE "user_roles" (
	"user_id" text NOT NULL,
	"role_key" text NOT NULL,
	"created_at" bigint NOT NULL,
	"updated_at" bigint NOT NULL,
	CONSTRAINT "user_roles_user_id_role_key_pk" PRIMARY KEY("user_id","role_key")
);


ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;

CREATE INDEX "ur_role_idx" ON "user_roles" USING btree ("role_key");
-- >>> 0006_authorization_integrity.sql
DELETE FROM "user_roles" WHERE "role_key" NOT IN (SELECT "key" FROM "roles");


ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_key_roles_key_fk" FOREIGN KEY ("role_key") REFERENCES "public"."roles"("key") ON DELETE cascade ON UPDATE no action;

-- >>> 0007_same_amphibian.sql
ALTER TABLE "oauth_applications" ALTER COLUMN "pkce_required" SET DEFAULT false;

ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "post_logout_redirect_uris" jsonb DEFAULT '[]'::jsonb NOT NULL;

ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "access_token_lifetime_seconds" bigint DEFAULT 3600 NOT NULL;

ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "refresh_token_lifetime_seconds" bigint DEFAULT 2592000 NOT NULL;

ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "id_token_lifetime_seconds" bigint DEFAULT 3600 NOT NULL;

ALTER TABLE "oauth_applications" ADD COLUMN IF NOT EXISTS "groups_claim" text DEFAULT 'all' NOT NULL;
-- >>> 0008_clean_wiccan.sql
ALTER TABLE "clients" ADD COLUMN "token_issued_at" bigint;

ALTER TABLE "oauth_grants" ADD COLUMN "consumed_at" bigint;

ALTER TABLE "oauth_grants" ADD COLUMN "successor_id" text;
-- >>> 0009_next_silver_sable.sql
ALTER TABLE "oauth_grants" ADD COLUMN "successor_token_enc" text;

-- Scope allowlists are enforced from this release on. Existing applications effectively used every base scope
-- (the provider allowed them regardless of `scopes`), so keep their behaviour by recording those scopes explicitly.
-- Custom scopes already stored are preserved; duplicate entries are harmless (`parseScopes` dedupes).
UPDATE "oauth_applications" SET "scopes" = "scopes" || ' openid profile email phone groups organizations offline_access';
