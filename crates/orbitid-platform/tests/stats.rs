//! Aggregate instance statistics (`GET /v1/stats`).

use orbitid_core::testing::test_state;
use orbitid_core::AppState;
use orbitid_platform::stats::instance_stats;
use serde_json::json;
use sqlx::types::Json;

const DAY: i64 = 86_400_000;

async fn insert_user(state: &AppState, id: &str, created_at: i64, active_at: Option<i64>) {
    sqlx::query(
        "INSERT INTO users (id, public_metadata, private_metadata, unsafe_metadata, \
         last_active_at, created_at, updated_at) VALUES ($1, $2, $2, $2, $3, $4, $4)",
    )
    .bind(id)
    .bind(Json(json!({})))
    .bind(active_at)
    .bind(created_at)
    .execute(&state.pool)
    .await
    .expect("user");
}

async fn insert_session(state: &AppState, id: &str, status: &str, expire_at: i64, created_at: i64) {
    sqlx::query(
        "INSERT INTO sessions (id, client_id, user_id, status, last_active_at, expire_at, \
         abandon_at, created_at, updated_at) \
         VALUES ($1, 'client_1', 'user_1', $2, $3, $4, $4, $3, $3)",
    )
    .bind(id)
    .bind(status)
    .bind(created_at)
    .bind(expire_at)
    .execute(&state.pool)
    .await
    .expect("session");
}

#[tokio::test]
async fn aggregates_users_sessions_organizations_and_providers() {
    let ctx = test_state().await;
    let now = orbitid_core::http::now();
    let state = &ctx.state;

    insert_user(state, "user_1", now, Some(now - DAY)).await;
    insert_user(state, "user_2", now, None).await;
    insert_user(state, "user_3", now, None).await;
    insert_user(state, "user_4", now - 40 * DAY, Some(now - 10 * DAY)).await;
    insert_user(state, "user_5", now, None).await;

    sqlx::query("UPDATE users SET banned = true WHERE id = 'user_2'")
        .execute(&state.pool)
        .await
        .expect("ban");
    sqlx::query("UPDATE users SET locked = true, lockout_expires_at = $1 WHERE id = 'user_3'")
        .bind(now + DAY)
        .execute(&state.pool)
        .await
        .expect("lock");
    sqlx::query("UPDATE users SET locked = true, lockout_expires_at = $1 WHERE id = 'user_5'")
        .bind(now - DAY)
        .execute(&state.pool)
        .await
        .expect("expired lock");
    sqlx::query("UPDATE users SET totp_verified = true WHERE id = 'user_4'")
        .execute(&state.pool)
        .await
        .expect("totp");

    sqlx::query(
        "INSERT INTO clients (id, token_hash, created_at, updated_at) \
         VALUES ('client_1', 'hash_1', $1, $1)",
    )
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("client");

    insert_session(state, "sess_1", "active", now + DAY, now).await;
    insert_session(state, "sess_2", "active", now - DAY, now).await;
    insert_session(state, "sess_3", "ended", now + DAY, now).await;

    sqlx::query(
        "INSERT INTO organizations (id, name, public_metadata, private_metadata, created_at, updated_at) \
         VALUES ('org_1', 'Acme', $1, $1, $2, $2)",
    )
    .bind(Json(json!({})))
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("organization");

    sqlx::query(
        "INSERT INTO phone_numbers (id, user_id, phone, verified, reserved_for_second_factor, \
         created_at, updated_at) VALUES ('idn_p1', 'user_1', '+15555550100', true, true, $1, $1)",
    )
    .bind(now)
    .execute(&state.pool)
    .await
    .expect("phone");

    for (id, provider) in [
        ("eac_1", "google"),
        ("eac_2", "google"),
        ("eac_3", "github"),
    ] {
        sqlx::query(
            "INSERT INTO external_accounts (id, provider, provider_user_id, public_metadata, \
             created_at, updated_at) VALUES ($1, $2, $1, $3, $4, $4)",
        )
        .bind(id)
        .bind(provider)
        .bind(Json(json!({})))
        .bind(now)
        .execute(&state.pool)
        .await
        .expect("external account");
    }

    let stats = instance_stats(state).await.expect("stats");
    assert_eq!(stats.users_total, 5);
    assert_eq!(stats.users_active_7d, 1);
    assert_eq!(stats.sessions_active, 1);
    assert_eq!(stats.organizations_total, 1);
    assert_eq!(stats.banned_users, 1);
    assert_eq!(stats.locked_users, 1);
    assert_eq!(stats.mfa_enabled_users, 2);
    assert_eq!(stats.signups_by_day.len(), 30);
    assert_eq!(stats.signups_by_day[29].count, 4);
    assert_eq!(stats.signins_by_day.len(), 30);
    assert_eq!(stats.signins_by_day[29].count, 3);
    assert_eq!(
        stats.top_social_providers,
        vec![
            orbitid_platform::stats::ProviderCount {
                provider: "google".to_string(),
                count: 2
            },
            orbitid_platform::stats::ProviderCount {
                provider: "github".to_string(),
                count: 1
            }
        ]
    );
    let serialized = serde_json::to_value(&stats).expect("json");
    assert!(serialized["users_total"].is_number());
    assert!(serialized["signups_by_day"][0]["date"].is_string());
}

#[tokio::test]
async fn an_empty_instance_has_zero_filled_series() {
    let ctx = test_state().await;
    let stats = instance_stats(&ctx.state).await.expect("stats");
    assert_eq!(stats.users_total, 0);
    assert_eq!(stats.signups_by_day.len(), 30);
    assert!(stats.signups_by_day.iter().all(|day| day.count == 0));
    assert!(stats.top_social_providers.is_empty());
}
