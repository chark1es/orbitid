//! Ported from the retired TypeScript test suite (Backend API parts).

mod common;

use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use orbitid_platform::mail::{set_mail_transport, MailTransportOverride, SentEmail};
use serde_json::{json, Value};

use common::{error_code, setup, Harness};

#[derive(Default)]
struct Capture {
    emails: Mutex<Vec<SentEmail>>,
}

#[async_trait::async_trait]
impl MailTransportOverride for Capture {
    async fn deliver(&self, email: &SentEmail) -> orbitid_core::Result<()> {
        self.emails.lock().expect("capture").push(email.clone());
        Ok(())
    }
}

fn capture(harness: &Harness) -> Arc<Capture> {
    let capture = Arc::new(Capture::default());
    set_mail_transport(harness.state(), Some(capture.clone()));
    capture
}

async fn create_user(harness: &Harness) -> String {
    static COUNTER: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let n = COUNTER.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let response = harness
        .post(
            "/v1/users",
            json!({ "email_address": [format!("org-user-{n}@example.com")], "password": "Sup3r-secret!" }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()["id"].as_str().unwrap().to_string()
}

async fn create_org(harness: &Harness, body: Value) -> Value {
    let response = harness.post("/v1/organizations", body).await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    response.value()
}

fn id_of(value: &Value) -> String {
    value["id"].as_str().unwrap_or_default().to_string()
}

fn keys(value: &Value) -> Vec<String> {
    value
        .as_array()
        .map(|items| {
            items
                .iter()
                .map(|item| item["key"].as_str().unwrap_or_default().to_string())
                .collect()
        })
        .unwrap_or_default()
}

#[tokio::test]
async fn creates_queries_updates_and_deletes_organizations() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let created = harness
        .post(
            "/v1/organizations",
            json!({
                "name": "Acme Corp",
                "created_by": owner,
                "max_allowed_memberships": 12,
                "public_metadata": { "tier": "pro" },
                "private_metadata": { "billing": "acct_1" },
            }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let org = created.value();
    assert_eq!(org["slug"], json!("acme-corp"));
    assert_eq!(org["created_by"], json!(owner));
    assert_eq!(org["max_allowed_memberships"], json!(12));
    assert_eq!(org["private_metadata"], json!({ "billing": "acct_1" }));
    assert_eq!(org["members_count"], json!(1));
    let org_id = id_of(&org);

    let list = harness.get("/v1/organizations?query=acme&limit=10").await;
    assert_eq!(list.value()["total_count"], json!(1));
    assert_eq!(list.value()["data"][0]["id"], json!(org_id));

    let without = harness
        .get("/v1/organizations?include_members_count=false")
        .await;
    assert!(without.value()["data"][0].get("members_count").is_none());

    let by_slug = harness.get("/v1/organizations/acme-corp").await;
    assert_eq!(by_slug.status, StatusCode::OK, "{}", by_slug.text());
    assert_eq!(by_slug.value()["id"], json!(org_id));
    assert_eq!(
        by_slug.value()["private_metadata"],
        json!({ "billing": "acct_1" })
    );

    let updated = harness
        .patch(
            &format!("/v1/organizations/{org_id}"),
            json!({ "name": "Acme Two", "admin_delete_enabled": false }),
        )
        .await;
    assert_eq!(updated.value()["name"], json!("Acme Two"));
    assert_eq!(updated.value()["admin_delete_enabled"], json!(false));

    let first = harness
        .patch(
            &format!("/v1/organizations/{org_id}/metadata"),
            json!({ "public_metadata": { "tier": "free", "nested": { "a": 1, "b": 2 } } }),
        )
        .await;
    assert_eq!(
        first.value()["public_metadata"],
        json!({ "tier": "free", "nested": { "a": 1, "b": 2 } })
    );
    let second = harness
        .patch(
            &format!("/v1/organizations/{org_id}/metadata"),
            json!({ "public_metadata": { "nested": { "a": 9 }, "extra": true } }),
        )
        .await;
    assert_eq!(
        second.value()["public_metadata"],
        json!({ "tier": "free", "nested": { "a": 9, "b": 2 }, "extra": true })
    );
    assert_eq!(
        second.value()["private_metadata"],
        json!({ "billing": "acct_1" })
    );

    let removed = harness
        .patch(
            &format!("/v1/organizations/{org_id}"),
            json!({ "public_metadata": { "tier": null } }),
        )
        .await;
    assert_eq!(
        removed.value()["public_metadata"],
        json!({ "nested": { "a": 9, "b": 2 }, "extra": true })
    );
    let merged = harness
        .patch(
            &format!("/v1/organizations/{org_id}"),
            json!({ "public_metadata": { "nested": { "c": 3 } } }),
        )
        .await;
    assert_eq!(
        merged.value()["public_metadata"],
        json!({ "nested": { "a": 9, "b": 2, "c": 3 }, "extra": true })
    );

    assert_eq!(
        harness
            .delete(&format!("/v1/organizations/{org_id}"))
            .await
            .value(),
        json!({ "object": "organization", "id": org_id, "deleted": true })
    );
    assert_eq!(
        harness
            .get(&format!("/v1/organizations/{org_id}"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn manages_memberships_with_metadata_quota_and_last_admin_guards() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    let org = create_org(
        &harness,
        json!({ "name": "Acme", "created_by": owner, "max_allowed_memberships": 2 }),
    )
    .await;
    let org_id = id_of(&org);

    let added = harness
        .post(
            &format!("/v1/organizations/{org_id}/memberships"),
            json!({
                "user_id": member,
                "role": "org:member",
                "public_metadata": { "seat": 1 },
                "private_metadata": { "note": "x" },
            }),
        )
        .await;
    assert_eq!(added.status, StatusCode::OK, "{}", added.text());
    assert_eq!(added.value()["role"], json!("org:member"));
    assert_eq!(added.value()["private_metadata"], json!({ "note": "x" }));

    let duplicate = harness
        .post(
            &format!("/v1/organizations/{org_id}/memberships"),
            json!({ "user_id": member }),
        )
        .await;
    assert_eq!(duplicate.status, StatusCode::CONFLICT);
    assert_eq!(error_code(&duplicate).as_deref(), Some("duplicate_record"));

    let third = create_user(&harness).await;
    let over = harness
        .post(
            &format!("/v1/organizations/{org_id}/memberships"),
            json!({ "user_id": third }),
        )
        .await;
    assert_eq!(over.status, StatusCode::FORBIDDEN);
    assert_eq!(
        error_code(&over).as_deref(),
        Some("organization_membership_quota_exceeded")
    );

    let merged = harness
        .patch(
            &format!("/v1/organizations/{org_id}/memberships/{member}/metadata"),
            json!({ "public_metadata": { "seat": 2, "extra": true } }),
        )
        .await;
    assert_eq!(
        merged.value()["public_metadata"],
        json!({ "seat": 2, "extra": true })
    );
    let by_patch = harness
        .patch(
            &format!("/v1/organizations/{org_id}/memberships/{member}"),
            json!({ "public_metadata": { "seat": 3 } }),
        )
        .await;
    assert_eq!(
        by_patch.value()["public_metadata"],
        json!({ "seat": 3, "extra": true })
    );

    let listed = harness
        .get(&format!(
            "/v1/organizations/{org_id}/memberships?query=member&role=org:member"
        ))
        .await;
    assert_eq!(listed.value()["total_count"], json!(1));
    let by_user = harness
        .get(&format!("/v1/users/{member}/organization_memberships"))
        .await;
    assert_eq!(by_user.value()["total_count"], json!(1));

    let remove_admin = harness
        .delete(&format!("/v1/organizations/{org_id}/memberships/{owner}"))
        .await;
    assert_eq!(remove_admin.status, StatusCode::FORBIDDEN);
    assert_eq!(
        error_code(&remove_admin).as_deref(),
        Some("organization_minimum_permissions_needed")
    );
    let demote = harness
        .patch(
            &format!("/v1/organizations/{org_id}/memberships/{owner}"),
            json!({ "role": "org:member" }),
        )
        .await;
    assert_eq!(demote.status, StatusCode::FORBIDDEN);

    let removed = harness
        .delete(&format!("/v1/organizations/{org_id}/memberships/{member}"))
        .await;
    assert_eq!(removed.value()["deleted"], json!(true));
    assert_eq!(
        harness
            .get(&format!("/v1/users/{member}/organization_memberships"))
            .await
            .value()["total_count"],
        json!(0)
    );

    assert_eq!(
        harness
            .post(
                &format!("/v1/organizations/{org_id}/memberships"),
                json!({ "user_id": "user_missing" }),
            )
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn manages_invitations_including_bulk_and_the_no_email_url_flow() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let org = create_org(&harness, json!({ "name": "Acme", "created_by": owner })).await;
    let org_id = id_of(&org);

    let single = harness
        .post(
            &format!("/v1/organizations/{org_id}/invitations"),
            json!({ "email_address": "invitee@acme.test", "role": "org:member" }),
        )
        .await;
    assert_eq!(single.status, StatusCode::OK, "{}", single.text());
    assert_eq!(single.value()["status"], json!("pending"));
    assert!(single.value()["url"]
        .as_str()
        .unwrap_or_default()
        .contains("/v1/client/organization_invitations/accept?ticket="));

    let notified = harness
        .post(
            &format!("/v1/organizations/{org_id}/invitations"),
            json!({ "email_address": "notified@acme.test", "notify": true }),
        )
        .await;
    assert!(notified.value().get("url").is_none() || notified.value()["url"].is_null());

    assert_eq!(
        harness
            .get(&format!(
                "/v1/organizations/{org_id}/invitations?status=pending"
            ))
            .await
            .value()["total_count"],
        json!(2)
    );
    let invitation_id = id_of(&single.value());
    assert_eq!(
        harness
            .get(&format!(
                "/v1/organizations/{org_id}/invitations/{invitation_id}"
            ))
            .await
            .value()["email_address"],
        json!("invitee@acme.test")
    );

    let revoked = harness
        .post_empty(&format!(
            "/v1/organizations/{org_id}/invitations/{invitation_id}/revoke"
        ))
        .await;
    assert_eq!(revoked.value()["status"], json!("revoked"));
    assert_eq!(
        harness
            .post_empty(&format!(
                "/v1/organizations/{org_id}/invitations/{invitation_id}/revoke"
            ))
            .await
            .status,
        StatusCode::CONFLICT
    );

    let bulk = harness
        .post(
            &format!("/v1/organizations/{org_id}/invitations/bulk"),
            json!({ "email_addresses": ["a@acme.test", "b@acme.test", "a@acme.test"] }),
        )
        .await;
    assert_eq!(bulk.status, StatusCode::OK, "{}", bulk.text());
    let items = bulk.value();
    assert_eq!(items.as_array().map(Vec::len), Some(2));
    assert!(items
        .as_array()
        .unwrap()
        .iter()
        .all(|item| item["url"].is_string()));
}

#[tokio::test]
async fn manages_and_verifies_domains() {
    let harness = setup().await;
    let capture = capture(&harness);
    let owner = create_user(&harness).await;
    let org = create_org(&harness, json!({ "name": "Acme", "created_by": owner })).await;
    let org_id = id_of(&org);

    let created = harness
        .post(
            &format!("/v1/organizations/{org_id}/domains"),
            json!({ "name": "acme.test", "enrollment_mode": "automatic_suggestion" }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    assert_eq!(created.value()["name"], json!("acme.test"));
    assert_eq!(
        created.value()["verification"]["status"],
        json!("unverified")
    );
    let domain_id = id_of(&created.value());

    let updated = harness
        .patch(
            &format!("/v1/organizations/{org_id}/domains/{domain_id}"),
            json!({ "enrollment_mode": "manual_invitation" }),
        )
        .await;
    assert_eq!(
        updated.value()["enrollment_mode"],
        json!("manual_invitation")
    );
    assert_eq!(
        harness
            .get(&format!("/v1/organizations/{org_id}/domains"))
            .await
            .value()["total_count"],
        json!(1)
    );

    let mismatch = harness
        .post(
            &format!(
                "/v1/organizations/{org_id}/domains/{domain_id}/prepare_affiliation_verification"
            ),
            json!({ "affiliation_email_address": "owner@other.test" }),
        )
        .await;
    assert_eq!(mismatch.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(&mismatch).as_deref(),
        Some("form_param_value_invalid")
    );

    let prepared = harness
        .post(
            &format!(
                "/v1/organizations/{org_id}/domains/{domain_id}/prepare_affiliation_verification"
            ),
            json!({ "affiliation_email_address": "owner@acme.test" }),
        )
        .await;
    assert_eq!(prepared.status, StatusCode::OK, "{}", prepared.text());
    assert_eq!(
        prepared.value()["affiliation_email_address"],
        json!("owner@acme.test")
    );
    let code = capture
        .emails
        .lock()
        .expect("capture")
        .iter()
        .rev()
        .find(|email| email.template.as_str() == "domain_verification_code")
        .and_then(|email| email.vars.get("code"))
        .and_then(Value::as_str)
        .expect("code")
        .to_string();

    let wrong_code = if code == "000000" { "111111" } else { "000000" };
    let wrong = harness
        .post(
            &format!(
                "/v1/organizations/{org_id}/domains/{domain_id}/attempt_affiliation_verification"
            ),
            json!({ "code": wrong_code }),
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_code(&wrong).as_deref(), Some("form_code_incorrect"));

    let verified = harness
        .post(
            &format!(
                "/v1/organizations/{org_id}/domains/{domain_id}/attempt_affiliation_verification"
            ),
            json!({ "code": code }),
        )
        .await;
    assert_eq!(verified.status, StatusCode::OK, "{}", verified.text());
    assert_eq!(
        verified.value()["verification"]["status"],
        json!("verified")
    );

    assert_eq!(
        harness
            .delete(&format!("/v1/organizations/{org_id}/domains/{domain_id}"))
            .await
            .value()["deleted"],
        json!(true)
    );
    assert_eq!(
        harness
            .post(
                &format!("/v1/organizations/{org_id}/domains"),
                json!({ "name": "invalid" }),
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
}

#[tokio::test]
async fn guards_affiliation_verification_with_auth_expiry_attempts_and_throttling() {
    let harness = setup().await;
    let _capture = capture(&harness);
    let owner = create_user(&harness).await;
    let org = create_org(&harness, json!({ "name": "Acme", "created_by": owner })).await;
    let org_id = id_of(&org);
    let domain = harness
        .post(
            &format!("/v1/organizations/{org_id}/domains"),
            json!({ "name": "acme.test" }),
        )
        .await
        .value();
    let domain_id = id_of(&domain);
    let prepare_path =
        format!("/v1/organizations/{org_id}/domains/{domain_id}/prepare_affiliation_verification");
    let attempt_path =
        format!("/v1/organizations/{org_id}/domains/{domain_id}/attempt_affiliation_verification");

    let unauthenticated = harness
        .client
        .post(
            &prepare_path,
            Some(json!({ "affiliation_email_address": "owner@acme.test" })),
            &[],
        )
        .await;
    assert_eq!(unauthenticated.status, StatusCode::UNAUTHORIZED);

    harness
        .post(
            &prepare_path,
            json!({ "affiliation_email_address": "expired@acme.test" }),
        )
        .await;
    sqlx::query(
        "UPDATE verifications SET expires_at = $1 WHERE purpose = 'org_domain' AND identifier = $2",
    )
    .bind(orbitid_core::http::now() - 1_000)
    .bind("expired@acme.test")
    .execute(&harness.state().pool)
    .await
    .expect("expire");
    let expired = harness
        .post(&attempt_path, json!({ "code": "123456" }))
        .await;
    assert_eq!(expired.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        error_code(&expired).as_deref(),
        Some("verification_expired")
    );

    harness
        .post(
            &prepare_path,
            json!({ "affiliation_email_address": "attempts@acme.test" }),
        )
        .await;
    for _ in 0..5 {
        let wrong = harness
            .post(&attempt_path, json!({ "code": "000000" }))
            .await;
        assert_eq!(wrong.status, StatusCode::UNPROCESSABLE_ENTITY);
    }
    let exhausted = harness
        .post(&attempt_path, json!({ "code": "000000" }))
        .await;
    assert_eq!(exhausted.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(error_code(&exhausted).as_deref(), Some("too_many_attempts"));

    for _ in 0..5 {
        assert_eq!(
            harness
                .post(
                    &prepare_path,
                    json!({ "affiliation_email_address": "throttled@acme.test" })
                )
                .await
                .status,
            StatusCode::OK
        );
    }
    let throttled = harness
        .post(
            &prepare_path,
            json!({ "affiliation_email_address": "throttled@acme.test" }),
        )
        .await;
    assert_eq!(throttled.status, StatusCode::TOO_MANY_REQUESTS);
    assert_eq!(
        error_code(&throttled).as_deref(),
        Some("rate_limit_exceeded")
    );
}

#[tokio::test]
async fn manages_membership_requests() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let applicant = create_user(&harness).await;
    let org = create_org(&harness, json!({ "name": "Acme", "created_by": owner })).await;
    let org_id = id_of(&org);

    let request = harness
        .post(
            &format!("/v1/organizations/{org_id}/membership_requests"),
            json!({ "user_id": applicant }),
        )
        .await;
    assert_eq!(request.status, StatusCode::OK, "{}", request.text());
    assert_eq!(request.value()["status"], json!("pending"));
    assert_eq!(
        harness
            .get(&format!(
                "/v1/organizations/{org_id}/membership_requests?status=pending"
            ))
            .await
            .value()["total_count"],
        json!(1)
    );
    let request_id = id_of(&request.value());
    let accepted = harness
        .post_empty(&format!(
            "/v1/organizations/{org_id}/membership_requests/{request_id}/accept"
        ))
        .await;
    assert_eq!(accepted.status, StatusCode::OK, "{}", accepted.text());
    assert_eq!(
        accepted.value()["public_user_data"]["user_id"],
        json!(applicant)
    );
    assert_eq!(
        harness
            .get(&format!("/v1/users/{applicant}/organization_memberships"))
            .await
            .value()["total_count"],
        json!(1)
    );
}

#[tokio::test]
async fn manages_roles_and_permissions_with_system_guards() {
    let harness = setup().await;
    let owner = create_user(&harness).await;
    let member = create_user(&harness).await;
    let org = create_org(
        &harness,
        json!({ "name": "Acme", "created_by": owner, "max_allowed_memberships": 10 }),
    )
    .await;
    let org_id = id_of(&org);

    for (key, status) in [
        ("support", 422),
        ("org:sys_support", 422),
        ("org:admin", 409),
    ] {
        assert_eq!(
            harness
                .post("/v1/roles", json!({ "key": key, "name": "Support" }))
                .await
                .status,
            StatusCode::from_u16(status).unwrap(),
            "{key}"
        );
    }

    let role = harness
        .post(
            "/v1/roles",
            json!({
                "key": "org:support",
                "name": "Support",
                "permissions": ["org:sys_memberships:read"],
            }),
        )
        .await;
    assert_eq!(role.status, StatusCode::OK, "{}", role.text());
    assert_eq!(
        keys(&role.value()["permissions"]),
        vec!["org:sys_memberships:read"]
    );
    let role_id = id_of(&role.value());

    let permission = harness
        .post(
            "/v1/permissions",
            json!({ "key": "org:invoices:manage", "name": "Manage invoices" }),
        )
        .await;
    assert_eq!(permission.status, StatusCode::OK, "{}", permission.text());
    assert_eq!(permission.value()["type"], json!("user"));
    assert_eq!(
        harness
            .post(
                "/v1/permissions",
                json!({ "key": "org:sys_invoices:manage", "name": "Nope" }),
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    let permission_id = id_of(&permission.value());

    let assigned = harness
        .post(
            &format!("/v1/roles/{role_id}/permissions"),
            json!({ "permissions": ["org:sys_memberships:read", "org:invoices:manage"] }),
        )
        .await;
    let mut assigned_keys = keys(&assigned.value()["permissions"]);
    assigned_keys.sort();
    assert_eq!(
        assigned_keys,
        vec!["org:invoices:manage", "org:sys_memberships:read"]
    );
    let removed = harness
        .delete(&format!("/v1/roles/{role_id}/permissions/{permission_id}"))
        .await;
    assert_eq!(
        keys(&removed.value()["permissions"]),
        vec!["org:sys_memberships:read"]
    );

    let org_roles = harness
        .get(&format!("/v1/organizations/{org_id}/roles?limit=100"))
        .await;
    assert!(org_roles.value()["total_count"].as_i64().unwrap() >= 3);
    let org_role_keys = keys(&org_roles.value()["data"]);
    for expected in ["org:admin", "org:member", "org:support"] {
        assert!(org_role_keys.contains(&expected.to_string()), "{expected}");
    }
    let role_list = harness.get("/v1/roles?query=org:").await;
    assert!(keys(&role_list.value()["data"]).contains(&"org:support".to_string()));

    let system_role = role_list.value()["data"]
        .as_array()
        .unwrap()
        .iter()
        .find(|role| role["key"] == json!("org:admin"))
        .unwrap()
        .clone();
    let system_role_id = id_of(&system_role);
    assert_eq!(
        harness
            .patch(
                &format!("/v1/roles/{system_role_id}"),
                json!({ "name": "Root" })
            )
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        harness
            .delete(&format!("/v1/roles/{system_role_id}"))
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    let system_permission =
        harness.get("/v1/permissions?type=system").await.value()["data"][0].clone();
    let system_permission_id = id_of(&system_permission);
    assert_eq!(
        harness
            .patch(
                &format!("/v1/permissions/{system_permission_id}"),
                json!({ "name": "Nope" }),
            )
            .await
            .status,
        StatusCode::FORBIDDEN
    );
    assert_eq!(
        harness
            .delete(&format!("/v1/permissions/{system_permission_id}"))
            .await
            .status,
        StatusCode::FORBIDDEN
    );

    let membership = harness
        .post(
            &format!("/v1/organizations/{org_id}/memberships"),
            json!({ "user_id": member, "role": "org:support" }),
        )
        .await;
    assert_eq!(membership.status, StatusCode::OK, "{}", membership.text());
    let in_use = harness.delete(&format!("/v1/roles/{role_id}")).await;
    assert_eq!(in_use.status, StatusCode::FORBIDDEN);
    assert_eq!(error_code(&in_use).as_deref(), Some("not_allowed_access"));

    harness
        .delete(&format!("/v1/organizations/{org_id}/memberships/{member}"))
        .await;
    assert_eq!(
        harness.delete(&format!("/v1/roles/{role_id}")).await.status,
        StatusCode::OK
    );

    let creator = harness
        .post(
            "/v1/roles",
            json!({ "key": "org:owner", "name": "Owner", "is_creator_eligible": true }),
        )
        .await
        .value();
    harness
        .state()
        .settings
        .update(json!({ "organizations": { "creatorRole": "org:owner" } }))
        .await
        .expect("settings");
    assert_eq!(
        harness
            .delete(&format!("/v1/roles/{}", id_of(&creator)))
            .await
            .status,
        StatusCode::FORBIDDEN
    );

    assert_eq!(
        harness
            .delete(&format!("/v1/permissions/{permission_id}"))
            .await
            .value()["deleted"],
        json!(true)
    );
}

#[tokio::test]
async fn refuses_unauthenticated_backend_calls() {
    let harness = setup().await;
    let response = harness.client.get("/v1/organizations", &[]).await;
    assert_eq!(response.status, StatusCode::UNAUTHORIZED);
    assert_eq!(error_code(&response).as_deref(), Some("secret_key_invalid"));
}
