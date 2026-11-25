//! Account-page routes (migration 0021): operator-configured billing portals on
//! organizations and OAuth applications, the billing-manager read route, and
//! the signed-in user's list of OAuth applications they may use.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::testing::{TestClient, TestResponse};
use orbitid_identity::testing::{add_test_member, create_test_organization, sign_up_user};
use serde_json::{json, Value};

async fn enable_organizations(e2e: &E2e) {
    e2e.state()
        .settings
        .update(json!({ "organizations": { "enabled": true } }))
        .await
        .expect("enable organizations");
}

struct Person {
    id: String,
    browser: TestClient,
}

async fn person(e2e: &E2e, email: &str) -> Person {
    let signed = sign_up_user(e2e.state(), email, "Sup3r-secret!")
        .await
        .expect("sign-up fixture");
    Person {
        id: signed.user.user.id.clone(),
        browser: e2e.browser_with_cookie(&signed.auth.cookie),
    }
}

fn codes(response: &TestResponse) -> Vec<String> {
    response.error_codes()
}

fn param(response: &TestResponse) -> Value {
    response.value()["errors"][0]["meta"]["param_name"].clone()
}

/// URLs every billing-portal write refuses with 422 on `billing_portal_url`.
/// (Private IP literals are refused too unless private networks are allowed,
/// which the test configuration does; see `safe_fetch::assert_public_url`.)
const REFUSED_URLS: [&str; 7] = [
    "http://billing.example.com/portal",
    "javascript:alert(1)",
    "ftp://billing.example.com/",
    "https://user:secret@billing.example.com/",
    "https://billing.example.com/a b",
    "not a url",
    "/relative/path",
];

#[tokio::test]
async fn organization_billing_portal_is_validated_and_backend_only() {
    let e2e = E2e::new().await;
    enable_organizations(&e2e).await;
    let owner = person(&e2e, "billing-owner@example.com").await;
    let org = create_test_organization(e2e.state(), "Acme", None, &owner.id)
        .await
        .unwrap();
    let path = format!("/v1/organizations/{}", org.id);

    let before = e2e.get(&path).await;
    assert_eq!(before.status, StatusCode::OK, "{}", before.text());
    assert_eq!(before.value()["billing_portal_url"], Value::Null);

    for url in REFUSED_URLS {
        let refused = e2e.patch(&path, json!({ "billing_portal_url": url })).await;
        assert_eq!(
            refused.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{url}: {}",
            refused.text()
        );
        assert_eq!(codes(&refused), vec!["form_param_format_invalid"], "{url}");
        assert_eq!(param(&refused), "billing_portal_url", "{url}");
    }
    let too_long = format!("https://billing.example.com/{}", "a".repeat(2100));
    let refused = e2e
        .patch(&path, json!({ "billing_portal_url": too_long }))
        .await;
    assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
    let wrong_type = e2e.patch(&path, json!({ "billing_portal_url": 42 })).await;
    assert_eq!(wrong_type.status, StatusCode::UNPROCESSABLE_ENTITY);
    // Nothing was written by the refused requests.
    assert_eq!(
        e2e.get(&path).await.value()["billing_portal_url"],
        Value::Null
    );

    let set = e2e
        .patch(
            &path,
            json!({ "billing_portal_url": "https://billing.example.com/acme" }),
        )
        .await;
    assert_eq!(set.status, StatusCode::OK, "{}", set.text());
    assert_eq!(
        set.value()["billing_portal_url"],
        "https://billing.example.com/acme"
    );

    // An unrelated PATCH keeps it.
    let renamed = e2e.patch(&path, json!({ "name": "Acme Inc" })).await;
    assert_eq!(
        renamed.value()["billing_portal_url"],
        "https://billing.example.com/acme"
    );

    // The Frontend API organization never carries it, even for an admin.
    let fapi = owner
        .browser
        .get(&format!("/v1/client/organizations/{}", org.id), &[])
        .await;
    assert_eq!(fapi.status, StatusCode::OK, "{}", fapi.text());
    assert!(fapi.value()["response"].get("billing_portal_url").is_none());

    // `null` and "" both clear it.
    let cleared = e2e
        .patch(&path, json!({ "billing_portal_url": null }))
        .await;
    assert_eq!(cleared.value()["billing_portal_url"], Value::Null);
    e2e.patch(
        &path,
        json!({ "billing_portal_url": "https://billing.example.com/x" }),
    )
    .await;
    let cleared = e2e
        .patch(&path, json!({ "billing_portal_url": "  " }))
        .await;
    assert_eq!(cleared.value()["billing_portal_url"], Value::Null);

    // Create accepts it too, and validates it the same way.
    let created = e2e
        .post(
            "/v1/organizations",
            json!({ "name": "Globex", "billing_portal_url": "https://pay.example.com/globex" }),
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    assert_eq!(
        created.value()["billing_portal_url"],
        "https://pay.example.com/globex"
    );
    let refused = e2e
        .post(
            "/v1/organizations",
            json!({ "name": "Initech", "billing_portal_url": "http://pay.example.com" }),
        )
        .await;
    assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(param(&refused), "billing_portal_url");

    // The Backend API needs the secret key.
    let anonymous = e2e
        .browser()
        .patch(&path, Some(json!({ "billing_portal_url": null })), &[])
        .await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn organization_billing_route_requires_the_billing_permission() {
    let e2e = E2e::new().await;
    enable_organizations(&e2e).await;
    let admin = person(&e2e, "billing-admin@example.com").await;
    let member = person(&e2e, "billing-member@example.com").await;
    let accountant = person(&e2e, "billing-accountant@example.com").await;
    let outsider = person(&e2e, "billing-outsider@example.com").await;
    let org = create_test_organization(e2e.state(), "Acme", None, &admin.id)
        .await
        .unwrap();
    add_test_member(e2e.state(), &org.id, &member.id, "org:member")
        .await
        .unwrap();
    // A custom role carrying only the billing permission.
    let role = e2e
        .post(
            "/v1/roles",
            json!({ "key": "org:billing", "name": "Billing", "permissions": ["org:sys_billing:manage"] }),
        )
        .await;
    assert_eq!(role.status, StatusCode::OK, "{}", role.text());
    add_test_member(e2e.state(), &org.id, &accountant.id, "org:billing")
        .await
        .unwrap();
    let path = format!("/v1/client/organizations/{}/billing", org.id);

    let unset = admin.browser.get(&path, &[]).await;
    assert_eq!(unset.status, StatusCode::OK, "{}", unset.text());
    assert_eq!(
        unset.value()["response"],
        json!({ "object": "organization_billing", "organization_id": org.id, "portal_url": null })
    );

    e2e.patch(
        &format!("/v1/organizations/{}", org.id),
        json!({ "billing_portal_url": "https://billing.example.com/acme" }),
    )
    .await;
    for allowed in [&admin, &accountant] {
        let read = allowed.browser.get(&path, &[]).await;
        assert_eq!(read.status, StatusCode::OK, "{}", read.text());
        assert_eq!(
            read.value()["response"]["portal_url"],
            "https://billing.example.com/acme"
        );
    }

    let denied = member.browser.get(&path, &[]).await;
    assert_eq!(denied.status, StatusCode::FORBIDDEN, "{}", denied.text());
    assert_eq!(codes(&denied), vec!["org_permission_required"]);
    assert_eq!(
        denied.value()["errors"][0]["meta"]["permission"],
        "org:sys_billing:manage"
    );

    let not_member = outsider.browser.get(&path, &[]).await;
    assert_eq!(not_member.status, StatusCode::NOT_FOUND);
    assert_eq!(codes(&not_member), vec!["not_a_member_in_organization"]);

    let anonymous = e2e.browser().get(&path, &[]).await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn the_seeded_admin_role_carries_the_billing_permission() {
    let e2e = E2e::new().await;
    let admin = orbitid_identity::rbac::permissions_for_role(e2e.state(), "org:admin")
        .await
        .unwrap();
    assert!(admin.iter().any(|key| key == "org:sys_billing:manage"));
    let member = orbitid_identity::rbac::permissions_for_role(e2e.state(), "org:member")
        .await
        .unwrap();
    assert!(!member.iter().any(|key| key == "org:sys_billing:manage"));
    // Seeding is idempotent: a second run adds nothing twice.
    orbitid_identity::orgs::seed_rbac(e2e.state())
        .await
        .unwrap();
    let again = orbitid_identity::rbac::permissions_for_role(e2e.state(), "org:admin")
        .await
        .unwrap();
    assert_eq!(admin, again);
}

async fn create_app(e2e: &E2e, body: Value) -> Value {
    let mut body = body;
    body["redirect_uris"] = json!([REDIRECT_URI]);
    let created = e2e.post("/v1/oauth_applications", body).await;
    assert_eq!(created.status, StatusCode::CREATED, "{}", created.text());
    created.value()
}

#[tokio::test]
async fn oauth_application_billing_portal_is_validated() {
    let e2e = E2e::new().await;
    for url in REFUSED_URLS {
        let refused = e2e
            .post(
                "/v1/oauth_applications",
                json!({ "name": "Billing app", "billing_portal_url": url }),
            )
            .await;
        assert_eq!(
            refused.status,
            StatusCode::UNPROCESSABLE_ENTITY,
            "{url}: {}",
            refused.text()
        );
        assert_eq!(param(&refused), "billing_portal_url", "{url}");
    }
    let app = create_app(
        &e2e,
        json!({ "name": "Billing app", "billing_portal_url": "https://pay.example.com/app" }),
    )
    .await;
    assert_eq!(app["billing_portal_url"], "https://pay.example.com/app");
    let path = format!("/v1/oauth_applications/{}", app["id"].as_str().unwrap());

    // A PATCH with only the billing field is not an empty update.
    let refused = e2e
        .patch(
            &path,
            json!({ "billing_portal_url": "http://pay.example.com" }),
        )
        .await;
    assert_eq!(refused.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(param(&refused), "billing_portal_url");
    let changed = e2e
        .patch(
            &path,
            json!({ "billing_portal_url": "https://pay.example.com/v2" }),
        )
        .await;
    assert_eq!(changed.status, StatusCode::OK, "{}", changed.text());
    assert_eq!(
        changed.value()["billing_portal_url"],
        "https://pay.example.com/v2"
    );
    let renamed = e2e.patch(&path, json!({ "name": "Renamed" })).await;
    assert_eq!(
        renamed.value()["billing_portal_url"],
        "https://pay.example.com/v2"
    );
    let cleared = e2e
        .patch(&path, json!({ "billing_portal_url": null }))
        .await;
    assert_eq!(cleared.value()["billing_portal_url"], Value::Null);
    assert_eq!(
        e2e.get(&path).await.value()["billing_portal_url"],
        Value::Null
    );
}

#[tokio::test]
async fn me_oauth_applications_follow_the_access_rule() {
    let e2e = E2e::new().await;
    enable_organizations(&e2e).await;
    let user = person(&e2e, "apps-user@example.com").await;
    let other = person(&e2e, "apps-other@example.com").await;
    let own_org = create_test_organization(e2e.state(), "Own Org", None, &user.id)
        .await
        .unwrap();
    let other_org = create_test_organization(e2e.state(), "Other Org", None, &other.id)
        .await
        .unwrap();

    let instance_wide = create_app(
        &e2e,
        json!({ "name": "A instance", "billing_portal_url": "https://pay.example.com/a" }),
    )
    .await;
    let member_app = create_app(
        &e2e,
        json!({ "name": "B member", "organization_id": own_org.id }),
    )
    .await;
    let hidden = create_app(
        &e2e,
        json!({ "name": "C hidden", "organization_id": other_org.id }),
    )
    .await;
    let granted = create_app(
        &e2e,
        json!({
            "name": "D granted",
            "organization_id": other_org.id,
            "billing_portal_url": "https://pay.example.com/d"
        }),
    )
    .await;
    let grant = e2e
        .post(
            &format!(
                "/v1/oauth_applications/{}/access_grants",
                granted["id"].as_str().unwrap()
            ),
            json!({ "user_id": user.id }),
        )
        .await;
    assert_eq!(grant.status, StatusCode::CREATED, "{}", grant.text());

    let listed = user
        .browser
        .get("/v1/client/me/oauth_applications", &[])
        .await;
    assert_eq!(listed.status, StatusCode::OK, "{}", listed.text());
    let apps = listed.value()["response"].as_array().unwrap().clone();
    let ids: Vec<&str> = apps.iter().map(|app| app["id"].as_str().unwrap()).collect();
    assert_eq!(
        ids,
        vec![
            instance_wide["id"].as_str().unwrap(),
            member_app["id"].as_str().unwrap(),
            granted["id"].as_str().unwrap(),
        ],
        "sorted by name, without the application the user may not use"
    );
    assert!(!ids.contains(&hidden["id"].as_str().unwrap()));

    assert_eq!(apps[0]["object"], "user_oauth_application");
    assert_eq!(apps[0]["access"], "instance");
    assert_eq!(apps[0]["organization"], Value::Null);
    assert_eq!(apps[0]["billing_portal_url"], "https://pay.example.com/a");
    assert_eq!(apps[1]["access"], "membership");
    assert_eq!(apps[1]["organization"]["name"], "Own Org");
    assert_eq!(apps[1]["billing_portal_url"], Value::Null);
    assert_eq!(apps[2]["access"], "grant");
    assert_eq!(apps[2]["organization_id"], other_org.id);
    assert_eq!(apps[2]["billing_portal_url"], "https://pay.example.com/d");
    for app in &apps {
        for secret in ["client_secret", "redirect_uris", "scopes", "public"] {
            assert!(app.get(secret).is_none(), "{secret} must not be listed");
        }
    }

    // The other user sees their own organization's applications, not the grant.
    let theirs = other
        .browser
        .get("/v1/client/me/oauth_applications", &[])
        .await;
    let names: Vec<String> = theirs.value()["response"]
        .as_array()
        .unwrap()
        .iter()
        .map(|app| app["name"].as_str().unwrap().to_string())
        .collect();
    assert_eq!(names, vec!["A instance", "C hidden", "D granted"]);

    // Revoking the grant removes the application from the list.
    let revoked = e2e
        .delete(&format!(
            "/v1/oauth_applications/{}/access_grants/{}",
            granted["id"].as_str().unwrap(),
            user.id
        ))
        .await;
    assert_eq!(revoked.status, StatusCode::OK, "{}", revoked.text());
    let after = user
        .browser
        .get("/v1/client/me/oauth_applications", &[])
        .await;
    assert_eq!(after.value()["response"].as_array().unwrap().len(), 2);

    let anonymous = e2e
        .browser()
        .get("/v1/client/me/oauth_applications", &[])
        .await;
    assert_eq!(anonymous.status, StatusCode::UNAUTHORIZED);
}
