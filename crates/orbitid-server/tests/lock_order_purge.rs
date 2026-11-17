//! `purge_unverified_claims_on` lock order: the other claimants are determined
//! with a plain read and locked (with the verifying user) in ascending id
//! before anything else, so two users verifying the same address that a third
//! user also claims cannot deadlock on opposite row orders.

use orbitid_identity::testing::{create_test_user, test_app_state_with};
use orbitid_identity::users::{lock_unverified_claim_owners_on, purge_unverified_claims_on};

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn concurrent_verifications_of_one_address_do_not_deadlock() {
    // The retry layer is not involved (domain functions only); the deadlock
    // counter is the assertion.
    let app = test_app_state_with(orbitid_core::testing::test_pool_exemption(8)).await;
    let state = app.state();
    let before: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("deadlocks");
    for round in 0..8 {
        let address = format!("shared-{round}@claims.test");
        let mut users = Vec::new();
        let mut emails = Vec::new();
        for index in 0..3 {
            let user = create_test_user(
                state,
                &format!("owner-{round}-{index}@example.com"),
                "Sup3r-secret!",
            )
            .await
            .expect("user");
            let email_id = orbitid_core::ids::new_id(orbitid_core::ids::id_prefix::EMAIL);
            let now = orbitid_core::http::now();
            sqlx::query(
                "INSERT INTO email_addresses (id, user_id, email, verified, created_at, updated_at) \
                 VALUES ($1,$2,$3,false,$4,$4)",
            )
            .bind(&email_id)
            .bind(&user.user.id)
            .bind(&address)
            .bind(now)
            .execute(&state.pool)
            .await
            .expect("claim");
            sqlx::query("UPDATE users SET primary_email_address_id = $1 WHERE id = $2")
                .bind(&email_id)
                .bind(&user.user.id)
                .execute(&state.pool)
                .await
                .expect("primary");
            users.push(user.user.id);
            emails.push(email_id);
        }
        // Users 0 and 1 verify concurrently; user 2 is the third claimant.
        let mut tasks = Vec::new();
        for index in 0..2 {
            let state = state.clone();
            let (user, email_id, address) =
                (users[index].clone(), emails[index].clone(), address.clone());
            tasks.push(tokio::spawn(async move {
                let mut tx = state.pool.begin().await.expect("begin");
                let locked = lock_unverified_claim_owners_on(
                    &mut tx,
                    &address,
                    &user,
                    std::slice::from_ref(&user),
                )
                .await
                .map_err(|error| error.code)?;
                let verified = sqlx::query(
                    "UPDATE email_addresses SET verified = true WHERE id = $1 AND verified = false \
                     AND NOT EXISTS (SELECT 1 FROM email_addresses o WHERE o.email = $2 \
                                     AND o.verified = true AND o.id <> $1)",
                )
                .bind(&email_id)
                .bind(&address)
                .execute(&mut *tx)
                .await
                .map_err(|error| orbitid_core::error::OrbitError::from(error).code)?;
                if verified.rows_affected() == 1 {
                    purge_unverified_claims_on(&mut tx, &address, &user, &locked)
                        .await
                        .map_err(|error| error.code)?;
                }
                tx.commit()
                    .await
                    .map_err(|error| orbitid_core::error::OrbitError::from(error).code)?;
                Ok::<u64, String>(verified.rows_affected())
            }));
        }
        let mut winners = 0;
        for task in tasks {
            winners += task.await.expect("join").expect("no deadlock or conflict");
        }
        assert_eq!(winners, 1, "exactly one claimant verifies the address");
        let left: Vec<(String, bool)> =
            sqlx::query_as("SELECT id, verified FROM email_addresses WHERE email = $1 ORDER BY id")
                .bind(&address)
                .fetch_all(&state.pool)
                .await
                .expect("left");
        assert_eq!(
            left.len(),
            1,
            "the other unverified claims are purged: {left:?}"
        );
        assert!(left[0].1);
    }
    let after: i64 = sqlx::query_scalar(
        "SELECT COALESCE(SUM(deadlocks), 0)::bigint FROM pg_stat_database \
         WHERE datname = current_database()",
    )
    .fetch_one(&state.pool)
    .await
    .expect("deadlocks");
    assert_eq!(after - before, 0);
}
