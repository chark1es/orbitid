CREATE TABLE `actor_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`actor` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`session_max_duration_seconds` integer DEFAULT 1800 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `actor_tokens_token_hash_unique` ON `actor_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `allowlist_identifiers` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`identifier_type` text NOT NULL,
	`invitation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `allowlist_identifiers_identifier_unique` ON `allowlist_identifiers` (`identifier`);--> statement-breakpoint
CREATE TABLE `api_keys` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`subject` text NOT NULL,
	`prefix` text NOT NULL,
	`secret_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`claims` text,
	`revoked` integer DEFAULT false NOT NULL,
	`revocation_reason` text,
	`expires_at` integer,
	`last_used_at` integer,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_secret_hash_unique` ON `api_keys` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `ak_subject_idx` ON `api_keys` (`subject`);--> statement-breakpoint
CREATE TABLE `audit_logs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor` text,
	`action` text NOT NULL,
	`target_type` text,
	`target_id` text,
	`metadata` text NOT NULL,
	`ip` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_created_idx` ON `audit_logs` (`created_at`);--> statement-breakpoint
CREATE TABLE `blocklist_identifiers` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`identifier_type` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `blocklist_identifiers_identifier_unique` ON `blocklist_identifiers` (`identifier`);--> statement-breakpoint
CREATE TABLE `clients` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`last_active_session_id` text,
	`ip` text,
	`user_agent` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `clients_token_hash_unique` ON `clients` (`token_hash`);--> statement-breakpoint
CREATE TABLE `email_addresses` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`email` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`verified_at` integer,
	`verified_strategy` text,
	`reserved` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `email_unique_verified` ON `email_addresses` (`email`) WHERE verified = 1;--> statement-breakpoint
CREATE INDEX `email_user_idx` ON `email_addresses` (`user_id`);--> statement-breakpoint
CREATE INDEX `email_addr_idx` ON `email_addresses` (`email`);--> statement-breakpoint
CREATE TABLE `enterprise_connections` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`protocol` text NOT NULL,
	`provider` text DEFAULT 'custom' NOT NULL,
	`domains` text NOT NULL,
	`active` integer DEFAULT false NOT NULL,
	`allow_subdomains` integer DEFAULT false NOT NULL,
	`allow_idp_initiated` integer DEFAULT false NOT NULL,
	`sync_user_attributes` integer DEFAULT true NOT NULL,
	`disable_additional_identifications` integer DEFAULT false NOT NULL,
	`config` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `external_accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`provider` text NOT NULL,
	`provider_user_id` text NOT NULL,
	`email_address` text DEFAULT '' NOT NULL,
	`first_name` text DEFAULT '' NOT NULL,
	`last_name` text DEFAULT '' NOT NULL,
	`username` text,
	`image_url` text,
	`approved_scopes` text DEFAULT '' NOT NULL,
	`access_token_enc` text,
	`refresh_token_enc` text,
	`token_expires_at` integer,
	`public_metadata` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ext_provider_uid` ON `external_accounts` (`provider`,`provider_user_id`);--> statement-breakpoint
CREATE INDEX `ext_user_idx` ON `external_accounts` (`user_id`);--> statement-breakpoint
CREATE TABLE `instance` (
	`id` text PRIMARY KEY NOT NULL,
	`settings` text NOT NULL,
	`secret_key_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`token_hash` text NOT NULL,
	`redirect_url` text,
	`public_metadata` text NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `invitations_token_hash_unique` ON `invitations` (`token_hash`);--> statement-breakpoint
CREATE TABLE `jwt_templates` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`claims` text NOT NULL,
	`lifetime` integer DEFAULT 60 NOT NULL,
	`allowed_clock_skew` integer DEFAULT 5 NOT NULL,
	`custom_signing_key` integer DEFAULT false NOT NULL,
	`signing_algorithm` text DEFAULT 'RS256' NOT NULL,
	`signing_key_enc` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jwt_templates_name_unique` ON `jwt_templates` (`name`);--> statement-breakpoint
CREATE TABLE `m2m_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`machine_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`claims` text,
	`revoked` integer DEFAULT false NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`machine_id`) REFERENCES `machines`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `m2m_tokens_token_hash_unique` ON `m2m_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `machines` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`secret_hash` text NOT NULL,
	`scoped_machines` text NOT NULL,
	`default_token_ttl` integer DEFAULT 3600 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `machines_secret_hash_unique` ON `machines` (`secret_hash`);--> statement-breakpoint
CREATE TABLE `oauth_applications` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`client_id` text NOT NULL,
	`client_secret_hash` text,
	`is_public` integer DEFAULT false NOT NULL,
	`redirect_uris` text NOT NULL,
	`scopes` text DEFAULT 'openid profile email' NOT NULL,
	`consent_screen_enabled` integer DEFAULT true NOT NULL,
	`pkce_required` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_applications_client_id_unique` ON `oauth_applications` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauth_consents` (
	`application_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`application_id`, `user_id`),
	FOREIGN KEY (`application_id`) REFERENCES `oauth_applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `oauth_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`application_id` text NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`scopes` text NOT NULL,
	`redirect_uri` text,
	`code_challenge` text,
	`code_challenge_method` text,
	`nonce` text,
	`revoked` integer DEFAULT false NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`application_id`) REFERENCES `oauth_applications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauth_grants_token_hash_unique` ON `oauth_grants` (`token_hash`);--> statement-breakpoint
CREATE TABLE `oauth_states` (
	`state` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`code_verifier` text,
	`nonce` text,
	`flow` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `organization_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`name` text NOT NULL,
	`enrollment_mode` text DEFAULT 'manual_invitation' NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`affiliation_email_address` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `od_org_name` ON `organization_domains` (`organization_id`,`name`);--> statement-breakpoint
CREATE TABLE `organization_invitations` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`email` text NOT NULL,
	`role_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`token_hash` text NOT NULL,
	`inviter_user_id` text,
	`redirect_url` text,
	`public_metadata` text NOT NULL,
	`private_metadata` text NOT NULL,
	`expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organization_invitations_token_hash_unique` ON `organization_invitations` (`token_hash`);--> statement-breakpoint
CREATE INDEX `oi_org_idx` ON `organization_invitations` (`organization_id`);--> statement-breakpoint
CREATE INDEX `oi_email_idx` ON `organization_invitations` (`email`);--> statement-breakpoint
CREATE TABLE `organization_membership_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `organization_memberships` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`user_id` text NOT NULL,
	`role_key` text NOT NULL,
	`public_metadata` text NOT NULL,
	`private_metadata` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `om_org_user` ON `organization_memberships` (`organization_id`,`user_id`);--> statement-breakpoint
CREATE INDEX `om_user_idx` ON `organization_memberships` (`user_id`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`slug` text,
	`image_url` text,
	`has_image` integer DEFAULT false NOT NULL,
	`max_allowed_memberships` integer DEFAULT 5 NOT NULL,
	`admin_delete_enabled` integer DEFAULT true NOT NULL,
	`public_metadata` text NOT NULL,
	`private_metadata` text NOT NULL,
	`created_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `passkeys` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`credential_id` text NOT NULL,
	`public_key` text NOT NULL,
	`counter` integer DEFAULT 0 NOT NULL,
	`transports` text,
	`device_type` text,
	`backed_up` integer DEFAULT false NOT NULL,
	`last_used_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `passkeys_credential_id_unique` ON `passkeys` (`credential_id`);--> statement-breakpoint
CREATE TABLE `permissions` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`type` text DEFAULT 'user' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `permissions_key_unique` ON `permissions` (`key`);--> statement-breakpoint
CREATE TABLE `phone_numbers` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`phone` text NOT NULL,
	`verified` integer DEFAULT false NOT NULL,
	`verified_at` integer,
	`reserved_for_second_factor` integer DEFAULT false NOT NULL,
	`default_second_factor` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `phone_unique_verified` ON `phone_numbers` (`phone`) WHERE verified = 1;--> statement-breakpoint
CREATE INDEX `phone_user_idx` ON `phone_numbers` (`user_id`);--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`key` text PRIMARY KEY NOT NULL,
	`count` integer NOT NULL,
	`reset_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `role_permissions` (
	`role_id` text NOT NULL,
	`permission_id` text NOT NULL,
	PRIMARY KEY(`role_id`, `permission_id`),
	FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `roles` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`is_creator_eligible` integer DEFAULT false NOT NULL,
	`is_system` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `roles_key_unique` ON `roles` (`key`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`last_active_at` integer NOT NULL,
	`last_active_organization_id` text,
	`expire_at` integer NOT NULL,
	`abandon_at` integer NOT NULL,
	`actor` text,
	`first_factor_verified_at` integer,
	`second_factor_verified_at` integer,
	`ip` text,
	`user_agent` text,
	`city` text,
	`country` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `sess_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sess_client_idx` ON `sessions` (`client_id`);--> statement-breakpoint
CREATE TABLE `sign_in_tokens` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sign_in_tokens_token_hash_unique` ON `sign_in_tokens` (`token_hash`);--> statement-breakpoint
CREATE TABLE `sign_ins` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`status` text NOT NULL,
	`identifier` text,
	`user_id` text,
	`state` text NOT NULL,
	`created_session_id` text,
	`abandon_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `sign_ups` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`status` text NOT NULL,
	`fields` text NOT NULL,
	`unsafe_metadata` text NOT NULL,
	`verifications` text NOT NULL,
	`invitation_id` text,
	`org_invitation_id` text,
	`created_session_id` text,
	`created_user_id` text,
	`abandon_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `clients`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `signing_keys` (
	`kid` text PRIMARY KEY NOT NULL,
	`alg` text NOT NULL,
	`public_jwk` text NOT NULL,
	`private_jwk_enc` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	`rotated_at` integer
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`external_id` text,
	`username` text,
	`username_lower` text,
	`first_name` text,
	`last_name` text,
	`image_url` text,
	`has_image` integer DEFAULT false NOT NULL,
	`password_hash` text,
	`password_updated_at` integer,
	`primary_email_address_id` text,
	`primary_phone_number_id` text,
	`public_metadata` text NOT NULL,
	`private_metadata` text NOT NULL,
	`unsafe_metadata` text NOT NULL,
	`banned` integer DEFAULT false NOT NULL,
	`locked` integer DEFAULT false NOT NULL,
	`lockout_expires_at` integer,
	`failed_attempts` integer DEFAULT 0 NOT NULL,
	`totp_secret_enc` text,
	`totp_verified` integer DEFAULT false NOT NULL,
	`backup_codes` text,
	`delete_self_enabled` integer DEFAULT true NOT NULL,
	`create_organization_enabled` integer DEFAULT true NOT NULL,
	`create_organizations_limit` integer,
	`legal_accepted_at` integer,
	`last_sign_in_at` integer,
	`last_active_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_external_id_unique` ON `users` (`external_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_username_lower_unique` ON `users` (`username_lower`);--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`purpose` text NOT NULL,
	`strategy` text NOT NULL,
	`identifier` text NOT NULL,
	`owner_id` text NOT NULL,
	`code_hash` text,
	`token_hash` text,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 5 NOT NULL,
	`redirect_url` text,
	`consumed_at` integer,
	`verified_at` integer,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `ver_owner_idx` ON `verifications` (`owner_id`,`purpose`);--> statement-breakpoint
CREATE INDEX `ver_token_idx` ON `verifications` (`token_hash`);--> statement-breakpoint
CREATE TABLE `waitlist_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`invitation_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `waitlist_entries_email_unique` ON `waitlist_entries` (`email`);--> statement-breakpoint
CREATE TABLE `webhook_deliveries` (
	`id` text PRIMARY KEY NOT NULL,
	`endpoint_id` text NOT NULL,
	`event_id` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`attempt` integer DEFAULT 0 NOT NULL,
	`response_code` integer,
	`response_body` text,
	`next_attempt_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`endpoint_id`) REFERENCES `webhook_endpoints`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `webhook_events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `wd_due_idx` ON `webhook_deliveries` (`status`,`next_attempt_at`);--> statement-breakpoint
CREATE TABLE `webhook_endpoints` (
	`id` text PRIMARY KEY NOT NULL,
	`url` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`event_types` text NOT NULL,
	`secret` text NOT NULL,
	`disabled` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `webhook_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`payload` text NOT NULL,
	`created_at` integer NOT NULL
);
