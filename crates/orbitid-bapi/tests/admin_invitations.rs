//! Ported from the retired TypeScript test suite,
//! `waitlist.test.ts` and the HTTP parts of `restrictions.test.ts`.

mod common;

use std::sync::{Arc, Mutex};

use axum::http::StatusCode;
use orbitid_platform::mail::{set_mail_transport, MailTransportOverride, SentEmail};
use serde_json::{json, Value};

use common::{error_code, setup};

/// The identity test install has no capture mailer, so record deliveries here.
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

fn capture(harness: &common::Harness) -> Arc<Capture> {
    let capture = Arc::new(Capture::default());
    set_mail_transport(harness.state(), Some(capture.clone()));
    capture
}

fn ticket_from_url(url: &str) -> String {
    let parsed = url::Url::parse(url).expect("url");
    parsed
        .query_pairs()
        .find(|(key, _)| key == "__orbit_ticket")
        .map(|(_, value)| value.into_owned())
        .expect("ticket")
}

#[tokio::test]
async fn creates_an_invitation_with_a_ticket_url_and_notifies_the_invitee() {
    let harness = setup().await;
    let capture = capture(&harness);
    let response = harness
        .post(
            "/v1/invitations",
            json!({
                "email_address": "Invitee@Example.com",
                "public_metadata": { "team": "core" },
                "redirect_url": "https://app.example.com/welcome",
            }),
        )
        .await;
    assert_eq!(response.status, StatusCode::OK, "{}", response.text());
    let invitation = response.value();
    assert_eq!(invitation["object"], json!("invitation"));
    assert_eq!(invitation["email_address"], json!("invitee@example.com"));
    assert_eq!(invitation["status"], json!("pending"));
    assert_eq!(invitation["public_metadata"], json!({ "team": "core" }));
    assert!(
        invitation["expires_at"].as_i64().unwrap() > orbitid_core::http::now() + 29 * 86_400_000
    );
    let url = invitation["url"].as_str().expect("url");
    assert!(url.contains("/sign-up?__orbit_ticket="), "{url}");
    assert!(!ticket_from_url(url).is_empty());

    let emails = capture.emails.lock().expect("capture");
    let mail = emails.last().expect("mail");
    assert_eq!(mail.to, "invitee@example.com");
    assert_eq!(mail.template.as_str(), "invitation");
    assert!(mail
        .vars
        .get("invitation_url")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .contains("__orbit_ticket="));
}

#[tokio::test]
async fn refuses_duplicates_unless_ignore_existing_is_set() {
    let harness = setup().await;
    assert_eq!(
        harness
            .post(
                "/v1/invitations",
                json!({ "email_address": "dup@example.com", "notify": false }),
            )
            .await
            .status,
        StatusCode::OK
    );

    let duplicate = harness
        .post(
            "/v1/invitations",
            json!({ "email_address": "dup@example.com" }),
        )
        .await;
    assert_eq!(duplicate.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_code(&duplicate).as_deref(), Some("duplicate_record"));

    assert_eq!(
        harness
            .post(
                "/v1/invitations",
                json!({ "email_address": "dup@example.com", "ignore_existing": true }),
            )
            .await
            .status,
        StatusCode::OK
    );

    // Delivery is reported, not thrown: a failing transport still leaves the
    // invitation created (the default console transport always fails here).
    let still_created = harness
        .post(
            "/v1/invitations",
            json!({ "email_address": "smtp@example.com" }),
        )
        .await;
    assert_eq!(
        still_created.status,
        StatusCode::OK,
        "{}",
        still_created.text()
    );
    assert_eq!(still_created.value()["status"], json!("pending"));
}

#[tokio::test]
async fn bulk_creates_lists_by_status_and_revokes() {
    let harness = setup().await;
    let bulk = harness
        .post(
            "/v1/invitations/bulk",
            json!({ "email_addresses": ["one@example.com", "two@example.com"], "notify": false }),
        )
        .await;
    assert_eq!(bulk.status, StatusCode::OK, "{}", bulk.text());
    let mut emails: Vec<String> = bulk
        .value()
        .as_array()
        .unwrap()
        .iter()
        .map(|invitation| invitation["email_address"].as_str().unwrap().to_string())
        .collect();
    emails.sort();
    assert_eq!(emails, vec!["one@example.com", "two@example.com"]);

    let again = harness
        .post(
            "/v1/invitations/bulk",
            json!({ "email_addresses": ["one@example.com"], "notify": false }),
        )
        .await;
    assert_eq!(again.value(), json!([]));

    let pending = harness.get("/v1/invitations?status=pending").await;
    assert_eq!(pending.value()["total_count"], json!(2));
    let query = harness.get("/v1/invitations?query=one@").await;
    assert_eq!(
        query.value()["data"][0]["email_address"],
        json!("one@example.com")
    );

    let id = bulk.value()[0]["id"].as_str().unwrap().to_string();
    let revoked = harness
        .post_empty(&format!("/v1/invitations/{id}/revoke"))
        .await;
    assert_eq!(revoked.value()["status"], json!("revoked"));
    assert_eq!(
        harness.get("/v1/invitations?status=revoked").await.value()["total_count"],
        json!(1)
    );
    assert_eq!(
        harness
            .post_empty("/v1/invitations/inv_nope/revoke")
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn reports_expired_invitations() {
    let harness = setup().await;
    let invitation = harness
        .post(
            "/v1/invitations",
            json!({ "email_address": "stale@example.com", "notify": false }),
        )
        .await
        .value();
    let id = invitation["id"].as_str().unwrap().to_string();
    sqlx::query("UPDATE invitations SET expires_at = $1 WHERE id = $2")
        .bind(orbitid_core::http::now() - 1)
        .bind(&id)
        .execute(&harness.state().pool)
        .await
        .expect("expire");
    let read = harness.get(&format!("/v1/invitations/{id}")).await;
    assert_eq!(read.value()["status"], json!("expired"));
}

#[tokio::test]
async fn waitlist_admins_add_filter_invite_and_reject_entries() {
    let harness = setup().await;
    let capture = capture(&harness);
    let first = harness
        .post(
            "/v1/waitlist_entries",
            json!({ "email_address": "one@example.com" }),
        )
        .await
        .value();
    assert_eq!(first["object"], json!("waitlist_entry"));
    assert_eq!(first["status"], json!("pending"));
    harness
        .post(
            "/v1/waitlist_entries",
            json!({ "email_address": "two@example.com" }),
        )
        .await;
    assert_eq!(
        harness
            .post(
                "/v1/waitlist_entries",
                json!({ "email_address": "one@example.com" })
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );

    let list = harness
        .get("/v1/waitlist_entries?status=pending&query=one@")
        .await;
    assert_eq!(
        list.value()["data"][0]["email_address"],
        json!("one@example.com")
    );

    let id = first["id"].as_str().unwrap().to_string();
    let invited = harness
        .post_empty(&format!("/v1/waitlist_entries/{id}/invite"))
        .await;
    assert_eq!(invited.status, StatusCode::OK, "{}", invited.text());
    assert_eq!(invited.value()["status"], json!("invited"));
    assert_eq!(
        invited.value()["invitation"]["email_address"],
        json!("one@example.com")
    );
    assert_eq!(
        capture
            .emails
            .lock()
            .expect("capture")
            .last()
            .map(|mail| mail.template.as_str()),
        Some("waitlist_invited")
    );
    assert_eq!(
        harness
            .get("/v1/waitlist_entries?status=invited")
            .await
            .value()["total_count"],
        json!(1)
    );

    let rejected = harness
        .post_empty(&format!("/v1/waitlist_entries/{id}/reject"))
        .await;
    assert_eq!(rejected.value()["status"], json!("rejected"));
    let deleted = harness.delete(&format!("/v1/waitlist_entries/{id}")).await;
    assert_eq!(
        deleted.value(),
        json!({ "object": "waitlist_entry", "id": id, "deleted": true })
    );
    assert_eq!(
        harness
            .post_empty(&format!("/v1/waitlist_entries/{id}/invite"))
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}

#[tokio::test]
async fn manages_allowlist_and_blocklist_identifiers() {
    let harness = setup().await;
    let capture = capture(&harness);
    let email_entry = harness
        .post(
            "/v1/allowlist_identifiers",
            json!({ "identifier": "vip@example.com", "notify": true }),
        )
        .await;
    assert_eq!(email_entry.status, StatusCode::OK, "{}", email_entry.text());
    let value = email_entry.value();
    assert_eq!(value["identifier"], json!("vip@example.com"));
    assert_eq!(value["identifier_type"], json!("email_address"));
    assert!(value["invitation_id"].is_string());
    assert_eq!(
        capture.emails.lock().expect("capture").len(),
        1,
        "the notice email was recorded"
    );
    assert!(
        harness
            .state()
            .settings
            .get()
            .restrictions
            .allowlist_enabled
    );

    let phone = harness
        .post(
            "/v1/allowlist_identifiers",
            json!({ "identifier": "+15551230000" }),
        )
        .await;
    assert_eq!(phone.value()["identifier_type"], json!("phone_number"));
    assert_eq!(
        harness
            .post(
                "/v1/allowlist_identifiers",
                json!({ "identifier": "vip@example.com" }),
            )
            .await
            .status,
        StatusCode::UNPROCESSABLE_ENTITY
    );
    assert_eq!(
        harness.get("/v1/allowlist_identifiers").await.value()["total_count"],
        json!(2)
    );
    let email_id = value["id"].as_str().unwrap().to_string();
    assert_eq!(
        harness
            .delete(&format!("/v1/allowlist_identifiers/{email_id}"))
            .await
            .value(),
        json!({ "object": "allowlist_identifier", "id": email_id, "deleted": true })
    );

    let block = harness
        .post(
            "/v1/blocklist_identifiers",
            json!({ "identifier": "0xdeadbeef" }),
        )
        .await;
    assert_eq!(block.value()["identifier_type"], json!("web3_wallet"));
    assert_eq!(
        harness.get("/v1/blocklist_identifiers").await.value()["total_count"],
        json!(1)
    );
    let block_id = block.value()["id"].as_str().unwrap().to_string();
    assert_eq!(
        harness
            .delete(&format!("/v1/blocklist_identifiers/{block_id}"))
            .await
            .value(),
        json!({ "object": "blocklist_identifier", "id": block_id, "deleted": true })
    );
    assert_eq!(
        harness
            .delete("/v1/blocklist_identifiers/blid_nope")
            .await
            .status,
        StatusCode::NOT_FOUND
    );
}
