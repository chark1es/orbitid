//! Release check: version comparison, GitHub response parsing, the in-memory
//! cache and the fetch against a local stand-in for the GitHub API. No
//! database and no real network.

use axum::http::StatusCode;
use axum::routing::get;
use axum::{Json, Router};
use orbitid_platform::release::{
    current_version, fetch_latest, is_newer, parse_release, parse_version, LatestRelease,
    ReleaseCheck, CHECK_INTERVAL, RETRY_INTERVAL,
};
use serde_json::json;

fn release(tag: &str) -> LatestRelease {
    LatestRelease {
        version: parse_version(tag).unwrap(),
        tag: tag.to_string(),
    }
}

#[test]
fn compares_by_semver_precedence() {
    let v = |raw: &str| parse_version(raw).unwrap();
    assert!(is_newer("0.1.0", &v("0.2.0")));
    assert!(is_newer("0.9.9", &v("0.10.0")), "numeric, not lexical");
    assert!(
        is_newer("1.0.0-rc.1", &v("1.0.0")),
        "a release beats its rc"
    );
    assert!(is_newer("v1.2.3", &v("1.2.4")), "a leading v is accepted");
    assert!(!is_newer("0.2.0", &v("0.2.0")));
    assert!(
        !is_newer("0.3.0", &v("0.2.0")),
        "never suggests a downgrade"
    );
    assert!(
        !is_newer("1.0.0+build.5", &v("1.0.0")),
        "build metadata is ignored"
    );
    assert!(
        !is_newer("custom-build", &v("9.9.9")),
        "an unknown current version stays quiet"
    );
}

#[test]
fn the_running_version_is_semver() {
    assert!(
        parse_version(current_version()).is_some(),
        "{}",
        current_version()
    );
}

#[test]
fn reads_a_published_release_and_skips_the_rest() {
    let published = json!({ "tag_name": "v1.4.2", "draft": false, "prerelease": false });
    let parsed = parse_release(&published);
    assert_eq!(parsed, Some(release("v1.4.2")));
    assert_eq!(
        parsed.unwrap().release_url(),
        "https://github.com/chark1es/orbitid/releases/tag/v1.4.2"
    );
    assert_eq!(
        parse_release(&json!({ "tag_name": "1.4.2" })),
        Some(release("1.4.2"))
    );

    assert_eq!(
        parse_release(&json!({ "tag_name": "v2.0.0", "draft": true })),
        None
    );
    assert_eq!(
        parse_release(&json!({ "tag_name": "v2.0.0", "prerelease": true })),
        None
    );
    assert_eq!(parse_release(&json!({ "tag_name": "v2.0.0-beta.1" })), None);
    assert_eq!(parse_release(&json!({ "tag_name": "nightly" })), None);
    assert_eq!(parse_release(&json!({ "message": "Not Found" })), None);
}

#[test]
fn the_link_is_built_from_the_tag_not_the_response() {
    let parsed = parse_release(&json!({
        "tag_name": "v1.0.0",
        "html_url": "https://evil.example/phish",
    }))
    .unwrap();
    assert!(parsed
        .release_url()
        .starts_with("https://github.com/chark1es/orbitid/releases/tag/"));
}

#[test]
fn caches_the_last_answer_and_keeps_it_through_failures() {
    let check = ReleaseCheck::new(true, "0.1.0");
    let empty = check.status();
    assert_eq!(empty.current, "0.1.0");
    assert!(empty.update_check);
    assert_eq!(empty.latest, None);
    assert!(!empty.update_available);
    assert_eq!(empty.checked_at, None);

    assert_eq!(check.record(Ok(release("v0.2.0")), 1_000), CHECK_INTERVAL);
    let found = check.status();
    assert_eq!(found.latest.as_deref(), Some("0.2.0"));
    assert!(found.update_available);
    assert_eq!(
        found.release_url.as_deref(),
        Some("https://github.com/chark1es/orbitid/releases/tag/v0.2.0")
    );
    assert_eq!(found.checked_at, Some(1_000));

    // Offline: retry sooner, keep showing what was last known.
    assert_eq!(check.record(Err("offline".into()), 2_000), RETRY_INTERVAL);
    assert_eq!(check.status(), found);
    assert!(RETRY_INTERVAL < CHECK_INTERVAL);
}

#[test]
fn reports_nothing_when_current_or_disabled() {
    let current = ReleaseCheck::new(true, "0.2.0");
    current.record(Ok(release("v0.2.0")), 1);
    let status = current.status();
    assert!(!status.update_available);
    assert_eq!(status.latest.as_deref(), Some("0.2.0"));

    let disabled = ReleaseCheck::new(false, "0.1.0");
    disabled.record(Ok(release("v0.2.0")), 1);
    let status = disabled.status();
    assert!(!status.update_check);
    assert!(!status.update_available);
    assert_eq!(status.latest, None);
    assert_eq!(status.release_url, None);
    assert_eq!(status.current, "0.1.0");
}

async fn serve(router: Router) -> String {
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });
    format!("http://{address}/latest")
}

#[tokio::test]
async fn fetches_the_latest_release_and_fails_quietly() {
    let client = reqwest::Client::builder()
        .user_agent("orbitid/test")
        .build()
        .unwrap();

    let body = json!({ "tag_name": "v3.1.0", "draft": false, "prerelease": false });
    let router = Router::new().route("/latest", get(move || async move { Json(body) }));
    let ok = serve(router).await;
    assert_eq!(fetch_latest(&client, &ok).await, Ok(release("v3.1.0")));

    // A repository without releases answers 404; GitHub's rate limit answers 403.
    for status in [StatusCode::NOT_FOUND, StatusCode::FORBIDDEN] {
        let url = serve(Router::new().route("/latest", get(move || async move { status }))).await;
        let error = fetch_latest(&client, &url).await.unwrap_err();
        assert!(error.contains(status.as_str()), "{error}");
    }

    let garbage = serve(Router::new().route("/latest", get(|| async { "<html>" }))).await;
    assert!(fetch_latest(&client, &garbage).await.is_err());

    // Nothing listening: the offline case.
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let closed = format!("http://{}/latest", listener.local_addr().unwrap());
    drop(listener);
    assert!(fetch_latest(&client, &closed).await.is_err());
}
