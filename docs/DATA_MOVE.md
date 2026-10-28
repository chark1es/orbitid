# Moving data between databases

OrbitID stores everything in one database, either Postgres (recommended) or SQLite. The two use the same
tables with separate migration histories, and the server process only ever loads one of them: the dialect
is fixed from `ORBITID_DATABASE_URL` (or `ORBITID_DB_DIALECT`) when the process starts. Because of that,
a copy always runs as two processes — one that reads the source, one that writes the target — joined by a
portable, streaming text format.

The format is JSON Lines:

- the first line is a header (`orbitid_export`, `dialect`, `schema_version`, `tables`, per-table `counts`,
  and an encrypted `key_check` canary),
- then one line per row, `{ "t": "<table>", "r": { ... } }`,
- values are portable: timestamps are epoch milliseconds (numbers), booleans are real booleans, JSON
  columns are JSON. Nothing is dialect specific.

Large tables are read page by page in primary-key order, so memory stays flat no matter how big the
instance is. Secrets are copied exactly as stored — password digests, TOTP secrets, backup-code hashes,
passkeys, client token hashes, OAuth tokens, webhook signing secrets and the JWT signing key (still
encrypted with `ORBITID_ENCRYPTION_KEY`). Nothing is re-hashed or re-encrypted, which is why the source and
target must share the same encryption key.

Tables whose contents describe a running process rather than the instance (`rate_limits` counters) are not
copied. Everything else is, including webhook endpoints, deliveries, audit logs, sessions and one-time
tokens; the target behaves like the source immediately.

## When to use it

- **SQLite to Postgres** as an instance outgrows a single file (the usual reason).
- **Postgres to SQLite** to shrink a small instance back to a single file, for example for an archive or a
  test copy.
- **Backup and restore.** An export is a complete, portable logical backup (see the caveat about uploads
  below).
- **Cross-version upgrades.** Export with the old version, start the new version on an empty database so it
  applies its migrations, then import. Columns added since the export get their defaults.

Uploaded profile images and organization logos are *not* in the export: they live on disk under
`ORBITID_DATA_DIR/uploads` (see [SELF_HOSTING.md](SELF_HOSTING.md#backups)). Copy that directory alongside
the data, and keep a copy of `ORBITID_ENCRYPTION_KEY` and `ORBITID_SECRET_KEY`. Without the identical
encryption key the import refuses to run, because stored secrets could not be read afterwards.

## Commands

All commands are subcommands of the server CLI, which reads its configuration from the same environment
variables as the server. Run them from a checkout (`bun run --filter @orbitid/server start -- export`) or
with the published `orbitid` binary.

```bash
# Write every table to a file (or to stdout with `--out -`).
orbitid export --out orbitid-export.jsonl

# Load into the configured (already migrated) database.
orbitid import --in orbitid-export.jsonl

# Replace the target's contents instead of refusing.
orbitid import --in orbitid-export.jsonl --truncate --yes

# Both at once, each side in its own process.
orbitid copy --from sqlite:/srv/orbitid/orbitid.db --to postgres://orbitid@db.internal/orbitid
```

Details worth knowing:

- `export` writes progress to stderr, so the JSON Lines on stdout stay clean with `--out -`; `import` does the
  same and prints a machine-readable count summary on stdout at the end.
- `import` refuses to write into a database that already holds data. A freshly migrated database (instance
  settings plus the seeded roles and permissions) counts as empty, because those rows are replaced by the
  export's. `--truncate` clears every table first and requires `--yes`; without it nothing is deleted.
- `import` validates the header before touching the target: format version, known tables, dependency-safe
  table order, and the encryption-key canary. A key mismatch fails immediately with a message naming
  `ORBITID_ENCRYPTION_KEY` instead of writing half an instance.
- `import` verifies row counts per table against the counts in the header at the end and exits non-zero on
  any mismatch, naming the tables that differ.
- `copy` passes each database URL to its child processes through the environment, never through argv, and
  prints only redacted URLs (scheme, user, host, path — no password). It ends with a per-table
  `imported -> target` comparison.
- `--from`/`--to` accept the same URLs as `ORBITID_DATABASE_URL`: `postgres://…`, `postgresql://…`,
  `pglite://…`, `sqlite:/path/to/file.db`, or a plain path.

## Moving a live instance

The export reads table by table, so writes that happen during the export can leave it inconsistent. Stop
writes first; the whole procedure is fast and the downtime is the length of the export plus the import.

1. **Stop the server** (or remove it from the load balancer and wait for in-flight requests), so nothing
   writes to the source database. Stop the webhook worker with it: it is part of the server process.
2. **Back up** the old database file or dump, and copy `ORBITID_DATA_DIR/uploads` aside.
3. **Export** from the old database:

   ```bash
   ORBITID_DATABASE_URL=sqlite:/srv/orbitid/orbitid.db \
   ORBITID_ENCRYPTION_KEY=… orbitid export --out /backup/orbitid-$(date +%F).jsonl
   ```

4. **Prepare the target.** Start the server once against the new, empty database (or run `orbitid migrate`)
   so it creates the schema, then stop it again:

   ```bash
   ORBITID_DATABASE_URL=postgres://orbitid@db.internal/orbitid \
   ORBITID_ENCRYPTION_KEY=… orbitid migrate
   ```

5. **Import** into the target with the *same* `ORBITID_ENCRYPTION_KEY`:

   ```bash
   ORBITID_DATABASE_URL=postgres://orbitid@db.internal/orbitid \
   ORBITID_ENCRYPTION_KEY=… orbitid import --in /backup/orbitid-$(date +%F).jsonl
   ```

   Or do steps 3 and 5 in one command: `orbitid copy --from sqlite:/srv/orbitid/orbitid.db --to
   postgres://orbitid@db.internal/orbitid`.

6. **Switch** `ORBITID_DATABASE_URL` in the server's environment to the new database. Remove
   `ORBITID_DB_DIALECT` if you set it: the URL's scheme is enough, and forcing the old dialect would point
   the process at the wrong schema. Keep `ORBITID_ENCRYPTION_KEY` and `ORBITID_SECRET_KEY` unchanged so
   sessions, signing keys and API keys keep working.
7. **Start the server** and verify: sign in with a known password (and a second factor if the account has
   one), load the dashboard, accept a pending organization invitation, send a webhook test event.
8. Keep the old database and the export until the new instance has run for a while.

Because the export only reads and the import verifies what it wrote, a failed attempt costs nothing: fix the
problem and run the import again into a freshly truncated target.

## Restoring a backup

Restore is the same as a move into the same dialect: start the new server once against an empty database to
create the schema (`orbitid migrate`), then `orbitid import --in <file>` with the original encryption key,
and finally copy `ORBITID_DATA_DIR/uploads` back into place.
