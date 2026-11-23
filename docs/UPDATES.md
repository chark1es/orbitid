# Updates

How an OrbitID instance learns about new releases, which image tags to follow, and how to let updates apply
themselves. Upgrading itself (pull, restart, migrations on boot) is in
[SELF_HOSTING.md](SELF_HOSTING.md#upgrading).

## Version and update check

The running version is printed at startup (`Version : …`) and returned by `GET /v1/instance` as
`version.current`. Every 6 hours each replica asks
`https://api.github.com/repos/chark1es/orbitid/releases/latest` for the newest published release and keeps
the answer in memory; when it is newer by semver, the dashboard's top bar shows **Update available** with a
link to the release notes, and the log says so. Nothing is shown while the instance is current.

The request is an unauthenticated `GET` with the `orbitid/<crate version>` user agent (the `Cargo.toml`
version). It sends no keys, URLs,
counts or other instance data. If GitHub cannot be reached (offline, firewalled, rate limited) the check
retries an hour later, keeps the last answer and logs only at `debug`. It is on by default because an
authentication server that falls behind on security fixes is the larger risk; set `ORBITID_UPDATE_CHECK=false`
to make no request at all (see [ENVIRONMENT.md](ENVIRONMENT.md)). The check only reports: it never downloads
or installs anything.

## Image tags and pinning

Release images are published as `ghcr.io/chark1es/orbitid` with four kinds of tag:

| Tag | Moves to | Use it for |
| --- | --- | --- |
| `1.4.2` (`X.Y.Z`) | never moves | Production you upgrade by hand. Reproducible: every restart runs the same build. |
| `1.4` (`X.Y`) | the newest patch release of 1.4 | Unattended updates that take only bug and security fixes. |
| `1` (`X`) | the newest 1.x release | Unattended updates that also take new features. Breaking changes only arrive with a new major version. |
| `latest` | the newest release of any major version | Trying OrbitID out. Do not auto-update production on it: it crosses major versions. |

While OrbitID is below 1.0, semver allows breaking changes in a minor release, so pin unattended updates to
`0.Y` rather than `0`. The update indicator still announces a newer major (or minor, for `0.Y`) release that a
pinned tag will not pick up; that upgrade is a deliberate, manual step.

To run a published image with the bundled compose file, remove `build: .` from the `orbitid` service and set
`ORBITID_IMAGE=ghcr.io/chark1es/orbitid:1.4.2` (or the tag you chose) in `.env`.

## Automatic updates (opt-in)

OrbitID never replaces itself. To update unattended, let something outside the container pull a pinned tag and
recreate the container; the boot sequence above then migrates safely. Before turning this on, schedule
database backups ([Backups](SELF_HOSTING.md#backups)): a backup is the only way back across a migration.

The simplest form needs no extra container. A cron entry or systemd timer on the Docker host, in the
directory with `docker-compose.yml`:

```bash
# Daily at 04:00, with ORBITID_IMAGE=ghcr.io/chark1es/orbitid:1 (or 0.Y) in .env and no `build:` section.
docker compose pull orbitid && docker compose up -d orbitid
```

`up -d` recreates the container only when the pull fetched a new image. Compose stops the old container
first (`stop_grace_period: 30s`, so in-flight requests drain), and the healthcheck reports the new one once it
has migrated and is listening.

[`docker-compose.autoupdate.yml`](../docker-compose.autoupdate.yml) is the same thing as a compose overlay
using [Watchtower](https://containrrr.dev/watchtower/), for hosts where a timer is not convenient. It runs
the published image on the tag in `ORBITID_AUTOUPDATE_TAG` and lets Watchtower update only the OrbitID
container, daily at 04:00 (`WATCHTOWER_SCHEDULE` changes that):

```bash
echo 'ORBITID_AUTOUPDATE_TAG=0.1' >> .env   # or 1, 1.4, … — never latest
docker compose -f docker-compose.yml -f docker-compose.autoupdate.yml up -d
```

It needs Docker Compose 2.24.4 or newer (it removes the base file's `build:` with `!reset`). Watchtower reads
the Docker socket, which is equivalent to root on the host; prefer the timer when that matters. Neither form
rolls back on its own: if a new release fails to boot, the old container is already gone, so pin the previous
`X.Y.Z` tag, and restore the backup if the failed release had migrated the database.

Migration `0010` builds the verified-domain index with `CREATE INDEX CONCURRENTLY` (a non-transactional
migration), so a large `email_addresses` table keeps accepting writes while it is indexed; the build can take a
while on a big table. If a build was interrupted, the invalid leftover index is dropped automatically on the next
boot and rebuilt. Migration `0011` is metadata only (two columns on `organization_domains`, a small
`worker_cursors` table) and is instant. Domains verified before the upgrade are not re-enrolled automatically;
switch the mode off and on again to run an enrollment pass. Migration `0012` adds three nullable columns on
`organization_domains` (instant).

**A stuck enrollment domain.** If an enrollment chunk keeps failing, the worker backs off (30 s, doubling, at most
1 h between attempts), logs each failure at `error` with the domain id and never discards a membership. To see
stuck domains: `SELECT id, enrollment_failures, enrollment_last_error, enrollment_next_attempt_at FROM
organization_domains WHERE enrollment_failures > 0;`. Fix the cause (usually the webhook outbox or a database
constraint); the next attempt after `enrollment_next_attempt_at` completes the pass and resets the counters.
