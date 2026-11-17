//! The separate-parts database configuration against a live server: a password
//! with every URL-hostile character authenticates byte-for-byte (the case the
//! raw-interpolated compose URL broke).

#![allow(clippy::unwrap_used, clippy::expect_used)]

use orbitid_core::config::resolve_database;
use sqlx::postgres::PgConnectOptions;
use sqlx::{Connection, PgConnection};
use std::collections::HashMap;
use std::str::FromStr;

const HOSTILE: &str = "a/b+c=d@e:f%g h?i#j";

#[tokio::test]
async fn a_hostile_password_authenticates_through_the_parts() {
    let admin_url = orbitid_core::testing::admin_url();
    let admin = PgConnectOptions::from_str(&admin_url).expect("admin url");
    let mut connection = PgConnection::connect_with(&admin).await.expect("admin");
    let suffix = orbitid_core::ids::new_id("t");
    let role = format!(
        "orbit_parts_{}",
        suffix.to_lowercase().replace(['-', '_'], "")
    );
    let role = &role[..role.len().min(40)];
    sqlx::query(&format!(
        "CREATE ROLE \"{role}\" LOGIN PASSWORD '{}'",
        HOSTILE.replace('\'', "''")
    ))
    .execute(&mut connection)
    .await
    .expect("create role");

    let env: HashMap<String, String> = [
        ("ORBITID_DATABASE_HOST", admin.get_host().to_string()),
        ("ORBITID_DATABASE_PORT", admin.get_port().to_string()),
        ("ORBITID_DATABASE_USER", role.to_string()),
        ("ORBITID_DATABASE_PASSWORD", HOSTILE.to_string()),
        (
            "ORBITID_DATABASE_NAME",
            admin.get_database().unwrap_or("postgres").to_string(),
        ),
    ]
    .into_iter()
    .map(|(key, value)| (key.to_string(), value))
    .collect();
    let lookup = |name: &str| env.get(name).cloned();
    let config = resolve_database(None, &lookup).expect("resolves");
    let outcome = async {
        let mut good = PgConnection::connect_with(&config.connect_options())
            .await
            .expect("the hostile password authenticates");
        let user: String = sqlx::query_scalar("SELECT current_user::text")
            .fetch_one(&mut good)
            .await
            .expect("query");
        assert_eq!(user, role);

        // A wrong password is refused (so the success above is not a trust rule).
        let mut wrong = env.clone();
        wrong.insert("ORBITID_DATABASE_PASSWORD".into(), "wrong".into());
        let lookup = |name: &str| wrong.get(name).cloned();
        let wrong = resolve_database(None, &lookup).expect("resolves");
        assert!(PgConnection::connect_with(&wrong.connect_options())
            .await
            .is_err());
    }
    .await;
    let _ = sqlx::query(&format!("DROP ROLE \"{role}\""))
        .execute(&mut connection)
        .await;
    outcome
}
