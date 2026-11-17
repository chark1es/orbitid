//! HTTP tests for the organization Frontend API (`test/orgs/{rbac,invitations,
//! domains,logo,frontend-metadata,invitation-details}.test.ts`).

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_platform::mail::{latest_code_for, latest_email, EmailTemplate};
use serde_json::{json, Value};

async fn enable_organizations(h: &Harness) {
    h.state()
        .settings
        .update(json!({
            "organizations": {
                "enabled": true,
                "domainsEnabled": true,
                "membershipRequestsEnabled": true,
                "adminDeleteEnabled": true
            }
        }))
        .await
        .expect("settings");
}

async fn create_org(
    client: &orbitid_core::testing::TestClient,
    name: &str,
    slug: Option<&str>,
) -> Value {
    let mut body = json!({ "name": name });
    if let Some(slug) = slug {
        body["slug"] = json!(slug);
    }
    let response = client
        .request("POST", "/v1/client/organizations", Some(body), &[])
        .await;
    assert_status(&response, StatusCode::OK);
    response.value()["response"].clone()
}

async fn invite(client: &orbitid_core::testing::TestClient, org_id: &str, email: &str) -> Value {
    let response = client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({ "email_address": email })),
            &[],
        )
        .await;
    assert_status(&response, StatusCode::OK);
    response.value()["response"].clone()
}

fn ticket_from_email(h: &Harness, to: &str) -> String {
    let mail = latest_email(h.state(), to, Some(EmailTemplate::OrganizationInvitation))
        .expect("invitation email");
    let url = mail
        .vars
        .get("invitation_url")
        .and_then(Value::as_str)
        .expect("url");
    let parsed = url::Url::parse(url).expect("valid url");
    parsed
        .query_pairs()
        .find(|(key, _)| key == "ticket")
        .map(|(_, value)| value.to_string())
        .expect("ticket")
}

#[tokio::test]
async fn creates_organizations_and_rejects_duplicate_or_invalid_slugs() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("owner@acme.test", "Sup3r-secret!").await;

    let org = create_org(&owner.client, "Acme Inc", Some("acme-inc")).await;
    assert_eq!(org["slug"], "acme-inc");
    assert_eq!(org["name"], "Acme Inc");
    assert_eq!(org["public_metadata"], json!({}));
    assert!(org.get("private_metadata").is_none());
    assert_eq!(org["members_count"], 1);

    let duplicate = owner
        .client
        .request(
            "POST",
            "/v1/client/organizations",
            Some(json!({ "name": "Other", "slug": "acme-inc" })),
            &[],
        )
        .await;
    assert_eq!(error_codes(&duplicate), vec!["organization_slug_taken"]);

    let derived = create_org(&owner.client, "Acme Inc", None).await;
    assert_eq!(derived["slug"], "acme-inc-2");

    let bad = owner
        .client
        .request(
            "POST",
            "/v1/client/organizations",
            Some(json!({ "name": "Bad", "slug": "Not A Slug" })),
            &[],
        )
        .await;
    assert_eq!(bad.status, StatusCode::UNPROCESSABLE_ENTITY);

    // Frontend writes never touch metadata.
    let sneaky = owner
        .client
        .request(
            "POST",
            "/v1/client/organizations",
            Some(json!({
                "name": "Sneaky",
                "public_metadata": { "plan": "enterprise" },
                "private_metadata": { "billing": "free" }
            })),
            &[],
        )
        .await;
    assert_eq!(sneaky.value()["response"]["public_metadata"], json!({}));
    let id = sneaky.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let stored: (sqlx::types::Json<Value>, sqlx::types::Json<Value>) =
        sqlx::query_as("SELECT public_metadata, private_metadata FROM organizations WHERE id = $1")
            .bind(&id)
            .fetch_one(&h.state().pool)
            .await
            .expect("org row");
    assert_eq!(stored.0 .0, json!({}));
    assert_eq!(stored.1 .0, json!({}));
}

#[tokio::test]
async fn organization_settings_and_creation_limits_are_enforced() {
    let h = harness().await;
    let user = h.signed_in("disabled@acme.test", "Sup3r-secret!").await;
    let disabled = user
        .client
        .request(
            "POST",
            "/v1/client/organizations",
            Some(json!({ "name": "Acme" })),
            &[],
        )
        .await;
    assert_eq!(disabled.status, StatusCode::FORBIDDEN);
    assert_eq!(error_codes(&disabled), vec!["organizations_disabled"]);
    let list = get_json(&user.client, "/v1/client/me/organization_memberships").await;
    assert_eq!(list.status, StatusCode::FORBIDDEN);
    assert_eq!(error_codes(&list), vec!["organizations_disabled"]);

    h.state()
        .settings
        .update(
            json!({ "organizations": { "enabled": true, "maxCreatedOrganizationsPerUser": 1 } }),
        )
        .await
        .expect("settings");
    create_org(&user.client, "One", None).await;
    let second = user
        .client
        .request(
            "POST",
            "/v1/client/organizations",
            Some(json!({ "name": "Two" })),
            &[],
        )
        .await;
    assert_eq!(second.status, StatusCode::FORBIDDEN);
    assert_eq!(
        error_codes(&second),
        vec!["organization_creation_not_allowed"]
    );

    let blocked = h.signed_in("blocked@acme.test", "Sup3r-secret!").await;
    sqlx::query("UPDATE users SET create_organization_enabled = false WHERE id = $1")
        .bind(&blocked.user_id)
        .execute(&h.state().pool)
        .await
        .expect("update");
    let response = blocked
        .client
        .request(
            "POST",
            "/v1/client/organizations",
            Some(json!({ "name": "Nope" })),
            &[],
        )
        .await;
    assert_eq!(
        error_codes(&response),
        vec!["organization_creation_not_allowed"]
    );
}

#[tokio::test]
async fn rbac_gates_every_organization_endpoint() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("rbac-owner@acme.test", "Sup3r-secret!").await;
    let org = create_org(&owner.client, "Acme", Some("acme")).await;
    let org_id = org["id"].as_str().expect("id").to_string();

    let member = h.signed_in("rbac-member@acme.test", "Sup3r-secret!").await;
    let invitation = invite(&owner.client, &org_id, "rbac-member@acme.test").await;
    let accepted = member
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/me/organization_invitations/{}/accept",
                invitation["id"].as_str().expect("id")
            ),
            None,
            &[],
        )
        .await;
    assert_status(&accepted, StatusCode::OK);
    assert_eq!(accepted.value()["response"]["role"], "org:member");

    for path in [
        format!("/v1/client/organizations/{org_id}"),
        format!("/v1/client/organizations/{org_id}/memberships"),
        format!("/v1/client/organizations/{org_id}/roles"),
        format!("/v1/client/organizations/{org_id}/domains"),
    ] {
        let response = get_json(&member.client, &path).await;
        assert_status(&response, StatusCode::OK);
    }

    let rename = member
        .client
        .request(
            "PATCH",
            &format!("/v1/client/organizations/{org_id}"),
            Some(json!({ "name": "Nope" })),
            &[],
        )
        .await;
    assert_eq!(rename.status, StatusCode::FORBIDDEN);
    assert_eq!(error_codes(&rename), vec!["org_permission_required"]);
    assert_eq!(
        rename.value()["errors"][0]["meta"]["permission"],
        "org:sys_profile:manage"
    );

    let invite_attempt = member
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({ "email_address": "x@acme.test" })),
            &[],
        )
        .await;
    assert_eq!(
        error_codes(&invite_attempt),
        vec!["org_permission_required"]
    );

    let domain_attempt = member
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/domains"),
            Some(json!({ "name": "acme.test" })),
            &[],
        )
        .await;
    assert_eq!(domain_attempt.status, StatusCode::FORBIDDEN);

    let delete_attempt = member
        .client
        .request(
            "DELETE",
            &format!("/v1/client/organizations/{org_id}"),
            None,
            &[],
        )
        .await;
    assert_eq!(delete_attempt.status, StatusCode::FORBIDDEN);

    let outsider = h
        .signed_in("rbac-outsider@acme.test", "Sup3r-secret!")
        .await;
    let denied = get_json(
        &outsider.client,
        &format!("/v1/client/organizations/{org_id}"),
    )
    .await;
    assert_eq!(denied.status, StatusCode::NOT_FOUND);
    assert_eq!(error_codes(&denied), vec!["not_a_member_in_organization"]);

    // Unauthenticated requests never reach the organization.
    let anonymous = h.client();
    let denied = get_json(&anonymous, &format!("/v1/client/organizations/{org_id}")).await;
    assert_eq!(denied.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn protects_the_last_admin_and_allows_members_to_leave() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("solo-owner@acme.test", "Sup3r-secret!").await;
    let org = create_org(&owner.client, "Solo", None).await;
    let org_id = org["id"].as_str().expect("id").to_string();

    let leave = owner
        .client
        .request(
            "DELETE",
            &format!("/v1/client/me/organization_memberships/{org_id}"),
            None,
            &[],
        )
        .await;
    assert_eq!(leave.status, StatusCode::FORBIDDEN);
    assert_eq!(
        error_codes(&leave),
        vec!["organization_minimum_permissions_needed"]
    );

    let demote = owner
        .client
        .request(
            "PATCH",
            &format!(
                "/v1/client/organizations/{org_id}/memberships/{}",
                owner.user_id
            ),
            Some(json!({ "role": "org:member" })),
            &[],
        )
        .await;
    assert_eq!(demote.status, StatusCode::FORBIDDEN);
    assert_eq!(
        error_codes(&demote),
        vec!["organization_minimum_permissions_needed"]
    );

    let remove = owner
        .client
        .request(
            "DELETE",
            &format!(
                "/v1/client/organizations/{org_id}/memberships/{}",
                owner.user_id
            ),
            None,
            &[],
        )
        .await;
    assert_eq!(remove.status, StatusCode::FORBIDDEN);

    // A second admin can take over.
    let second = h.signed_in("solo-second@acme.test", "Sup3r-secret!").await;
    let invitation = invite(&owner.client, &org_id, "solo-second@acme.test").await;
    let response = owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/invitations/{}/revoke",
                invitation["id"].as_str().expect("id")
            ),
            None,
            &[],
        )
        .await;
    assert_status(&response, StatusCode::OK);
    let invitation = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({
                "email_address": "solo-second@acme.test",
                "role": "org:admin"
            })),
            &[],
        )
        .await;
    assert_status(&invitation, StatusCode::OK);
    let admin_invitation = invitation.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let accepted = second
        .client
        .request(
            "POST",
            &format!("/v1/client/me/organization_invitations/{admin_invitation}/accept"),
            None,
            &[],
        )
        .await;
    assert_status(&accepted, StatusCode::OK);
    assert_eq!(accepted.value()["response"]["role"], "org:admin");

    let demote_first = second
        .client
        .request(
            "PATCH",
            &format!(
                "/v1/client/organizations/{org_id}/memberships/{}",
                owner.user_id
            ),
            Some(json!({ "role": "org:member" })),
            &[],
        )
        .await;
    assert_status(&demote_first, StatusCode::OK);
    assert_eq!(demote_first.value()["response"]["role"], "org:member");

    let leave_last = second
        .client
        .request(
            "DELETE",
            &format!("/v1/client/me/organization_memberships/{org_id}"),
            None,
            &[],
        )
        .await;
    assert_eq!(leave_last.status, StatusCode::FORBIDDEN);
    let member_leave = owner
        .client
        .request(
            "DELETE",
            &format!("/v1/client/me/organization_memberships/{org_id}"),
            None,
            &[],
        )
        .await;
    assert_status(&member_leave, StatusCode::OK);
    assert_eq!(
        member_leave.value()["response"]["object"],
        "organization_membership"
    );
}

#[tokio::test]
async fn lists_memberships_with_the_active_organization_first_and_paginates() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("active-owner@acme.test", "Sup3r-secret!").await;
    let alpha = create_org(&owner.client, "Alpha", None).await;
    let beta = create_org(&owner.client, "Beta", None).await;

    let response =
        sqlx::query("UPDATE sessions SET last_active_organization_id = $1 WHERE id = $2")
            .bind(alpha["id"].as_str().expect("id"))
            .bind(&owner.auth.session.id)
            .execute(&h.state().pool)
            .await;
    assert!(response.is_ok());

    let list = get_json(&owner.client, "/v1/client/me/organization_memberships").await;
    assert_status(&list, StatusCode::OK);
    let rows = list.value()["response"].as_array().expect("list").clone();
    assert_eq!(rows.len(), 2);
    assert_eq!(rows[0]["organization"]["id"], alpha["id"]);

    let paginated = get_json(
        &owner.client,
        "/v1/client/me/organization_memberships?paginated=true&limit=1",
    )
    .await;
    assert_eq!(paginated.value()["total_count"], 2);
    assert_eq!(paginated.value()["data"].as_array().map(Vec::len), Some(1));
    assert_eq!(
        paginated.value()["data"][0]["organization"]["id"],
        alpha["id"]
    );
    assert_ne!(alpha["id"], beta["id"]);

    let filtered = get_json(
        &owner.client,
        &format!(
            "/v1/client/organizations/{}/memberships?role=org:admin",
            alpha["id"].as_str().expect("id")
        ),
    )
    .await;
    assert_eq!(
        filtered.value()["response"].as_array().map(Vec::len),
        Some(1)
    );
}

#[tokio::test]
async fn invites_lists_revokes_and_accepts_invitations() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("inv-owner@acme.test", "Sup3r-secret!").await;
    let org = create_org(&owner.client, "Acme", None).await;
    let org_id = org["id"].as_str().expect("id").to_string();

    let invitation = invite(&owner.client, &org_id, "Invitee@Acme.test").await;
    assert_eq!(invitation["email_address"], "invitee@acme.test");
    assert_eq!(invitation["status"], "pending");
    assert_eq!(invitation["role"], "org:member");
    assert_eq!(invitation["role_name"], "Member");
    assert!(invitation.get("url").is_none());

    let mail = latest_email(
        h.state(),
        "invitee@acme.test",
        Some(EmailTemplate::OrganizationInvitation),
    )
    .expect("mail");
    assert_eq!(mail.to, "invitee@acme.test");
    assert!(mail
        .vars
        .get("invitation_url")
        .and_then(Value::as_str)
        .expect("url")
        .contains("/v1/client/organization_invitations/accept?ticket="));
    assert_eq!(mail.vars.get("organization_name"), Some(&json!("Acme")));

    let duplicate = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({ "email_address": "invitee@acme.test" })),
            &[],
        )
        .await;
    assert_eq!(duplicate.status, StatusCode::CONFLICT);
    assert_eq!(error_codes(&duplicate), vec!["duplicate_record"]);

    let bad_role = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({ "email_address": "other@acme.test", "role": "org:nope" })),
            &[],
        )
        .await;
    assert_eq!(bad_role.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&bad_role), vec!["org_role_not_found"]);

    let list = get_json(
        &owner.client,
        &format!("/v1/client/organizations/{org_id}/invitations"),
    )
    .await;
    assert_eq!(list.value()["response"].as_array().map(Vec::len), Some(1));
    assert_eq!(list.value()["response"][0]["id"], invitation["id"]);

    let pending_only = get_json(
        &owner.client,
        &format!("/v1/client/organizations/{org_id}/invitations?status=pending"),
    )
    .await;
    assert_eq!(
        pending_only.value()["response"].as_array().map(Vec::len),
        Some(1)
    );

    let revoked = owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/invitations/{}/revoke",
                invitation["id"].as_str().expect("id")
            ),
            None,
            &[],
        )
        .await;
    assert_status(&revoked, StatusCode::OK);
    assert_eq!(revoked.value()["response"]["status"], "revoked");
    let again = owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/invitations/{}/revoke",
                invitation["id"].as_str().expect("id")
            ),
            None,
            &[],
        )
        .await;
    assert_eq!(again.status, StatusCode::CONFLICT);

    let invitee = h.signed_in("invitee@acme.test", "Sup3r-secret!").await;
    let accept_after_revoke = invitee
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/me/organization_invitations/{}/accept",
                invitation["id"].as_str().expect("id")
            ),
            None,
            &[],
        )
        .await;
    assert_eq!(accept_after_revoke.status, StatusCode::CONFLICT);
}

#[tokio::test]
async fn accepts_invitations_from_the_users_endpoints_and_ticket_link() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("link-owner@acme.test", "Sup3r-secret!").await;
    let org = create_org(&owner.client, "Acme", None).await;
    let org_id = org["id"].as_str().expect("id").to_string();

    let invitee = h.signed_in("link-invitee@acme.test", "Sup3r-secret!").await;
    let invitation = invite(&owner.client, &org_id, "link-invitee@acme.test").await;
    let ticket = ticket_from_email(&h, "link-invitee@acme.test");

    let mine = get_json(&invitee.client, "/v1/client/me/organization_invitations").await;
    assert_eq!(
        mine.value()["response"]
            .as_array()
            .expect("list")
            .iter()
            .map(|row| row["id"].clone())
            .collect::<Vec<_>>(),
        vec![invitation["id"].clone()]
    );
    assert_eq!(mine.value()["response"][0]["organization_name"], "Acme");
    assert_eq!(mine.value()["response"][0]["organization_id"], org_id);

    let stranger = h
        .signed_in("link-stranger@acme.test", "Sup3r-secret!")
        .await;
    let stolen = stranger
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/me/organization_invitations/{}/accept",
                invitation["id"].as_str().expect("id")
            ),
            None,
            &[],
        )
        .await;
    assert_eq!(stolen.status, StatusCode::FORBIDDEN);

    // Anonymous ticket link redirects without joining.
    let anonymous = h.client();
    let redirect = anonymous
        .request(
            "GET",
            &format!("/v1/client/organization_invitations/accept?ticket={ticket}"),
            None,
            &[],
        )
        .await;
    assert_eq!(redirect.status, StatusCode::FOUND);
    assert!(!redirect
        .headers
        .get("location")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .contains("__orbit_ticket="));

    // Untrusted redirect origins are refused.
    let hostile = anonymous
        .request(
            "GET",
            &format!(
                "/v1/client/organization_invitations/accept?ticket={ticket}&redirect_url=https%3A%2F%2Fevil.example%2Fsteal"
            ),
            None,
            &[],
        )
        .await;
    assert_eq!(hostile.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(hostile.headers.get("location").is_none());

    // An authenticated matching user is joined before the redirect.
    let authenticated = invitee
        .client
        .request(
            "GET",
            &format!("/v1/client/organization_invitations/accept?ticket={ticket}"),
            None,
            &[],
        )
        .await;
    assert_eq!(authenticated.status, StatusCode::FOUND);
    let members = get_json(
        &owner.client,
        &format!("/v1/client/organizations/{org_id}/memberships"),
    )
    .await;
    assert!(members.value()["response"]
        .as_array()
        .expect("members")
        .iter()
        .any(|row| row["public_user_data"]["user_id"] == invitee.user_id));

    // Accepting through the user's endpoint also works.
    let second = h.signed_in("link-second@acme.test", "Sup3r-secret!").await;
    let invitation = invite(&owner.client, &org_id, "link-second@acme.test").await;
    let accepted = second
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/me/organization_invitations/{}/accept",
                invitation["id"].as_str().expect("id")
            ),
            None,
            &[],
        )
        .await;
    assert_status(&accepted, StatusCode::OK);
    assert_eq!(accepted.value()["response"]["organization"]["id"], org_id);
    assert_eq!(accepted.value()["response"]["role"], "org:member");
}

#[tokio::test]
async fn supports_bulk_invitations_and_reports_pending_invitations() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("bulk-owner@acme.test", "Sup3r-secret!").await;
    let org = create_org(&owner.client, "Acme", None).await;
    let org_id = org["id"].as_str().expect("id").to_string();

    let bulk = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({
                "email_addresses": ["a@acme.test", "b@acme.test"],
                "role": "org:admin"
            })),
            &[],
        )
        .await;
    assert_status(&bulk, StatusCode::OK);
    let created = bulk.value()["response"].as_array().expect("list").clone();
    assert_eq!(created.len(), 2);
    assert!(created.iter().all(|row| row["role"] == "org:admin"));

    let again = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({ "email_addresses": ["a@acme.test", "b@acme.test"] })),
            &[],
        )
        .await;
    assert_eq!(again.value()["response"].as_array().map(Vec::len), Some(0));

    let missing = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({})),
            &[],
        )
        .await;
    assert_eq!(missing.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&missing), vec!["form_param_missing"]);
}

#[tokio::test]
async fn domains_are_added_verified_and_auto_enrol_members() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("domain-owner@acme.test", "Sup3r-secret!").await;
    let org = create_org(&owner.client, "Acme", None).await;
    let org_id = org["id"].as_str().expect("id").to_string();

    let existing = h.signed_in("existing@auto.test", "Sup3r-secret!").await;
    let _unverified =
        orbitid_identity::testing::create_test_unverified_user(h.state(), "unverified@auto.test")
            .await
            .expect("unverified user");
    let domain = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/domains"),
            Some(json!({ "name": "Auto.Test", "enrollment_mode": "automatic_invitation" })),
            &[],
        )
        .await;
    assert_status(&domain, StatusCode::OK);
    assert_eq!(domain.value()["response"]["name"], "auto.test");
    let domain_id = domain.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();

    let invalid = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/domains"),
            Some(json!({ "name": "not a domain" })),
            &[],
        )
        .await;
    assert_eq!(invalid.status, StatusCode::UNPROCESSABLE_ENTITY);
    let duplicate = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/domains"),
            Some(json!({ "name": "auto.test" })),
            &[],
        )
        .await;
    assert_eq!(duplicate.status, StatusCode::CONFLICT);

    let mismatch = owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/domains/{domain_id}/prepare_affiliation_verification"
            ),
            Some(json!({ "affiliation_email_address": "admin@other.com" })),
            &[],
        )
        .await;
    assert_eq!(mismatch.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&mismatch), vec!["form_param_value_invalid"]);

    let prepared = owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/domains/{domain_id}/prepare_affiliation_verification"
            ),
            Some(json!({ "affiliation_email_address": "Admin@Auto.Test" })),
            &[],
        )
        .await;
    assert_status(&prepared, StatusCode::OK);
    assert_eq!(
        prepared.value()["response"]["affiliation_email_address"],
        "admin@auto.test"
    );
    let code = latest_code_for(
        h.state(),
        "admin@auto.test",
        Some(EmailTemplate::DomainVerificationCode),
    )
    .expect("code");

    let wrong = owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/domains/{domain_id}/attempt_affiliation_verification"
            ),
            Some(json!({ "code": if code == "000000" { "111111" } else { "000000" } })),
            &[],
        )
        .await;
    assert_eq!(wrong.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&wrong), vec!["form_code_incorrect"]);

    let verified = owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/domains/{domain_id}/attempt_affiliation_verification"
            ),
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_status(&verified, StatusCode::OK);
    assert_eq!(
        verified.value()["response"]["verification"]["status"],
        "verified"
    );

    // The existing verified user is enrolled; the unverified one is not.
    let members = get_json(
        &owner.client,
        &format!("/v1/client/organizations/{org_id}/memberships"),
    )
    .await;
    let members_value = members.value();
    let user_ids: Vec<&str> = members_value["response"]
        .as_array()
        .expect("members")
        .iter()
        .filter_map(|row| row["public_user_data"]["user_id"].as_str())
        .collect();
    assert_eq!(user_ids.len(), 2);
    assert!(user_ids.contains(&existing.user_id.as_str()));

    // A future verified user joins when their address is verified (service hook).
    let newcomer = h.signed_in("newcomer@auto.test", "Sup3r-secret!").await;
    orbitid_identity::orgs::on_user_email_verified(
        h.state(),
        &newcomer.user_id,
        "newcomer@auto.test",
    )
    .await
    .expect("hook");
    let members = get_json(
        &owner.client,
        &format!("/v1/client/organizations/{org_id}/memberships"),
    )
    .await;
    assert!(members.value()["response"]
        .as_array()
        .expect("members")
        .iter()
        .any(|row| row["public_user_data"]["user_id"] == newcomer.user_id));

    let removed = owner
        .client
        .request(
            "DELETE",
            &format!("/v1/client/organizations/{org_id}/domains/{domain_id}"),
            None,
            &[],
        )
        .await;
    assert_status(&removed, StatusCode::OK);
    assert_eq!(removed.value()["response"]["deleted"], true);
}

#[tokio::test]
async fn suggestions_and_membership_requests_join_verified_domains() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h
        .signed_in("suggest-owner@acme.test", "Sup3r-secret!")
        .await;
    let org = create_org(&owner.client, "Suggestions Inc", None).await;
    let org_id = org["id"].as_str().expect("id").to_string();

    let domain = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/domains"),
            Some(json!({ "name": "suggest.test", "enrollment_mode": "automatic_suggestion" })),
            &[],
        )
        .await;
    assert_status(&domain, StatusCode::OK);
    let domain_id = domain.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/domains/{domain_id}/prepare_affiliation_verification"
            ),
            Some(json!({ "affiliation_email_address": "admin@suggest.test" })),
            &[],
        )
        .await;
    let code = latest_code_for(
        h.state(),
        "admin@suggest.test",
        Some(EmailTemplate::DomainVerificationCode),
    )
    .expect("code");
    let verified = owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/domains/{domain_id}/attempt_affiliation_verification"
            ),
            Some(json!({ "code": code })),
            &[],
        )
        .await;
    assert_status(&verified, StatusCode::OK);

    let user = h.signed_in("person@suggest.test", "Sup3r-secret!").await;
    let suggestions = get_json(&user.client, "/v1/client/me/organization_suggestions").await;
    assert_status(&suggestions, StatusCode::OK);
    let rows = suggestions.value()["response"]
        .as_array()
        .expect("list")
        .clone();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["public_organization_data"]["id"], org_id);
    assert_eq!(rows[0]["status"], "pending");
    let suggestion_id = rows[0]["id"].as_str().expect("suggestion id").to_string();

    let accepted = user
        .client
        .request(
            "POST",
            &format!("/v1/client/me/organization_suggestions/{suggestion_id}/accept"),
            None,
            &[],
        )
        .await;
    assert_status(&accepted, StatusCode::OK);
    assert_eq!(accepted.value()["response"]["organization"]["id"], org_id);

    let after = get_json(&user.client, "/v1/client/me/organization_suggestions").await;
    assert_eq!(after.value()["response"].as_array().map(Vec::len), Some(0));

    // Direct joins through /me/organization_memberships for suggestion domains.
    let colleague = h.signed_in("colleague@suggest.test", "Sup3r-secret!").await;
    let joined = colleague
        .client
        .request(
            "POST",
            "/v1/client/me/organization_memberships",
            Some(json!({ "organization_id": org_id })),
            &[],
        )
        .await;
    assert_status(&joined, StatusCode::OK);
    let duplicate = colleague
        .client
        .request(
            "POST",
            "/v1/client/me/organization_memberships",
            Some(json!({ "organization_id": org_id })),
            &[],
        )
        .await;
    assert_eq!(duplicate.status, StatusCode::CONFLICT);

    // Membership requests.
    let applicant = h.signed_in("applicant@suggest.test", "Sup3r-secret!").await;
    let request = applicant
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/membership_requests"),
            None,
            &[],
        )
        .await;
    assert_status(&request, StatusCode::OK);
    assert_eq!(request.value()["response"]["status"], "pending");
    assert_eq!(
        request.value()["response"]["public_user_data"]["user_id"],
        applicant.user_id
    );
    let request_id = request.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let duplicate = applicant
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/membership_requests"),
            None,
            &[],
        )
        .await;
    assert_eq!(duplicate.value()["response"]["id"], request_id);

    let pending = get_json(
        &owner.client,
        &format!("/v1/client/organizations/{org_id}/membership_requests?status=pending"),
    )
    .await;
    assert_eq!(
        pending.value()["response"].as_array().map(Vec::len),
        Some(1)
    );

    let accepted = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/membership_requests/{request_id}/accept"),
            None,
            &[],
        )
        .await;
    assert_status(&accepted, StatusCode::OK);
    assert_eq!(
        accepted.value()["response"]["public_user_data"]["user_id"],
        applicant.user_id
    );

    let outsider = h
        .signed_in("outsider@elsewhere.test", "Sup3r-secret!")
        .await;
    let blocked = outsider
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/membership_requests"),
            None,
            &[],
        )
        .await;
    assert_eq!(blocked.status, StatusCode::FORBIDDEN);

    let rejectee = h.signed_in("rejectee@suggest.test", "Sup3r-secret!").await;
    let to_reject = rejectee
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/membership_requests"),
            None,
            &[],
        )
        .await;
    let reject_id = to_reject.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    let rejected = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/membership_requests/{reject_id}/reject"),
            None,
            &[],
        )
        .await;
    assert_status(&rejected, StatusCode::OK);
    assert_eq!(rejected.value()["response"]["status"], "rejected");
    let members = get_json(
        &owner.client,
        &format!("/v1/client/organizations/{org_id}/memberships"),
    )
    .await;
    assert!(!members.value()["response"]
        .as_array()
        .expect("members")
        .iter()
        .any(|row| row["public_user_data"]["user_id"] == rejectee.user_id));
}

#[tokio::test]
async fn updates_enrollment_mode_and_deletes_pending_invitations() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("switch-owner@acme.test", "Sup3r-secret!").await;
    let org = create_org(&owner.client, "Switch Inc", None).await;
    let org_id = org["id"].as_str().expect("id").to_string();

    let domain = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/domains"),
            Some(json!({ "name": "switch.test", "enrollment_mode": "manual_invitation" })),
            &[],
        )
        .await;
    let domain_id = domain.value()["response"]["id"]
        .as_str()
        .expect("id")
        .to_string();
    owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/domains/{domain_id}/prepare_affiliation_verification"
            ),
            Some(json!({ "affiliation_email_address": "admin@switch.test" })),
            &[],
        )
        .await;
    let code = latest_code_for(
        h.state(),
        "admin@switch.test",
        Some(EmailTemplate::DomainVerificationCode),
    )
    .expect("code");
    owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/domains/{domain_id}/attempt_affiliation_verification"
            ),
            Some(json!({ "code": code })),
            &[],
        )
        .await;

    let member = h.signed_in("member@switch.test", "Sup3r-secret!").await;
    invite(&owner.client, &org_id, "pending@switch.test").await;

    let updated = owner
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/organizations/{org_id}/domains/{domain_id}/update_enrollment_mode"
            ),
            Some(json!({ "enrollment_mode": "automatic_invitation", "delete_pending": true })),
            &[],
        )
        .await;
    assert_status(&updated, StatusCode::OK);
    assert_eq!(
        updated.value()["response"]["enrollment_mode"],
        "automatic_invitation"
    );

    let invitations = get_json(
        &owner.client,
        &format!("/v1/client/organizations/{org_id}/invitations"),
    )
    .await;
    assert_eq!(
        invitations.value()["response"].as_array().map(Vec::len),
        Some(0)
    );
    let members = get_json(
        &owner.client,
        &format!("/v1/client/organizations/{org_id}/memberships"),
    )
    .await;
    assert!(members.value()["response"]
        .as_array()
        .expect("members")
        .iter()
        .any(|row| row["public_user_data"]["user_id"] == member.user_id));
}

#[tokio::test]
async fn domains_are_gated_by_settings() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({ "organizations": { "enabled": true, "domainsEnabled": false } }))
        .await
        .expect("settings");
    let owner = h.signed_in("gated-owner@acme.test", "Sup3r-secret!").await;
    let org = create_org(&owner.client, "Acme", None).await;
    let org_id = org["id"].as_str().expect("id");
    let response = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/domains"),
            Some(json!({ "name": "acme.test" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(error_codes(&response), vec!["not_allowed_access"]);
}

#[tokio::test]
async fn logos_are_uploaded_replaced_served_and_deleted() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("logo-owner@acme.test", "Sup3r-secret!").await;
    let org = create_org(&owner.client, "Acme", None).await;
    let org_id = org["id"].as_str().expect("id").to_string();

    let uploaded = owner
        .client
        .request(
            "PUT",
            &format!("/v1/client/organizations/{org_id}/logo"),
            Some(json!({ "file": data_url("image/png", PNG_1X1) })),
            &[],
        )
        .await;
    assert_status(&uploaded, StatusCode::OK);
    assert_eq!(uploaded.value()["response"]["has_image"], true);
    let image_url = uploaded.value()["response"]["image_url"]
        .as_str()
        .expect("image url")
        .to_string();
    assert!(image_url.contains("/v1/client/organization_logos/"));
    let file = image_url
        .split("/v1/client/organization_logos/")
        .nth(1)
        .expect("file");
    assert!(file.ends_with(".png"));

    let served = owner
        .client
        .get(&format!("/v1/client/organization_logos/{file}"), &[])
        .await;
    assert_status(&served, StatusCode::OK);
    assert_eq!(served.headers.get("content-type").unwrap(), "image/png");
    assert_eq!(
        served.headers.get("x-content-type-options").unwrap(),
        "nosniff"
    );
    assert_eq!(
        served.headers.get("content-security-policy").unwrap(),
        "sandbox"
    );

    let replaced = owner
        .client
        .request(
            "PUT",
            &format!("/v1/client/organizations/{org_id}/logo"),
            Some(json!({ "file": data_url("image/png", PNG_1X1) })),
            &[],
        )
        .await;
    assert_ne!(replaced.value()["response"]["image_url"], json!(image_url));
    let gone = owner
        .client
        .get(&format!("/v1/client/organization_logos/{file}"), &[])
        .await;
    assert_eq!(gone.status, StatusCode::NOT_FOUND);

    let unsupported = owner
        .client
        .request(
            "PUT",
            &format!("/v1/client/organizations/{org_id}/logo"),
            Some(json!({ "file": data_url("text/plain", "aGk=") })),
            &[],
        )
        .await;
    assert_eq!(unsupported.status, StatusCode::UNPROCESSABLE_ENTITY);

    let svg = owner
        .client
        .request(
            "PUT",
            &format!("/v1/client/organizations/{org_id}/logo"),
            Some(json!({ "file": data_url("image/svg+xml", SVG_PAYLOAD) })),
            &[],
        )
        .await;
    assert_eq!(svg.status, StatusCode::UNPROCESSABLE_ENTITY);

    let removed = owner
        .client
        .request(
            "DELETE",
            &format!("/v1/client/organizations/{org_id}/logo"),
            None,
            &[],
        )
        .await;
    assert_status(&removed, StatusCode::OK);
    assert_eq!(removed.value()["response"]["has_image"], false);

    let traversal = owner
        .client
        .get("/v1/client/organization_logos/..%2F..%2Fetc%2Fpasswd", &[])
        .await;
    assert_eq!(traversal.status, StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn waits_for_waitlist_mode_and_normalizes_the_address() {
    let h = harness().await;
    let response = h
        .client()
        .request(
            "POST",
            "/v1/client/waitlist",
            Some(json!({ "email_address": "wait@example.com" })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&response), vec!["sign_up_mode_restricted"]);

    h.state()
        .settings
        .update(json!({ "signUp": { "mode": "waitlist" } }))
        .await
        .expect("settings");
    let client = h.client();
    let created = client
        .request(
            "POST",
            "/v1/client/waitlist",
            Some(json!({ "email_address": "Wait@Example.com " })),
            &[],
        )
        .await;
    assert_status(&created, StatusCode::OK);
    assert_eq!(
        created.value()["response"]["email_address"],
        "wait@example.com"
    );
    assert_eq!(created.value()["response"]["status"], "pending");
    assert_eq!(created.value()["response"]["object"], "waitlist_entry");

    let again = client
        .request(
            "POST",
            "/v1/client/waitlist",
            Some(json!({ "email_address": "wait@example.com" })),
            &[],
        )
        .await;
    assert_eq!(again.status, StatusCode::OK);
    assert_eq!(
        again.value()["response"]["id"],
        created.value()["response"]["id"]
    );

    let invalid = client
        .request(
            "POST",
            "/v1/client/waitlist",
            Some(json!({ "email_address": "not-an-email" })),
            &[],
        )
        .await;
    assert_eq!(invalid.status, StatusCode::UNPROCESSABLE_ENTITY);
}

#[tokio::test]
async fn pending_invitations_count_against_the_membership_quota() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({
            "organizations": {
                "enabled": true,
                "maxAllowedMemberships": 2
            }
        }))
        .await
        .expect("settings");
    let owner = h.signed_in("quota-owner@acme.test", "Sup3r-secret!").await;
    let org = create_org(&owner.client, "Acme", None).await;
    let org_id = org["id"].as_str().expect("id").to_string();
    assert_eq!(org["max_allowed_memberships"], 2);

    invite(&owner.client, &org_id, "first@acme.test").await;
    let blocked = owner
        .client
        .request(
            "POST",
            &format!("/v1/client/organizations/{org_id}/invitations"),
            Some(json!({ "email_address": "second@acme.test" })),
            &[],
        )
        .await;
    assert_eq!(blocked.status, StatusCode::FORBIDDEN);
    assert_eq!(
        error_codes(&blocked),
        vec!["organization_membership_quota_exceeded"]
    );
}

#[tokio::test]
async fn deletes_an_organization_and_respects_admin_delete_setting() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("delete-org@acme.test", "Sup3r-secret!").await;
    let member = h
        .signed_in("delete-org-member@acme.test", "Sup3r-secret!")
        .await;
    let org = create_org(&owner.client, "Delete Me", None).await;
    let org_id = org["id"].as_str().expect("id").to_string();
    let invitation = invite(&owner.client, &org_id, "delete-org-member@acme.test").await;
    let accepted = member
        .client
        .request(
            "POST",
            &format!(
                "/v1/client/me/organization_invitations/{}/accept",
                invitation["id"].as_str().expect("id")
            ),
            None,
            &[],
        )
        .await;
    assert_status(&accepted, StatusCode::OK);

    sqlx::query("UPDATE organizations SET admin_delete_enabled = false WHERE id = $1")
        .bind(&org_id)
        .execute(&h.state().pool)
        .await
        .expect("update");
    let disabled = owner
        .client
        .request(
            "DELETE",
            &format!("/v1/client/organizations/{org_id}"),
            None,
            &[],
        )
        .await;
    assert_eq!(disabled.status, StatusCode::FORBIDDEN);
    assert_eq!(error_codes(&disabled), vec!["not_allowed_access"]);

    sqlx::query("UPDATE organizations SET admin_delete_enabled = true WHERE id = $1")
        .bind(&org_id)
        .execute(&h.state().pool)
        .await
        .expect("update");
    let deleted = owner
        .client
        .request(
            "DELETE",
            &format!("/v1/client/organizations/{org_id}"),
            None,
            &[],
        )
        .await;
    assert_status(&deleted, StatusCode::OK);
    assert_eq!(
        deleted.value()["response"],
        json!({ "object": "organization", "id": org_id, "deleted": true })
    );
    let remaining: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organizations WHERE id = $1")
        .bind(&org_id)
        .fetch_one(&h.state().pool)
        .await
        .expect("count");
    assert_eq!(remaining, 0);
    let members: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM organization_memberships WHERE organization_id = $1",
    )
    .bind(&org_id)
    .fetch_one(&h.state().pool)
    .await
    .expect("count");
    assert_eq!(members, 0);
}

/// The current user's invitation list honours the documented pagination
/// contract instead of silently truncating at a fixed row count.
#[tokio::test]
async fn my_invitations_support_limit_offset_and_total_count() {
    let h = harness().await;
    enable_organizations(&h).await;
    let owner = h.signed_in("page-owner@acme.test", "Sup3r-secret!").await;
    let invitee = h.signed_in("page-invitee@acme.test", "Sup3r-secret!").await;
    let mut ids = Vec::new();
    for name in ["One", "Two", "Three"] {
        let org = create_org(&owner.client, name, None).await;
        let invitation = invite(
            &owner.client,
            org["id"].as_str().expect("org id"),
            "page-invitee@acme.test",
        )
        .await;
        ids.push(
            invitation["id"]
                .as_str()
                .expect("invitation id")
                .to_string(),
        );
    }

    let all = get_json(&invitee.client, "/v1/client/me/organization_invitations").await;
    assert_status(&all, StatusCode::OK);
    assert_eq!(all.value()["response"].as_array().map(Vec::len), Some(3));
    assert!(all.value()["total_count"].is_null());

    let page = get_json(
        &invitee.client,
        "/v1/client/me/organization_invitations?paginated=true&limit=2&offset=1",
    )
    .await;
    assert_status(&page, StatusCode::OK);
    assert_eq!(page.value()["total_count"], 3);
    assert_eq!(page.value()["data"].as_array().map(Vec::len), Some(2));
    for row in page.value()["data"].as_array().expect("page") {
        assert!(ids.iter().any(|id| row["id"] == id.as_str()));
    }
}
