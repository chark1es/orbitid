//! Release check: tells the operator when a newer OrbitID release exists.
//!
//! One unauthenticated `GET` to GitHub's "latest release" endpoint, made by a
//! background task every [`CHECK_INTERVAL`] (sooner after a failure). The
//! request carries no instance data: only the `orbitid/<version>` user agent
//! that every outbound call already sends. The answer is kept in memory per
//! replica and read by `GET /v1/instance`, so a dashboard request never waits on
//! GitHub. A failure (offline, rate limited, no releases yet) is logged at debug
//! level and keeps the last good answer. `ORBITID_UPDATE_CHECK=false` turns the
//! request off entirely; the running version is still reported.

use std::cmp::Ordering;
use std::sync::{Arc, RwLock};
use std::time::Duration;

use orbitid_core::http::now;
use orbitid_core::AppState;
use semver::Version;
use serde::Serialize;
use serde_json::Value;

/// GitHub's newest published (non-draft, non-prerelease) release.
pub const LATEST_RELEASE_URL: &str =
    "https://api.github.com/repos/chark1es/orbitid/releases/latest";
/// Release notes live under this page; a release's own page is `<this>/tag/<tag>`.
pub const RELEASES_PAGE: &str = "https://github.com/chark1es/orbitid/releases";
/// How long an answer is trusted before asking again.
pub const CHECK_INTERVAL: Duration = Duration::from_secs(6 * 60 * 60);
/// How long to wait after a failed check (offline, rate limited) before retrying.
pub const RETRY_INTERVAL: Duration = Duration::from_secs(60 * 60);
/// Upper bound for one request, well under the shared client's 30 s.
const FETCH_TIMEOUT: Duration = Duration::from_secs(10);

/// The version this binary was built as. A release build passes
/// `ORBITID_BUILD_VERSION` (the image's build argument, e.g. `1.4.2` or
/// `v1.4.2`); otherwise it is the workspace's `Cargo.toml` version.
pub fn current_version() -> &'static str {
    match option_env!("ORBITID_BUILD_VERSION") {
        Some(version) if !version.trim().is_empty() => {
            version.trim().trim_start_matches(['v', 'V'])
        }
        _ => env!("CARGO_PKG_VERSION"),
    }
}

/// Parses `1.2.3` or `v1.2.3`.
pub fn parse_version(raw: &str) -> Option<Version> {
    Version::parse(raw.trim().trim_start_matches(['v', 'V'])).ok()
}

/// True when `latest` is a newer release than `current` by semver precedence
/// (build metadata is ignored; `1.0.0-rc.1` is older than `1.0.0`). An
/// unparseable current version (a custom build) never reports an update.
pub fn is_newer(current: &str, latest: &Version) -> bool {
    let Some(current) = parse_version(current) else {
        return false;
    };
    precedence(latest, &current) == Ordering::Greater
}

fn precedence(a: &Version, b: &Version) -> Ordering {
    (a.major, a.minor, a.patch)
        .cmp(&(b.major, b.minor, b.patch))
        // An empty pre-release sorts after any non-empty one.
        .then_with(|| a.pre.cmp(&b.pre))
}

/// The newest release GitHub reported.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LatestRelease {
    pub version: Version,
    /// The tag as published (`v1.2.3`).
    pub tag: String,
}

impl LatestRelease {
    /// Built from the tag, never taken from the response, so the dashboard
    /// only ever links to this repository's release pages. The tag parsed as
    /// semver, so it holds only URL-safe characters.
    pub fn release_url(&self) -> String {
        format!("{RELEASES_PAGE}/tag/{}", self.tag)
    }
}

/// Reads a GitHub release object. Drafts, pre-releases and tags that are not
/// semver are ignored.
pub fn parse_release(body: &Value) -> Option<LatestRelease> {
    let flag = |name: &str| body.get(name).and_then(Value::as_bool).unwrap_or(false);
    if flag("draft") || flag("prerelease") {
        return None;
    }
    let tag = body.get("tag_name")?.as_str()?.trim();
    let version = parse_version(tag)?;
    if !version.pre.is_empty() {
        return None;
    }
    Some(LatestRelease {
        version,
        tag: tag.to_string(),
    })
}

/// Asks `url` for the latest release. Errors are short descriptions for a
/// debug log; none is ever shown to a user.
pub async fn fetch_latest(client: &reqwest::Client, url: &str) -> Result<LatestRelease, String> {
    let response = client
        .get(url)
        .header("accept", "application/vnd.github+json")
        .header("x-github-api-version", "2022-11-28")
        .timeout(FETCH_TIMEOUT)
        .send()
        .await
        .map_err(|error| format!("request failed: {error}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!("status {status}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("unreadable body: {error}"))?;
    let body: Value =
        serde_json::from_slice(&bytes).map_err(|error| format!("unreadable body: {error}"))?;
    parse_release(&body).ok_or_else(|| "no usable release in the response".to_string())
}

#[derive(Debug, Clone, Default)]
struct Snapshot {
    latest: Option<LatestRelease>,
    /// When `latest` was last confirmed (ms since the epoch).
    checked_at: Option<i64>,
}

/// The in-memory answer for this replica.
#[derive(Debug)]
pub struct ReleaseCheck {
    enabled: bool,
    current: String,
    snapshot: RwLock<Snapshot>,
}

/// What `GET /v1/instance` reports under `version`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct VersionStatus {
    /// The running version.
    pub current: String,
    /// Whether this server asks GitHub for new releases (`ORBITID_UPDATE_CHECK`).
    pub update_check: bool,
    /// The newest release, once a check has succeeded.
    pub latest: Option<String>,
    pub update_available: bool,
    /// Release notes for `latest`.
    pub release_url: Option<String>,
    /// When `latest` was last confirmed (ms since the epoch).
    pub checked_at: Option<i64>,
}

impl ReleaseCheck {
    pub fn new(enabled: bool, current: impl Into<String>) -> Self {
        Self {
            enabled,
            current: current.into(),
            snapshot: RwLock::new(Snapshot::default()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.enabled
    }

    /// Stores the outcome of one check and returns how long to wait before the
    /// next one. A failure keeps the last good answer.
    pub fn record(&self, outcome: Result<LatestRelease, String>, now_ms: i64) -> Duration {
        match outcome {
            Ok(latest) => {
                let mut snapshot = self
                    .snapshot
                    .write()
                    .unwrap_or_else(|poison| poison.into_inner());
                snapshot.latest = Some(latest);
                snapshot.checked_at = Some(now_ms);
                CHECK_INTERVAL
            }
            Err(reason) => {
                tracing::debug!(%reason, "release check failed; keeping the last answer");
                RETRY_INTERVAL
            }
        }
    }

    pub fn status(&self) -> VersionStatus {
        let snapshot = self
            .snapshot
            .read()
            .unwrap_or_else(|poison| poison.into_inner())
            .clone();
        let latest = snapshot.latest.filter(|_| self.enabled);
        VersionStatus {
            current: self.current.clone(),
            update_check: self.enabled,
            update_available: latest
                .as_ref()
                .is_some_and(|latest| is_newer(&self.current, &latest.version)),
            release_url: latest.as_ref().map(LatestRelease::release_url),
            latest: latest.as_ref().map(|latest| latest.version.to_string()),
            checked_at: latest.and(snapshot.checked_at),
        }
    }
}

/// This state's release check, created on first use.
pub fn release_check(state: &AppState) -> Arc<ReleaseCheck> {
    state
        .extensions
        .get_or_insert(|| ReleaseCheck::new(state.env.update_check, current_version()))
}

/// `version` for `GET /v1/instance`.
pub fn version_status(state: &AppState) -> VersionStatus {
    release_check(state).status()
}

/// The background task that keeps [`ReleaseCheck`] fresh. Not started when
/// `ORBITID_UPDATE_CHECK=false`. Dropping it stops the task.
pub struct ReleaseWorker {
    task: tokio::task::JoinHandle<()>,
}

impl Drop for ReleaseWorker {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl ReleaseWorker {
    pub fn start(state: AppState) -> Option<Self> {
        let check = release_check(&state);
        if !check.enabled() {
            tracing::info!("release check disabled (ORBITID_UPDATE_CHECK=false)");
            return None;
        }
        let client = state.http_client.clone();
        let task = tokio::spawn(async move {
            loop {
                let outcome = fetch_latest(&client, LATEST_RELEASE_URL).await;
                let wait = check.record(outcome, now());
                let status = check.status();
                if status.update_available {
                    tracing::info!(
                        current = %status.current,
                        latest = status.latest.as_deref().unwrap_or_default(),
                        "a newer OrbitID release is available"
                    );
                }
                tokio::time::sleep(wait).await;
            }
        });
        Some(Self { task })
    }
}
