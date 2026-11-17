//! Audit log persistence and filtering (`GET /v1/audit_logs`).

use orbitid_core::testing::test_state;
use orbitid_core::AppState;
use orbitid_platform::audit::{audit, list_audit_logs, AuditInput, AuditLogFilters};
use serde_json::json;

async fn seed(state: &AppState) {
    audit(
        state,
        AuditInput::new("user.created")
            .actor("sk_alpha")
            .target_type("user")
            .target_id("user_1")
            .metadata(json!({ "email": "one@example.com" }))
            .ip("203.0.113.1"),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    audit(
        state,
        AuditInput::new("user.updated")
            .actor("sk_alpha")
            .target_type("user")
            .target_id("user_1"),
    )
    .await;
    tokio::time::sleep(std::time::Duration::from_millis(2)).await;
    audit(
        state,
        AuditInput::new("organization.created")
            .actor("system")
            .target_type("organization")
            .target_id("org_1"),
    )
    .await;
}

fn filters() -> AuditLogFilters {
    AuditLogFilters {
        limit: 50,
        offset: 0,
        ..Default::default()
    }
}

#[tokio::test]
async fn appends_and_lists_newest_first() {
    let ctx = test_state().await;
    seed(&ctx.state).await;
    let page = list_audit_logs(&ctx.state, &filters()).await.expect("list");
    assert_eq!(page.total_count, 3);
    assert_eq!(page.data.len(), 3);
    assert_eq!(page.data[0].object, "audit_log");
    assert_eq!(page.data[0].action, "organization.created");
    assert_eq!(page.data[2].action, "user.created");
    let created = &page.data[2];
    assert_eq!(created.actor.as_deref(), Some("sk_alpha"));
    assert_eq!(created.target_type.as_deref(), Some("user"));
    assert_eq!(created.target_id.as_deref(), Some("user_1"));
    assert_eq!(created.ip.as_deref(), Some("203.0.113.1"));
    assert_eq!(created.metadata["email"], "one@example.com");
    assert!(created.created_at > 0);
}

#[tokio::test]
async fn filters_by_actor_action_prefix_target_and_time_range() {
    let ctx = test_state().await;
    seed(&ctx.state).await;

    let mut filter = filters();
    filter.actor = Some("sk_alpha".to_string());
    assert_eq!(
        list_audit_logs(&ctx.state, &filter)
            .await
            .expect("list")
            .total_count,
        2
    );

    filter = filters();
    filter.action = Some("user.*".to_string());
    let page = list_audit_logs(&ctx.state, &filter).await.expect("list");
    assert_eq!(page.total_count, 2);
    assert!(page.data.iter().all(|row| row.action.starts_with("user.")));

    // `startsWithText` is case-insensitive.
    filter.action = Some("USER.*".to_string());
    assert_eq!(
        list_audit_logs(&ctx.state, &filter)
            .await
            .expect("list")
            .total_count,
        2
    );

    filter = filters();
    filter.action = Some("user.created".to_string());
    assert_eq!(
        list_audit_logs(&ctx.state, &filter)
            .await
            .expect("list")
            .total_count,
        1
    );

    filter = filters();
    filter.target_type = Some("user".to_string());
    assert_eq!(
        list_audit_logs(&ctx.state, &filter)
            .await
            .expect("list")
            .total_count,
        2
    );

    filter = filters();
    filter.target_id = Some("org_1".to_string());
    assert_eq!(
        list_audit_logs(&ctx.state, &filter)
            .await
            .expect("list")
            .total_count,
        1
    );

    filter = filters();
    filter.after = Some(orbitid_core::http::now() + 60_000);
    assert_eq!(
        list_audit_logs(&ctx.state, &filter)
            .await
            .expect("list")
            .total_count,
        0
    );

    filter = filters();
    filter.before = Some(orbitid_core::http::now() + 60_000);
    assert_eq!(
        list_audit_logs(&ctx.state, &filter)
            .await
            .expect("list")
            .total_count,
        3
    );
}

#[tokio::test]
async fn supports_ascending_order_and_pagination() {
    let ctx = test_state().await;
    seed(&ctx.state).await;
    let mut filter = filters();
    filter.order_by = Some("created_at".to_string());
    filter.limit = 1;
    filter.offset = 1;
    let page = list_audit_logs(&ctx.state, &filter).await.expect("list");
    assert_eq!(page.total_count, 3);
    assert_eq!(page.data.len(), 1);
    assert_eq!(page.data[0].action, "user.updated");
}

#[tokio::test]
async fn auditing_never_breaks_the_caller_even_if_the_row_is_invalid() {
    let ctx = test_state().await;
    // A non-object metadata value is ignored rather than rejected.
    audit(
        &ctx.state,
        AuditInput::new("system.ping").metadata(json!("not an object")),
    )
    .await;
    let page = list_audit_logs(&ctx.state, &filters()).await.expect("list");
    assert_eq!(page.total_count, 1);
    assert!(page.data[0].metadata.is_empty());
    assert!(page.data[0].actor.is_none());
}
