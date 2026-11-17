//! Avatar upload security (`test/security/uploads.test.ts`, image half of
//! `test/avatar.test.ts`). Organization logos are covered in `orgs.rs`.

mod common;

use axum::http::StatusCode;
use common::*;
use serde_json::json;

fn png_fixture() -> Vec<u8> {
    decode_base64(PNG_1X1)
}

fn gif_fixture() -> Vec<u8> {
    // GIF89a header, logical screen descriptor, trailer.
    let mut bytes = b"GIF89a".to_vec();
    bytes.extend_from_slice(&[0x01, 0x00, 0x01, 0x00, 0x00, 0x00, 0x00, 0x3b]);
    bytes
}

#[tokio::test]
async fn refuses_polyglots_and_non_raster_payloads() {
    let h = harness().await;
    let user = h.signed_in("polyglot@example.com", "Sup3r-secret!").await;

    let gif = gif_fixture();
    let gif_polyglot = {
        let mut bytes = gif[..gif.len() - 1].to_vec();
        bytes.extend_from_slice(b"<html><script>alert(1)</script></html>");
        bytes
    };
    let png_with_trailer = {
        let mut bytes = png_fixture();
        bytes.extend_from_slice(b"<script>alert(1)</script>");
        bytes
    };
    let mut lying_webp = Vec::new();
    lying_webp.extend_from_slice(b"RIFF");
    lying_webp.extend_from_slice(&4u32.to_le_bytes());
    lying_webp.extend_from_slice(b"WEBPVP8 ");
    lying_webp.extend_from_slice(&[0u8; 8]);

    for (mime, bytes) in [
        ("image/gif", gif_polyglot),
        ("image/png", png_with_trailer),
        ("image/webp", lying_webp),
        ("image/png", b"<html></html>".to_vec()),
        ("image/png", b"not an image".to_vec()),
    ] {
        let response = user
            .client
            .request(
                "POST",
                "/v1/client/me/profile_image",
                Some(json!({ "file": data_url(mime, &base64_encode(&bytes)) })),
                &[],
            )
            .await;
        assert_eq!(response.status, StatusCode::UNPROCESSABLE_ENTITY, "{mime}");
        let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM uploads")
            .fetch_one(&h.state().pool)
            .await
            .expect("count");
        assert_eq!(stored, 0);
    }
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

#[tokio::test]
async fn ignores_the_client_file_name_and_stores_a_random_raster_name() {
    let h = harness().await;
    let user = h.signed_in("filename@example.com", "Sup3r-secret!").await;
    let boundary = "orbitid-upload-boundary";
    let body = multipart_body(
        boundary,
        "../../etc/passwd.png",
        "image/png",
        &png_fixture(),
    );
    let cookie = user.client.cookie_header().expect("cookie");
    let response = raw_request(
        &h.app,
        "POST",
        "/v1/client/me/profile_image",
        &[
            ("cookie", &cookie),
            ("content-type", &multipart_content_type(boundary)),
        ],
        body,
    )
    .await;
    assert_status(&response, StatusCode::OK);
    let image_url = response.value()["response"]["image_url"]
        .as_str()
        .expect("image url")
        .to_string();
    let file = image_url.split("/v1/client/images/").nth(1).expect("file");
    assert!(!file.contains("passwd"));
    assert!(file.starts_with("user_"));
    assert!(file.ends_with(".png"));

    let stored: Vec<String> = sqlx::query_scalar("SELECT file FROM uploads")
        .fetch_all(&h.state().pool)
        .await
        .expect("files");
    assert_eq!(stored, vec![file.to_string()]);
}

#[tokio::test]
async fn refuses_empty_and_oversized_uploads() {
    let h = harness().await;
    let user = h.signed_in("oversized@example.com", "Sup3r-secret!").await;

    let empty = user
        .client
        .request(
            "POST",
            "/v1/client/me/profile_image",
            Some(json!({ "file": "" })),
            &[],
        )
        .await;
    assert_eq!(empty.status, StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(error_codes(&empty), vec!["form_param_value_invalid"]);

    let mut huge = png_fixture();
    huge.extend(std::iter::repeat_n(0u8, 5 * 1024 * 1024 + 8));
    let oversized = user
        .client
        .request(
            "POST",
            "/v1/client/me/profile_image",
            Some(json!({ "file": data_url("image/png", &base64_encode(&huge)) })),
            &[],
        )
        .await;
    assert_eq!(oversized.status, StatusCode::PAYLOAD_TOO_LARGE);

    let stored: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM uploads")
        .fetch_one(&h.state().pool)
        .await
        .expect("count");
    assert_eq!(stored, 0);
}

#[tokio::test]
async fn profile_image_upload_can_be_disabled() {
    let h = harness().await;
    h.state()
        .settings
        .update(json!({ "userSettings": { "allowProfileImageUpload": false } }))
        .await
        .expect("settings");
    let user = h
        .signed_in("disabled-upload@example.com", "Sup3r-secret!")
        .await;
    let response = user
        .client
        .request(
            "POST",
            "/v1/client/me/profile_image",
            Some(json!({ "file": data_url("image/png", PNG_1X1) })),
            &[],
        )
        .await;
    assert_eq!(response.status, StatusCode::FORBIDDEN);
    assert_eq!(error_codes(&response), vec!["not_allowed_access"]);
}

#[tokio::test]
async fn serves_images_to_anonymous_clients_with_immutable_cache_headers() {
    let h = harness().await;
    let user = h
        .signed_in("public-image@example.com", "Sup3r-secret!")
        .await;
    let uploaded = user
        .client
        .request(
            "POST",
            "/v1/client/me/profile_image",
            Some(json!({ "file": data_url("image/gif", GIF_1X1) })),
            &[],
        )
        .await;
    assert_status(&uploaded, StatusCode::OK);
    let path = url::Url::parse(
        uploaded.value()["response"]["image_url"]
            .as_str()
            .expect("image url"),
    )
    .expect("url")
    .path()
    .to_string();

    let anonymous = h.client();
    let served = anonymous.get(&path, &[]).await;
    assert_status(&served, StatusCode::OK);
    assert_eq!(served.headers.get("content-type").unwrap(), "image/gif");
    assert_eq!(
        served.headers.get("cache-control").unwrap(),
        "public, max-age=31536000, immutable"
    );
    assert_eq!(
        served.headers.get("x-content-type-options").unwrap(),
        "nosniff"
    );
    assert_eq!(
        served.headers.get("content-security-policy").unwrap(),
        "sandbox"
    );
}
