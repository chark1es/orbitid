//! Every `FromRow` model decodes a real row from the migrated schema. This is
//! what catches a column rename that a compile-time `derive` cannot see.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod support;

use sqlx::types::Json;
use sqlx::PgPool;

use orbitid_core::models::*;

type R = orbitid_core::Result<()>;

macro_rules! exec {
    ($pool:expr, $sql:expr $(, $bind:expr)*) => {{
        #[allow(unused_mut)]
        let mut query = sqlx::query($sql);
        $(query = query.bind($bind);)*
        query.execute($pool).await.unwrap();
    }};
}

async fn seed(pool: &PgPool) -> R {
    let now = 1_700_000_000_000_i64;
    let empty = || Json(serde_json::json!({}));

    exec!(pool, "INSERT INTO users (id, first_name, public_metadata, private_metadata, unsafe_metadata, created_at, updated_at) VALUES ('user_1','Ada',$1,$1,$1,$2,$2)", empty(), now);
    exec!(pool, "INSERT INTO signing_keys (kid, alg, public_jwk, private_jwk_enc, created_at) VALUES ('kid_1','RS256',$1,'enc',$2)", empty(), now);
    exec!(pool, "INSERT INTO email_addresses (id, user_id, email, created_at, updated_at) VALUES ('idn_e_1','user_1','ada@example.com',$1,$1)", now);
    exec!(pool, "INSERT INTO phone_numbers (id, user_id, phone, created_at, updated_at) VALUES ('idn_p_1','user_1','+15555550100',$1,$1)", now);
    exec!(pool, "INSERT INTO external_accounts (id, user_id, provider, provider_user_id, public_metadata, created_at, updated_at) VALUES ('eac_1','user_1','github','gh_1',$1,$2,$2)", empty(), now);
    exec!(pool, "INSERT INTO passkeys (id, user_id, name, credential_id, public_key, created_at, updated_at) VALUES ('pkey_1','user_1','Laptop','cred','cose',$1,$1)", now);
    exec!(pool, "INSERT INTO clients (id, token_hash, created_at, updated_at) VALUES ('client_1','hash_1',$1,$1)", now);
    exec!(pool, "INSERT INTO sessions (id, client_id, user_id, last_active_at, expire_at, abandon_at, created_at, updated_at) VALUES ('sess_1','client_1','user_1',$1,$2,$2,$1,$1)", now, now + 1000);
    exec!(pool, "INSERT INTO sign_ins (id, client_id, status, state, abandon_at, created_at, updated_at) VALUES ('sia_1','client_1','needs_identifier',$1,$2,$3,$3)", empty(), now + 1000, now);
    exec!(pool, "INSERT INTO sign_ups (id, client_id, status, fields, unsafe_metadata, verifications, abandon_at, created_at, updated_at) VALUES ('sua_1','client_1','missing_requirements',$1,$1,$1,$2,$3,$3)", empty(), now + 1000, now);
    exec!(pool, "INSERT INTO verifications (id, purpose, strategy, identifier, owner_id, expires_at, created_at) VALUES ('ver_1','sign_in_first_factor','email_code','ada@example.com','sia_1',$1,$2)", now + 1000, now);
    exec!(pool, "INSERT INTO oauth_states (state, provider, flow, expires_at) VALUES ('state_1','google',$1,$2)", empty(), now + 1000);
    exec!(
        pool,
        "INSERT INTO rate_limits (key, count, reset_at) VALUES ('k',1,$1)",
        now + 1000
    );

    exec!(pool, "INSERT INTO organizations (id, name, public_metadata, private_metadata, created_at, updated_at) VALUES ('org_1','Acme',$1,$1,$2,$2)", empty(), now);
    exec!(pool, "INSERT INTO roles (id, key, name, created_at, updated_at) VALUES ('role_1','org:admin','Admin',$1,$1)", now);
    exec!(pool, "INSERT INTO permissions (id, key, name, created_at, updated_at) VALUES ('perm_1','org:team:manage','Manage',$1,$1)", now);
    exec!(
        pool,
        "INSERT INTO role_permissions (role_id, permission_id) VALUES ('role_1','perm_1')"
    );
    exec!(pool, "INSERT INTO user_roles (user_id, role_key, created_at, updated_at) VALUES ('user_1','org:admin',$1,$1)", now);
    exec!(pool, "INSERT INTO organization_memberships (id, organization_id, user_id, role_key, public_metadata, private_metadata, created_at, updated_at) VALUES ('orgmem_1','org_1','user_1','org:admin',$1,$1,$2,$2)", empty(), now);
    exec!(pool, "INSERT INTO organization_invitations (id, organization_id, email, role_key, token_hash, public_metadata, private_metadata, created_at, updated_at) VALUES ('orginv_1','org_1','b@example.com','org:member','hash_i',$1,$1,$2,$2)", empty(), now);
    exec!(pool, "INSERT INTO organization_domains (id, organization_id, name, created_at, updated_at) VALUES ('orgdmn_1','org_1','example.com',$1,$1)", now);
    exec!(pool, "INSERT INTO organization_membership_requests (id, organization_id, user_id, created_at, updated_at) VALUES ('orgmreq_1','org_1','user_1',$1,$1)", now);
    exec!(pool, "INSERT INTO invitations (id, email, token_hash, public_metadata, created_at, updated_at) VALUES ('inv_1','c@example.com','hash_inv',$1,$2,$2)", empty(), now);
    exec!(pool, "INSERT INTO waitlist_entries (id, email, created_at, updated_at) VALUES ('wle_1','d@example.com',$1,$1)", now);
    exec!(pool, "INSERT INTO allowlist_identifiers (id, identifier, identifier_type, created_at, updated_at) VALUES ('alid_1','@example.com','email_address',$1,$1)", now);
    exec!(pool, "INSERT INTO blocklist_identifiers (id, identifier, identifier_type, created_at, updated_at) VALUES ('blid_1','@spam.example','email_address',$1,$1)", now);

    exec!(pool, "INSERT INTO jwt_templates (id, name, claims, created_at, updated_at) VALUES ('jtmpl_1','tpl',$1,$2,$2)", empty(), now);
    exec!(pool, "INSERT INTO actor_tokens (id, user_id, actor, token_hash, expires_at, created_at, updated_at) VALUES ('act_1','user_1',$1,'hash_act',$2,$3,$3)", empty(), now + 1000, now);
    exec!(pool, "INSERT INTO sign_in_tokens (id, user_id, token_hash, expires_at, created_at, updated_at) VALUES ('sit_1','user_1','hash_sit',$1,$2,$2)", now + 1000, now);

    exec!(pool, "INSERT INTO webhook_endpoints (id, url, event_types, secret, created_at, updated_at) VALUES ('we_1','https://hooks.example.com',$1,'whsec_x',$2,$2)", Json(serde_json::json!([])), now);
    exec!(pool, "INSERT INTO webhook_events (id, type, payload, created_at) VALUES ('evt_1','user.created',$1,$2)", empty(), now);
    exec!(pool, "INSERT INTO webhook_deliveries (id, endpoint_id, event_id, created_at) VALUES ('whd_1','we_1','evt_1',$1)", now);

    exec!(pool, "INSERT INTO api_keys (id, name, subject, prefix, secret_hash, scopes, created_at, updated_at) VALUES ('ak_1','Key','user_1','ak_test_abc','hash_ak',$1,$2,$2)", Json(serde_json::json!(["read"])), now);
    exec!(pool, "INSERT INTO machines (id, name, secret_hash, scoped_machines, created_at, updated_at) VALUES ('mch_1','Robot','hash_mch',$1,$2,$2)", Json(serde_json::json!([])), now);
    exec!(pool, "INSERT INTO m2m_tokens (id, machine_id, token_hash, created_at) VALUES ('mt_1','mch_1','hash_mt',$1)", now);
    exec!(pool, "INSERT INTO oauth_applications (id, name, client_id, redirect_uris, created_at, updated_at) VALUES ('oa_1','App','client_oa',$1,$2,$2)", Json(serde_json::json!(["https://app.example.com/cb"])), now);
    exec!(pool, "INSERT INTO oauth_grants (id, kind, application_id, user_id, token_hash, scopes, expires_at, created_at) VALUES ('oag_1','access','oa_1','user_1','hash_oag','openid',$1,$2)", now + 1000, now);
    exec!(pool, "INSERT INTO oauth_consents (application_id, user_id, scopes, created_at) VALUES ('oa_1','user_1','openid',$1)", now);
    exec!(pool, "INSERT INTO enterprise_connections (id, name, protocol, domains, config, created_at, updated_at) VALUES ('ent_1','Corp','saml',$1,$2,$3,$3)", Json(serde_json::json!(["corp.example"])), empty(), now);
    exec!(pool, "INSERT INTO audit_logs (id, action, metadata, created_at) VALUES ('aud_1','user.created',$1,$2)", empty(), now);

    exec!(pool, "INSERT INTO trusted_devices (id, user_id, token_hash, expires_at, created_at, updated_at) VALUES ('tdev_1','user_1','hash_tdev',$1,$2,$2)", now + 1000, now);
    exec!(pool, "INSERT INTO operator_sessions (id, token_hash, key_fingerprint, expires_at, created_at, updated_at) VALUES ('osess_1','hash_osess','fp',$1,$2,$2)", now + 1000, now);
    exec!(pool, "INSERT INTO device_codes (id, application_id, device_code_hash, user_code, scopes, expires_at, created_at) VALUES ('dc_1','oa_1','hash_dc','ABCD-EFGH','openid',$1,$2)", now + 1000, now);
    Ok(())
}

async fn decode(pool: &PgPool) -> R {
    let _: InstanceRow = sqlx::query_as("SELECT * FROM instance WHERE id = 'default'")
        .fetch_one(pool)
        .await?;
    let _: SigningKeyRow = sqlx::query_as("SELECT * FROM signing_keys")
        .fetch_one(pool)
        .await?;
    let _: UserRow = sqlx::query_as("SELECT * FROM users")
        .fetch_one(pool)
        .await?;
    let _: EmailAddressRow = sqlx::query_as("SELECT * FROM email_addresses")
        .fetch_one(pool)
        .await?;
    let _: PhoneNumberRow = sqlx::query_as("SELECT * FROM phone_numbers")
        .fetch_one(pool)
        .await?;
    let _: ExternalAccountRow = sqlx::query_as("SELECT * FROM external_accounts")
        .fetch_one(pool)
        .await?;
    let _: PasskeyRow = sqlx::query_as("SELECT * FROM passkeys")
        .fetch_one(pool)
        .await?;
    let _: ClientRow = sqlx::query_as("SELECT * FROM clients")
        .fetch_one(pool)
        .await?;
    let _: SessionRow = sqlx::query_as("SELECT * FROM sessions")
        .fetch_one(pool)
        .await?;
    let _: SignInRow = sqlx::query_as("SELECT * FROM sign_ins")
        .fetch_one(pool)
        .await?;
    let _: SignUpRow = sqlx::query_as("SELECT * FROM sign_ups")
        .fetch_one(pool)
        .await?;
    let _: VerificationRow = sqlx::query_as("SELECT * FROM verifications")
        .fetch_one(pool)
        .await?;
    let _: OauthStateRow = sqlx::query_as("SELECT * FROM oauth_states")
        .fetch_one(pool)
        .await?;
    let _: RateLimitRow = sqlx::query_as("SELECT * FROM rate_limits")
        .fetch_one(pool)
        .await?;
    let _: OrganizationRow = sqlx::query_as("SELECT * FROM organizations")
        .fetch_one(pool)
        .await?;
    let _: RoleRow = sqlx::query_as("SELECT * FROM roles")
        .fetch_one(pool)
        .await?;
    let _: PermissionRow = sqlx::query_as("SELECT * FROM permissions")
        .fetch_one(pool)
        .await?;
    let _: RolePermissionRow = sqlx::query_as("SELECT * FROM role_permissions")
        .fetch_one(pool)
        .await?;
    let _: UserRoleRow = sqlx::query_as("SELECT * FROM user_roles")
        .fetch_one(pool)
        .await?;
    let _: OrganizationMembershipRow = sqlx::query_as("SELECT * FROM organization_memberships")
        .fetch_one(pool)
        .await?;
    let _: OrganizationInvitationRow = sqlx::query_as("SELECT * FROM organization_invitations")
        .fetch_one(pool)
        .await?;
    let _: OrganizationDomainRow = sqlx::query_as("SELECT * FROM organization_domains")
        .fetch_one(pool)
        .await?;
    let _: OrganizationMembershipRequestRow =
        sqlx::query_as("SELECT * FROM organization_membership_requests")
            .fetch_one(pool)
            .await?;
    let _: InvitationRow = sqlx::query_as("SELECT * FROM invitations")
        .fetch_one(pool)
        .await?;
    let _: WaitlistEntryRow = sqlx::query_as("SELECT * FROM waitlist_entries")
        .fetch_one(pool)
        .await?;
    let _: AllowlistIdentifierRow = sqlx::query_as("SELECT * FROM allowlist_identifiers")
        .fetch_one(pool)
        .await?;
    let _: BlocklistIdentifierRow = sqlx::query_as("SELECT * FROM blocklist_identifiers")
        .fetch_one(pool)
        .await?;
    let _: JwtTemplateRow = sqlx::query_as("SELECT * FROM jwt_templates")
        .fetch_one(pool)
        .await?;
    let _: ActorTokenRow = sqlx::query_as("SELECT * FROM actor_tokens")
        .fetch_one(pool)
        .await?;
    let _: SignInTokenRow = sqlx::query_as("SELECT * FROM sign_in_tokens")
        .fetch_one(pool)
        .await?;
    let _: WebhookEndpointRow = sqlx::query_as("SELECT * FROM webhook_endpoints")
        .fetch_one(pool)
        .await?;
    let _: WebhookEventRow = sqlx::query_as("SELECT * FROM webhook_events")
        .fetch_one(pool)
        .await?;
    let _: WebhookDeliveryRow = sqlx::query_as("SELECT * FROM webhook_deliveries")
        .fetch_one(pool)
        .await?;
    let _: ApiKeyRow = sqlx::query_as("SELECT * FROM api_keys")
        .fetch_one(pool)
        .await?;
    let _: MachineRow = sqlx::query_as("SELECT * FROM machines")
        .fetch_one(pool)
        .await?;
    let _: M2mTokenRow = sqlx::query_as("SELECT * FROM m2m_tokens")
        .fetch_one(pool)
        .await?;
    let _: OauthApplicationRow = sqlx::query_as("SELECT * FROM oauth_applications")
        .fetch_one(pool)
        .await?;
    let _: OauthGrantRow = sqlx::query_as("SELECT * FROM oauth_grants")
        .fetch_one(pool)
        .await?;
    let _: OauthConsentRow = sqlx::query_as("SELECT * FROM oauth_consents")
        .fetch_one(pool)
        .await?;
    let _: EnterpriseConnectionRow = sqlx::query_as("SELECT * FROM enterprise_connections")
        .fetch_one(pool)
        .await?;
    let _: AuditLogRow = sqlx::query_as("SELECT * FROM audit_logs")
        .fetch_one(pool)
        .await?;
    let _: TrustedDeviceRow = sqlx::query_as("SELECT * FROM trusted_devices")
        .fetch_one(pool)
        .await?;
    let _: OperatorSessionRow = sqlx::query_as("SELECT * FROM operator_sessions")
        .fetch_one(pool)
        .await?;
    let _: DeviceCodeRow = sqlx::query_as("SELECT * FROM device_codes")
        .fetch_one(pool)
        .await?;
    Ok(())
}

#[tokio::test]
async fn every_model_decodes_its_table() {
    let ctx = support::test_state().await;
    seed(&ctx.state.pool).await.unwrap();
    decode(&ctx.state.pool).await.unwrap();

    // Spot-check the mapping of a JSON object, a JSON array, a nullable column and a
    // bigint timestamp through the generated `FromRow` implementation.
    let user: UserRow = sqlx::query_as("SELECT * FROM users")
        .fetch_one(&ctx.state.pool)
        .await
        .unwrap();
    assert_eq!(user.first_name.as_deref(), Some("Ada"));
    assert!(user.public_metadata.0.is_empty());
    assert_eq!(user.created_at, 1_700_000_000_000);

    let app: OauthApplicationRow = sqlx::query_as("SELECT * FROM oauth_applications")
        .fetch_one(&ctx.state.pool)
        .await
        .unwrap();
    assert_eq!(app.redirect_uris.0, vec!["https://app.example.com/cb"]);
    assert!(app.client_secret_hash.is_none());
    assert!(!app.pkce_required);

    // A real unique violation becomes the wire's bare 409 `duplicate_record`.
    let error = sqlx::query(
        "INSERT INTO waitlist_entries (id, email, created_at, updated_at) VALUES ('wle_2','d@example.com',0,0)",
    )
    .execute(&ctx.state.pool)
    .await
    .unwrap_err();
    let error = orbitid_core::OrbitError::from(error);
    assert_eq!(error.status, axum::http::StatusCode::CONFLICT);
    assert_eq!(error.code, "duplicate_record");
    let item = &error.body(Some("t".into())).errors[0];
    assert_eq!(item.message, "That record already exists");
    assert!(item.long_message.is_none());
}
