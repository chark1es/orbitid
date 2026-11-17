//! Upload lifecycle through the composed HTTP app: deleting a user or an
//! organization must delete its `uploads` rows, so the public URL becomes a 404
//! instead of serving a deleted image forever.

#![allow(clippy::unwrap_used, clippy::expect_used)]

mod common;

use axum::http::StatusCode;
use common::*;
use orbitid_core::testing::TestClient;
use serde_json::json;

const PNG_BASE64: &str =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";

fn png_data_url() -> String {
    format!("data:image/png;base64,{PNG_BASE64}")
}

fn path_of(url: &str) -> String {
    url::Url::parse(url)
        .map(|url| url.path().to_string())
        .unwrap_or_default()
}

fn file_of(url: &str) -> String {
    url.rsplit('/').next().unwrap_or_default().to_string()
}

async fn setup() -> (E2e, TestClient, String, String) {
    let e2e = E2e::new().await;
    e2e.state()
        .settings
        .update(json!({
            "organizations": { "enabled": true },
            "userSettings": { "deleteSelfEnabled": true }
        }))
        .await
        .expect("settings");
    let browser = e2e.browser();
    let signed_up = sign_up(&e2e, &browser, "uploads@example.com", "Sup3r-secret!").await;
    let user_id = signed_up["response"]["created_user_id"]
        .as_str()
        .expect("user id")
        .to_string();
    let created = browser
        .post(
            "/v1/client/organizations",
            Some(json!({ "name": "Upload Co" })),
            &[],
        )
        .await;
    assert_eq!(created.status, StatusCode::OK, "{}", created.text());
    let org_id = created.value()["response"]["id"]
        .as_str()
        .expect("org id")
        .to_string();
    (e2e, browser, user_id, org_id)
}

async fn upload_logo(browser: &TestClient, org_id: &str) -> String {
    let uploaded = browser
        .request(
            "PUT",
            &format!("/v1/client/organizations/{org_id}/logo"),
            Some(json!({ "file": png_data_url() })),
            &[],
        )
        .await;
    assert_eq!(uploaded.status, StatusCode::OK, "{}", uploaded.text());
    uploaded.value()["response"]["image_url"]
        .as_str()
        .expect("logo url")
        .to_string()
}

async fn upload_avatar(browser: &TestClient) -> String {
    let uploaded = browser
        .post(
            "/v1/client/me/profile_image",
            Some(json!({ "file": png_data_url() })),
            &[],
        )
        .await;
    assert_eq!(uploaded.status, StatusCode::OK, "{}", uploaded.text());
    uploaded.value()["response"]["image_url"]
        .as_str()
        .expect("avatar url")
        .to_string()
}

async fn assert_served(e2e: &E2e, url: &str, expected: StatusCode) {
    let status = e2e.client.get(&path_of(url), &[]).await.status;
    assert_eq!(status, expected, "{url}");
}

async fn upload_row_exists(e2e: &E2e, url: &str) -> bool {
    sqlx::query_scalar::<_, bool>("SELECT EXISTS(SELECT 1 FROM uploads WHERE file = $1)")
        .bind(file_of(url))
        .fetch_one(&e2e.state().pool)
        .await
        .expect("upload row")
}

/// Deleting an organization through the Frontend API removes its logo row.
#[tokio::test]
async fn frontend_organization_deletion_removes_the_logo_upload() {
    let (e2e, browser, _user_id, org_id) = setup().await;
    let logo = upload_logo(&browser, &org_id).await;
    assert_served(&e2e, &logo, StatusCode::OK).await;
    let deleted = browser
        .delete(&format!("/v1/client/organizations/{org_id}"), None, &[])
        .await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    assert_served(&e2e, &logo, StatusCode::NOT_FOUND).await;
    assert!(!upload_row_exists(&e2e, &logo).await);
}

/// Deleting an organization through the Backend API removes its logo row.
#[tokio::test]
async fn backend_organization_deletion_removes_the_logo_upload() {
    let (e2e, browser, _user_id, org_id) = setup().await;
    let logo = upload_logo(&browser, &org_id).await;
    let deleted = e2e.delete(&format!("/v1/organizations/{org_id}")).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    assert_served(&e2e, &logo, StatusCode::NOT_FOUND).await;
    assert!(!upload_row_exists(&e2e, &logo).await);
}

/// Deleting the sole member through the Backend API deletes the organization
/// and its logo in the same transaction.
#[tokio::test]
async fn backend_user_deletion_removes_the_cascaded_organization_logo_and_avatar() {
    let (e2e, browser, user_id, org_id) = setup().await;
    let logo = upload_logo(&browser, &org_id).await;
    let avatar = upload_avatar(&browser).await;
    let deleted = e2e.delete(&format!("/v1/users/{user_id}")).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    assert_served(&e2e, &logo, StatusCode::NOT_FOUND).await;
    assert_served(&e2e, &avatar, StatusCode::NOT_FOUND).await;
    assert!(!upload_row_exists(&e2e, &logo).await);
    assert!(!upload_row_exists(&e2e, &avatar).await);
    let orgs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organizations")
        .fetch_one(&e2e.state().pool)
        .await
        .unwrap();
    assert_eq!(orgs, 0);
}

/// Deleting your own account through the Frontend API removes the avatar and
/// the logo of the organization the deletion cascades.
#[tokio::test]
async fn frontend_account_deletion_removes_the_cascaded_logo_and_avatar() {
    let (e2e, browser, _user_id, org_id) = setup().await;
    let logo = upload_logo(&browser, &org_id).await;
    let avatar = upload_avatar(&browser).await;
    let deleted = browser.delete("/v1/client/me", None, &[]).await;
    assert_eq!(deleted.status, StatusCode::OK, "{}", deleted.text());
    assert_served(&e2e, &logo, StatusCode::NOT_FOUND).await;
    assert_served(&e2e, &avatar, StatusCode::NOT_FOUND).await;
    assert!(!upload_row_exists(&e2e, &logo).await);
    assert!(!upload_row_exists(&e2e, &avatar).await);
}

/// Replacing an avatar or a logo deletes the old row in the pointer-change
/// transaction; the new URL keeps working.
#[tokio::test]
async fn replacing_an_image_removes_the_old_upload() {
    let (e2e, browser, _user_id, org_id) = setup().await;
    let old_avatar = upload_avatar(&browser).await;
    let new_avatar = upload_avatar(&browser).await;
    assert_ne!(old_avatar, new_avatar);
    assert_served(&e2e, &old_avatar, StatusCode::NOT_FOUND).await;
    assert_served(&e2e, &new_avatar, StatusCode::OK).await;

    let old_logo = upload_logo(&browser, &org_id).await;
    let new_logo = upload_logo(&browser, &org_id).await;
    assert_ne!(old_logo, new_logo);
    assert_served(&e2e, &old_logo, StatusCode::NOT_FOUND).await;
    assert_served(&e2e, &new_logo, StatusCode::OK).await;
    assert!(!upload_row_exists(&e2e, &old_avatar).await);
    assert!(!upload_row_exists(&e2e, &old_logo).await);

    let removed = browser
        .delete(
            &format!("/v1/client/organizations/{org_id}/logo"),
            None,
            &[],
        )
        .await;
    assert_eq!(removed.status, StatusCode::OK, "{}", removed.text());
    assert_served(&e2e, &new_logo, StatusCode::NOT_FOUND).await;
}

/// A failure late in the deletion transaction rolls the deletion back: the
/// organization and its upload row both survive.
#[tokio::test]
async fn a_failed_organization_deletion_keeps_the_upload_row() {
    let (e2e, browser, _user_id, org_id) = setup().await;
    let logo = upload_logo(&browser, &org_id).await;
    sqlx::query(
        "CREATE OR REPLACE FUNCTION orbitid_test_fail_event() RETURNS trigger AS $$ \
         BEGIN RAISE EXCEPTION 'injected event failure'; END; $$ LANGUAGE plpgsql",
    )
    .execute(&e2e.state().pool)
    .await
    .expect("trigger function");
    sqlx::query(
        "CREATE TRIGGER orbitid_test_fail_delete_event BEFORE INSERT ON webhook_events \
         FOR EACH ROW EXECUTE FUNCTION orbitid_test_fail_event()",
    )
    .execute(&e2e.state().pool)
    .await
    .expect("trigger");
    let deleted = browser
        .delete(&format!("/v1/client/organizations/{org_id}"), None, &[])
        .await;
    assert_eq!(deleted.status, StatusCode::INTERNAL_SERVER_ERROR);
    assert_served(&e2e, &logo, StatusCode::OK).await;
    assert!(upload_row_exists(&e2e, &logo).await);
    let orgs: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM organizations WHERE id = $1")
        .bind(&org_id)
        .fetch_one(&e2e.state().pool)
        .await
        .unwrap();
    assert_eq!(orgs, 1);
}
