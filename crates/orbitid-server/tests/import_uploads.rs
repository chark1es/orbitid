//! `orbitid import-uploads`: legacy TypeScript files keep their public names,
//! are validated, never follow symlinks and are imported exactly once.

#![allow(clippy::unwrap_used, clippy::expect_used)]

use axum::http::StatusCode;
use orbitid_core::testing::{test_state, TestClient};
use orbitid_identity::testing::test_app_state;
use std::path::PathBuf;

const PNG: &[u8] = &[
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
    0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
    0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x63, 0xf8, 0xcf, 0xc0, 0x00,
    0x00, 0x03, 0x01, 0x01, 0x00, 0xc9, 0xfe, 0x92, 0xef, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e,
    0x44, 0xae, 0x42, 0x60, 0x82,
];

fn temp_dir() -> PathBuf {
    let path = std::env::temp_dir().join(format!(
        "orbitid-import-uploads-{}",
        orbitid_core::crypto::random_token(8)
    ));
    std::fs::create_dir_all(path.join("uploads/orgs")).unwrap();
    path
}

#[tokio::test]
async fn imports_a_legacy_avatar_and_logo_once_and_serves_them() {
    let app = test_app_state().await;
    let state = app.state();
    let dir = temp_dir();
    let avatar = "usr_legacy_0123456789abcdef01234567.png";
    let logo = "org_legacy_0123456789abcdef01234567.png";
    std::fs::write(dir.join("uploads").join(avatar), PNG).unwrap();
    std::fs::write(dir.join("uploads/orgs").join(logo), PNG).unwrap();
    std::fs::write(dir.join("uploads/not-an-image.txt"), b"hello").unwrap();

    let first = orbitid_server::import_uploads::import_legacy_uploads(state, &dir)
        .await
        .expect("import");
    assert_eq!(first.imported, 2);
    assert_eq!(first.skipped, 1);

    let second = orbitid_server::import_uploads::import_legacy_uploads(state, &dir)
        .await
        .expect("second import");
    assert_eq!(second.imported, 0);
    assert_eq!(second.skipped, 3, "both present files and the non-image");

    let client = TestClient::new(orbitid_server::build_app(state.clone()));
    for (path, expected) in [
        (format!("/v1/client/images/{avatar}"), StatusCode::OK),
        (
            format!("/v1/client/organization_logos/{logo}"),
            StatusCode::OK,
        ),
    ] {
        let response = client.get(&path, &[]).await;
        assert_eq!(response.status, expected, "{path}");
        assert_eq!(response.body, PNG);
    }
    std::fs::remove_dir_all(&dir).ok();
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlink_out_of_the_directory_is_never_followed() {
    let ctx = test_state().await;
    let dir = temp_dir();
    let outside = temp_dir();
    let target = outside.join("outside.png");
    std::fs::write(&target, PNG).unwrap();
    std::os::unix::fs::symlink(&target, dir.join("uploads/linked.png")).unwrap();

    let summary = orbitid_server::import_uploads::import_legacy_uploads(&ctx.state, &dir)
        .await
        .expect("import");
    assert_eq!(summary.imported, 0);
    assert_eq!(summary.skipped, 1);
    let exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM uploads WHERE file = 'linked.png')")
            .fetch_one(&ctx.state.pool)
            .await
            .unwrap();
    assert!(!exists);
    std::fs::remove_dir_all(&dir).ok();
    std::fs::remove_dir_all(&outside).ok();
}

#[cfg(unix)]
#[tokio::test]
async fn a_symlinked_orgs_directory_is_not_followed() {
    let ctx = test_state().await;
    let dir = temp_dir();
    let outside = temp_dir();
    std::fs::write(dir.join("uploads/avatar.png"), PNG).unwrap();
    std::fs::write(outside.join("outside-logo.png"), PNG).unwrap();
    std::fs::remove_dir_all(dir.join("uploads/orgs")).unwrap();
    std::os::unix::fs::symlink(outside.join("uploads"), dir.join("uploads/orgs")).unwrap();

    let summary = orbitid_server::import_uploads::import_legacy_uploads(&ctx.state, &dir)
        .await
        .expect("import");
    assert_eq!(summary.imported, 1, "only the avatar is imported");
    let logo: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM uploads WHERE file = 'outside-logo.png'")
            .fetch_one(&ctx.state.pool)
            .await
            .unwrap();
    assert_eq!(logo, 0, "the symlinked orgs directory was followed");
    std::fs::remove_dir_all(&dir).ok();
    std::fs::remove_dir_all(&outside).ok();
}

/// A legacy file whose name does not contain the owner id still gets the owner
/// the stored pointer references, so deleting the user removes it.
#[tokio::test]
async fn the_owner_is_resolved_from_the_stored_pointer() {
    let app = test_app_state().await;
    let state = app.state();
    let user =
        orbitid_identity::testing::create_test_user(state, "pointed@example.com", "Sup3r-secret!")
            .await
            .unwrap();
    let org = orbitid_identity::testing::create_test_organization(
        state,
        "Pointed Org",
        None,
        &user.user.id,
    )
    .await
    .unwrap();
    let dir = temp_dir();
    let avatar = "plain-avatar.png";
    let logo = "plain-logo.png";
    std::fs::write(dir.join("uploads").join(avatar), PNG).unwrap();
    std::fs::write(dir.join("uploads/orgs").join(logo), PNG).unwrap();
    sqlx::query("UPDATE users SET image_url = $1 WHERE id = $2")
        .bind(format!("http://localhost:4000/v1/client/images/{avatar}"))
        .bind(&user.user.id)
        .execute(&state.pool)
        .await
        .unwrap();
    sqlx::query("UPDATE organizations SET image_url = $1 WHERE id = $2")
        .bind(format!(
            "http://localhost:4000/v1/client/organization_logos/{logo}"
        ))
        .bind(&org.id)
        .execute(&state.pool)
        .await
        .unwrap();

    let summary = orbitid_server::import_uploads::import_legacy_uploads(state, &dir)
        .await
        .expect("import");
    assert_eq!(summary.imported, 2);
    let owners: Vec<(String, String)> =
        sqlx::query_as("SELECT file, owner_id FROM uploads ORDER BY file")
            .fetch_all(&state.pool)
            .await
            .unwrap();
    assert_eq!(
        owners,
        vec![
            (avatar.to_string(), user.user.id.clone()),
            (logo.to_string(), org.id.clone()),
        ]
    );
    // Deleting the user removes the pointer-resolved avatar.
    orbitid_identity::users::delete_user(state, &user.user.id)
        .await
        .unwrap();
    let avatar_left: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM uploads WHERE file = $1")
        .bind(avatar)
        .fetch_one(&state.pool)
        .await
        .unwrap();
    assert_eq!(avatar_left, 0);
    std::fs::remove_dir_all(&dir).ok();
}

/// A file name is globally unique (the public URL has no bucket in it), so a
/// name that already exists in another bucket is an error, not an overwrite.
#[tokio::test]
async fn a_cross_bucket_name_collision_is_an_error() {
    let app = test_app_state().await;
    let state = app.state();
    let mut conn = state.pool.acquire().await.unwrap();
    orbitid_identity::uploads::store_upload_on(
        &mut conn,
        orbitid_identity::uploads::AVATAR_BUCKET,
        "usr_one",
        "collision.png",
        "image/png",
        PNG,
    )
    .await
    .unwrap();
    let error = orbitid_identity::uploads::store_upload_on(
        &mut conn,
        orbitid_identity::uploads::LOGO_BUCKET,
        "org_one",
        "collision.png",
        "image/png",
        PNG,
    )
    .await
    .expect_err("cross-bucket collision");
    assert_eq!(error.code, "duplicate_record");
    // Release the held connection before asking the pool for another one.
    drop(conn);
    let bucket: String =
        sqlx::query_scalar("SELECT bucket FROM uploads WHERE file = 'collision.png'")
            .fetch_one(&state.pool)
            .await
            .unwrap();
    assert_eq!(bucket, orbitid_identity::uploads::AVATAR_BUCKET);
}
