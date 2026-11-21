# Moving data between databases

OrbitID stores everything in one Postgres database. The Rust server has no SQLite or PGlite mode: it refuses
any `ORBITID_DATABASE_URL` that is not `postgres://` or `postgresql://`. Moving data therefore means two
Postgres databases (a copy, an archive, a staging instance), or a one-time move off the retired TypeScript
server's SQLite database.

## The transfer format

The CLI moves data as JSON Lines, so a copy is a streaming, portable logical backup:

- the first line is a header (`orbitid_export`, `dialect`, `schema_version`, `tables`, per-table `counts`,
  and an encrypted `key_check` canary),
- then one line per row, `{ "t": "<table>", "r": { ... } }`,
- values are portable: timestamps are epoch milliseconds (numbers), booleans are real booleans, JSON
  columns are JSON.

Large tables are read page by page in primary-key order, so memory stays flat no matter how big the
instance is. Secrets are copied exactly as stored — password digests, TOTP secrets, backup-code hashes,
passkeys, client token hashes, OAuth tokens, webhook signing secrets and the JWT signing key (still
encrypted with `ORBITID_ENCRYPTION_KEY`). Nothing is re-hashed or re-encrypted, which is why the source and
target must share the same encryption key.

Tables whose contents describe a running process or a single deployment are not copied: rate-limit windows,
and `operator_sessions` (dashboard logins). An import holds the owner setup lock while it runs, so dashboard
owner setup cannot create an account on the target meanwhile. A restored instance with accounts but no owner
does not offer setup: give an account the Owner role with `orbitid owner <email>`. Everything else is, including webhook endpoints, deliveries,
audit logs, user sessions and one-time tokens; the target behaves like the source immediately.

Dashboard logins are deliberately left behind. A console session is bound to the browser that opened it, and
copying it would make an old cookie live against the target instance. Owners and administrators open the console
on the target with their accounts, which do move. User sessions are unaffected.

## Commands

All commands are subcommands of the `orbitid` binary and read the same environment variables as the server.

```bash
# Write every table to a file (or to stdout with `--out -`).
orbitid export --out orbitid-export.jsonl

# Load into the configured (already migrated) database.
orbitid import --in orbitid-export.jsonl

# Replace the target's contents instead of refusing.
orbitid import --in orbitid-export.jsonl --truncate --yes
```

`export` and `import` move data between two Postgres databases. The SQLite/PGlite URL forms (`sqlite:…`,
`pglite://…`, a plain path) were removed together with those drivers; the last TypeScript release still
accepts them and is the tool for a one-way move off SQLite.

`copy` moves one database into another in a single step. Each side is a URL (`--from`, `--to`) or split
settings from the environment, which keeps the password out of the process list and needs no encoding:

```bash
ORBITID_COPY_FROM_HOST=old-db ORBITID_COPY_FROM_USER=orbit ORBITID_COPY_FROM_PASSWORD='p/a+s=s@w:rd' \
ORBITID_COPY_FROM_NAME=orbitid \
ORBITID_COPY_TO_HOST=new-db ORBITID_COPY_TO_USER=orbit ORBITID_COPY_TO_PASSWORD='…' \
ORBITID_COPY_TO_NAME=orbitid \
orbitid copy
```

`HOST` and `NAME` are required for a side given this way; `PORT` defaults to 5432. In the URL form a password
containing `/ + = @ : % # ?` or a space must be percent-encoded (`p/a+s=s@w:rd` is `p%2Fa%2Bs%3Ds%40w%3Ard`);
the environment form needs no encoding. A URL given on the command line wins over the variables of that side.

`copy` stages the export on the local disk (a private `0700` directory under the system temp directory, the
file `0600`, removed when the command ends, including on SIGINT/SIGTERM, which abort the copy with an error) before importing it, so the machine running it needs free space for
the whole export. The import runs in one transaction, so an interrupted copy leaves the target's rows as they were (schema migrations
already applied to the target stay). Once the import has sent its `COMMIT` the signals are ignored and the copy finishes, so an
interrupt can never leave the outcome unknown. SIGKILL (or a power loss) cannot be handled: the `orbitid-transfer-*` directory
then stays under the system temp directory (`$TMPDIR`, else `/tmp`) and must be deleted by hand. Use `export --out` and `import` to place the file yourself.

Details worth knowing:

- `export` writes progress to stderr, so the JSON Lines on stdout stay clean with `--out -`; `import` does the
  same and prints a machine-readable count summary on stdout at the end.
- `export` and the source side of `copy` never write to the source database: they do **not** run migrations
  (the target of a `copy` and `import` do). The source must already be at exactly the schema of this binary;
  otherwise the command stops and changes nothing. A source behind it (including a database still managed by
  the TypeScript server) needs `orbitid migrate` run against it first; a source ahead of it needs the newer
  OrbitID release.
- `import` refuses to write into a database that already holds data. A freshly migrated database (instance
  settings plus the seeded roles and permissions) counts as empty, because those rows are replaced by the
  export's. `--truncate` clears every table first and requires `--yes`; without it nothing is deleted.
- `import` validates the header before touching the target: format version, known tables, dependency-safe
  table order, and the encryption-key canary. A key mismatch fails immediately with a message naming
  `ORBITID_ENCRYPTION_KEY` instead of writing half an instance.
- `import` verifies row counts per table against the counts in the header at the end and exits non-zero on
  any mismatch, naming the tables that differ.
- A failed import runs in one transaction: a bad line, a constraint failure or a row-count mismatch rolls
  everything back and leaves the target as it was.
- The import applies today's column defaults to old rows. An export taken before a column was added (in
  particular one from the TypeScript server, which predates `sign_ins.version`, `sign_ups.version` and
  `instance.revision`) imports without a not-null failure; a NOT NULL column with no default must be in the
  export, and the error names the table and column.
- After loading rows the import bumps `instance.revision = revision + 1`. A replica only publishes a settings
  snapshot whose revision is greater than the one it already holds, so the imported settings are not ignored
  as stale. Because a running replica may have published a higher revision before the import, **restart every
  server after an import** (or let each replica refresh within about a minute through the two-refresh adoption
  rule). Restarting is the deterministic option.

## Upgrading from the TypeScript server

The rewrite keeps the same tables and the same HTTP contract. The Rust server adopts an existing
drizzle-migrated Postgres database automatically: `0001_baseline.sql` is a byte-for-byte replay of drizzle
0000–0009 and the migration ledger is baselined through `drizzle.__drizzle_migrations`. A database behind
drizzle 0009 is refused with an actionable message rather than half-migrated.

`orbitid copy` and `orbitid export` never write to their source, so pointed at a database that is still
managed by the TypeScript server they refuse and say so: either run `orbitid migrate` against it (that adopts
and upgrades it in place and **writes to that database**), or export it with the TypeScript server and
`orbitid import` the file instead.

**Postgres users** point the new binary at the same `ORBITID_DATABASE_URL`, keep the same
`ORBITID_ENCRYPTION_KEY`, and start it:

```bash
ORBITID_DATABASE_URL=postgres://orbitid@db.internal/orbitid \
ORBITID_ENCRYPTION_KEY=… orbitid start
```

**SQLite and PGlite users** must move to Postgres first, using the *last TypeScript release* (the Rust
server cannot read those files):

```bash
# Still on the TypeScript release, with the old SQLite file:
orbitid copy --from sqlite:/srv/orbitid/orbitid.db --to postgres://orbitid@db.internal/orbitid

# Then switch the environment to that Postgres URL and run the Rust server.
ORBITID_DATABASE_URL=postgres://orbitid@db.internal/orbitid \
ORBITID_ENCRYPTION_KEY=… orbitid start
```

Keep `ORBITID_ENCRYPTION_KEY` and `ORBITID_SECRET_KEY` unchanged across the switch, or stored secrets cannot
be decrypted and existing sessions/API keys stop working. See [SELF_HOSTING.md](SELF_HOSTING.md#upgrading)
for the deployment steps.

### Uploaded avatars and logos

The TypeScript server wrote profile images (`<dataDir>/uploads/<file>`) and organization logos
(`<dataDir>/uploads/orgs/<file>`). The Rust server serves the same public URLs from the `uploads` table, so any
replica can answer. Import the old files under their existing names instead of re-uploading them:

```bash
ORBITID_DATABASE_URL=postgres://orbitid@db.internal/orbitid \
ORBITID_ENCRYPTION_KEY=… orbitid import-uploads --from /srv/orbitid/data
```

The import is idempotent, validates each image with the same sniffing as an upload, skips files already in
the table and never follows symlinks out of the directory. Database exports contain the upload rows, so after
the import a logical backup carries everything a running instance needs.

## Moving a live Postgres instance

The export reads table by table, so writes that happen during the export can leave it inconsistent. Stop
writes first; the downtime is the length of the export plus the import.

1. **Stop the server** (or remove every replica from the load balancer and wait for in-flight requests), so
   nothing writes to the source database. Webhook delivery and cleanup workers are part of the server
   process, so they stop with it.
2. **Back up** the source with `pg_dump` (or your provider's snapshot) and keep a copy of
   `ORBITID_ENCRYPTION_KEY`.
3. **Export** from the old database:

   ```bash
   ORBITID_DATABASE_URL=postgres://orbitid@old.internal/orbitid \
   ORBITID_ENCRYPTION_KEY=… orbitid export --out /backup/orbitid-$(date +%F).jsonl
   ```

4. **Prepare the target.** Run `orbitid migrate` against the new, empty database, then stop:

   ```bash
   ORBITID_DATABASE_URL=postgres://orbitid@db.internal/orbitid \
   ORBITID_ENCRYPTION_KEY=… orbitid migrate
   ```

5. **Import** into the target with the *same* `ORBITID_ENCRYPTION_KEY`:

   ```bash
   ORBITID_DATABASE_URL=postgres://orbitid@db.internal/orbitid \
   ORBITID_ENCRYPTION_KEY=… orbitid import --in /backup/orbitid-$(date +%F).jsonl
   ```

6. **Switch** `ORBITID_DATABASE_URL` everywhere the server runs, start it, and verify: sign in with a known
   password (and a second factor if the account has one), load the dashboard, accept a pending organization
   invitation, send a webhook test event.
7. Keep the old database and the export until the new instance has run for a while.

## Restoring a backup

Start the new server once against an empty database (`orbitid migrate`), then `orbitid import --in <file>`
with the original encryption key. Uploaded images are part of the import because they live in Postgres.
Restart every replica after the import: the import bumps `instance.revision`, but a replica that had already
published a higher revision would ignore the imported settings until its 30 s refresh (or a restart).

Served images carry `Cache-Control: public, max-age=31536000, immutable`. File names are
random and never reused, so that is safe for a live image; a copy a browser or CDN has already
cached survives a delete, so purge the CDN cache when immediate removal is required.
