#!/usr/bin/env bash
# Container smoke test: build the image and prove it runs a real instance.
#
#   bash scripts/smoke-container.sh                  # SQLite image, then Postgres compose
#   SMOKE_KEEP=1 bash scripts/smoke-container.sh     # leave the resources behind for inspection
#
# What it checks, against the built image and not a source checkout:
#   health, the served dashboard, non-root uid, the operator-session key exchange and its cookie,
#   password sign-up (delivery-dependent factors disabled), password sign-in, and that both survive a restart.
#
# Every container, volume, network, image and compose project is named for this run and removed at the end.
# The script never touches a Docker resource it did not create.
#
# On WSL with Docker Desktop's Windows CLI (WSL integration off), point DOCKER at the Windows binary:
#   DOCKER='/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe' bash scripts/smoke-container.sh
# Paths handed to the daemon are then converted with wslpath.
set -euo pipefail

DOCKER="${DOCKER:-docker}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%s)-$$"
SMOKE_KEEP="${SMOKE_KEEP:-0}"

WSL_PATHS=0
case "$DOCKER" in
  *.exe|/mnt/*) WSL_PATHS=1 ;;
esac

host_path() {
  if (( WSL_PATHS )); then wslpath -w "$1"; else printf '%s\n' "$1"; fi
}

CHECKS=0
FAILURES=0
CONTAINERS=()
VOLUMES=()
COMPOSE_PROJECTS=()
IMAGES=()
WORKDIR="$(mktemp -d)"

say()  { printf '\n== %s\n' "$*"; }
ok()   { CHECKS=$((CHECKS + 1)); printf '  ok   %s\n' "$*"; }
bad()  { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); printf '  FAIL %s\n' "$*" >&2; }
assert_eq() { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }

# Shell variables override --env-file in Compose. Pin every interpolated value for both startup and cleanup,
# including empty provider credentials, so an operator's exported configuration cannot affect this test.
# WSLENV forwards these assignments when DOCKER is the Windows executable.
compose_for_project() {
  local project="$1"
  shift
  env \
    WSLENV="${WSLENV:+$WSLENV:}ORBITID_IMAGE:ORBITID_ENCRYPTION_KEY:ORBITID_SECRET_KEY:ORBITID_BASE_URL:ORBITID_PORT:POSTGRES_PASSWORD:ORBITID_TRUST_PROXY:ORBITID_RESEND_API_KEY:ORBITID_SMTP_URL:ORBITID_EMAIL_FROM" \
    ORBITID_IMAGE="$PG_IMAGE" \
    ORBITID_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef \
    ORBITID_SECRET_KEY="$SECRET" \
    ORBITID_BASE_URL="$PG_BASE" \
    ORBITID_PORT="$PG_PORT" \
    POSTGRES_PASSWORD="smoke-$STAMP" \
    ORBITID_TRUST_PROXY=0 \
    ORBITID_RESEND_API_KEY= \
    ORBITID_SMTP_URL= \
    ORBITID_EMAIL_FROM= \
    "$DOCKER" compose -p "$project" -f "$(host_path "$ROOT/docker-compose.yml")" \
      --env-file "$(host_path "$WORKDIR/compose.env")" "$@"
}

cleanup() {
  if [[ "$SMOKE_KEEP" == "1" ]]; then
    printf '\nSMOKE_KEEP=1: leaving %s, volumes %s, projects %s\n' "${CONTAINERS[*]:-none}" "${VOLUMES[*]:-none}" "${COMPOSE_PROJECTS[*]:-none}"
    rm -rf "$WORKDIR"
    return
  fi
  for name in "${CONTAINERS[@]:-}"; do [[ -n "$name" ]] && "$DOCKER" rm -f "$name" >/dev/null 2>&1 || true; done
  for vol in "${VOLUMES[@]:-}"; do [[ -n "$vol" ]] && "$DOCKER" volume rm "$vol" >/dev/null 2>&1 || true; done
  for project in "${COMPOSE_PROJECTS[@]:-}"; do
    [[ -z "$project" ]] && continue
    compose_for_project "$project" down -v --remove-orphans >/dev/null 2>&1 || true
  done
  for image in "${IMAGES[@]:-}"; do [[ -n "$image" ]] && "$DOCKER" rmi -f "$image" >/dev/null 2>&1 || true; done
  rm -rf "$WORKDIR"
}
trap cleanup EXIT INT TERM

need() { command -v "$1" >/dev/null 2>&1 || { echo "missing required command: $1" >&2; exit 1; }; }
need curl
need node
"$DOCKER" version >/dev/null 2>&1 || { echo "cannot reach Docker with: $DOCKER" >&2; exit 1; }

# ── helpers ─────────────────────────────────────────────────────────────────

json() {
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let o;try{o=JSON.parse(s)}catch{process.stdout.write("");return}for(const k of process.argv[1].split("."))o=o?.[k];process.stdout.write(o===undefined?"":String(o))})' "$1"
}

# A free TCP port, so a run never collides with an instance already listening.
pick_port() {
  local attempt port
  for attempt in $(seq 1 40); do
    port=$(( (RANDOM % 20000) + 30000 ))
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$port") 2>/dev/null; then printf '%s\n' "$port"; return 0; fi
  done
  echo "could not find a free TCP port" >&2
  exit 1
}

wait_health() {
  local base="$1" seconds="${2:-90}" i
  for i in $(seq 1 "$seconds"); do
    if curl -fsS -m 2 "$base/health" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

# There is no console or file mail transport: the server never prints a code and never writes one to disk. The
# smoke test therefore turns email verification off for its throwaway instance (an ordinary operator setting) and
# never needs to read a secret out of a log.

# The behaviour every instance must show, whatever the database behind it.
#   $1 base URL   $2 a function that prints the instance's logs   $3 secret key   $4 label
smoke_instance() {
  local base="$1" logs_fn="$2" secret="$3" label="$4"
  local email="smoke-$label-$STAMP@example.test"
  local jar="$WORKDIR/$label.jar" operator_jar="$WORKDIR/$label.operator.jar" code body status signup_id session image_url

  say "$label: health"
  body="$(curl -fsS -m 5 "$base/health")"
  assert_eq "$(printf '%s' "$body" | json status)" "ok" "$label: /health reports ok"
  assert_eq "$(printf '%s' "$body" | json publishable_key | cut -c1-7)" "pk_live" "$label: /health has the publishable key"

  say "$label: dashboard"
  status="$(curl -sS -m 5 -o "$WORKDIR/$label.html" -w '%{http_code}' "$base/")"
  assert_eq "$status" "200" "$label: / serves the dashboard"
  if grep -q 'window.__ORBITID__' "$WORKDIR/$label.html"; then ok "$label: dashboard is bootstrapped with its own URL"; else bad "$label: dashboard bootstrap is missing"; fi
  if grep -q '<div id="root">' "$WORKDIR/$label.html"; then ok "$label: dashboard HTML is the built app"; else bad "$label: dashboard HTML is not the built app"; fi

  say "$label: operator session (secret key exchange)"
  status="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST "$base/v1/operator_sessions" \
    -H 'content-type: application/json' -H "origin: $base" -d '{"secret_key":"sk_live_wrong_key_000000000000000000000"}')"
  assert_eq "$status" "401" "$label: a wrong secret key is refused"

  status="$(curl -sS -m 5 -D "$WORKDIR/$label.exchange" -o "$WORKDIR/$label.exchange.json" -c "$operator_jar" -w '%{http_code}' \
    -X POST "$base/v1/operator_sessions" -H 'content-type: application/json' -H "origin: $base" \
    -d "{\"secret_key\":\"$secret\"}")"
  assert_eq "$status" "201" "$label: the secret key is exchanged for a session"
  grep -qi 'set-cookie:.*httponly' "$WORKDIR/$label.exchange" && ok "$label: cookie is HttpOnly" || bad "$label: cookie is not HttpOnly"
  grep -qi 'set-cookie:.*samesite=strict' "$WORKDIR/$label.exchange" && ok "$label: cookie is SameSite=Strict" || bad "$label: cookie is not SameSite=Strict"
  grep -qi 'set-cookie:.*path=/v1' "$WORKDIR/$label.exchange" && ok "$label: cookie is scoped to /v1" || bad "$label: cookie path is not /v1"
  if grep -qF "$secret" "$WORKDIR/$label.exchange.json"; then bad "$label: exchange echoed the secret key"; else ok "$label: exchange does not echo the secret key"; fi

  status="$(curl -sS -m 5 -o "$WORKDIR/$label.users" -w '%{http_code}' -b "$operator_jar" -H "origin: $base" "$base/v1/users?limit=1")"
  assert_eq "$status" "200" "$label: the cookie authenticates a Backend API call"
  status="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -b "$operator_jar" -H "origin: http://not-this-instance.example" "$base/v1/users?limit=1")"
  assert_eq "$status" "403" "$label: the cookie is refused from another origin"
  status="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -X DELETE -b "$operator_jar" -c "$operator_jar" -H "origin: $base" "$base/v1/operator_sessions/current")"
  assert_eq "$status" "204" "$label: the operator session can be revoked"
  status="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -b "$operator_jar" -H "origin: $base" "$base/v1/operator_sessions/current")"
  assert_eq "$status" "401" "$label: a revoked cookie no longer authenticates"

  say "$label: sign-up"
  : > "$jar"
  # A production instance refuses an email flow with no provider, so the smoke instance verifies no email: the
  # code never has to leave the server (and the server never prints it). Everything else is the ordinary path.
  status="$(curl -sS -m 10 -o "$WORKDIR/$label.instance.json" -w '%{http_code}' -b "$jar" -H "origin: $base" \
    -X PATCH "$base/v1/instance" -H "authorization: Bearer $secret" -H 'content-type: application/json' \
    -d '{"attributes":{"emailAddress":{"verifyAtSignUp":false,"usedForFirstFactor":false,"usedForSecondFactor":false}}}')"
  assert_eq "$status" "200" "$label: email verification can be turned off by the operator"
  status="$(curl -sS -m 10 -o "$WORKDIR/$label.signup.json" -w '%{http_code}' -c "$jar" -b "$jar" \
    -X POST "$base/v1/client/sign_ups" -H 'content-type: application/json' \
    -d "{\"email_address\":\"$email\",\"password\":\"Sup3rSecret!\"}")"
  assert_eq "$status" "200" "$label: sign-up starts"
  signup_id="$(json response.id < "$WORKDIR/$label.signup.json")"
  [[ "$signup_id" == sua_* ]] || { bad "$label: sign-up returned no id"; SMOKE_EMAIL="$email"; SMOKE_SESSION=""; return; }
  session="$(json response.created_session_id < "$WORKDIR/$label.signup.json")"
  [[ "$session" == sess_* ]] && ok "$label: sign-up completes with a session" || bad "$label: sign-up did not complete"
  status="$(curl -sS -m 5 -o "$WORKDIR/$label.me" -w '%{http_code}' -b "$jar" "$base/v1/client/me")"
  assert_eq "$status" "200" "$label: the new session reads its own user"

  say "$label: sign-in"
  : > "$WORKDIR/$label.signin.jar"
  status="$(curl -sS -m 10 -o "$WORKDIR/$label.signin.json" -w '%{http_code}' -c "$WORKDIR/$label.signin.jar" \
    -X POST "$base/v1/client/sign_ins" -H 'content-type: application/json' \
    -d "{\"identifier\":\"$email\",\"password\":\"Sup3rSecret!\"}")"
  assert_eq "$status" "200" "$label: password sign-in is accepted"
  session="$(json response.created_session_id < "$WORKDIR/$label.signin.json")"
  [[ "$session" == sess_* ]] && ok "$label: password sign-in returns a session" || bad "$label: password sign-in failed"

  # The only writes outside the database go to ORBITID_DATA_DIR/uploads, so a hardened container must allow them.
  say "$label: profile image upload"
  status="$(curl -sS -m 10 -o "$WORKDIR/$label.upload.json" -w '%{http_code}' -b "$WORKDIR/$label.signin.jar" \
    -X POST "$base/v1/client/me/profile_image" -H 'content-type: application/json' \
    -d '{"file":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}')"
  assert_eq "$status" "200" "$label: a profile image is stored in the data directory"
  image_url="$(json response.image_url < "$WORKDIR/$label.upload.json")"
  if [[ "$image_url" == http* ]]; then
    assert_eq "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$image_url")" "200" "$label: the stored image is served back"
  else
    bad "$label: the upload did not return an image URL"
  fi

  SMOKE_EMAIL="$email"
  SMOKE_SESSION="$session"
}

# After a restart the account and its password must still be there.
smoke_persistence() {
  local base="$1" label="$2"
  local jar="$WORKDIR/$label.after.jar" status session
  assert_eq "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$base/health")" "200" "$label: /health after restart"
  status="$(curl -sS -m 10 -o "$WORKDIR/$label.after.json" -w '%{http_code}' -c "$jar" \
    -X POST "$base/v1/client/sign_ins" -H 'content-type: application/json' \
    -d "{\"identifier\":\"$SMOKE_EMAIL\",\"password\":\"Sup3rSecret!\"}")"
  assert_eq "$status" "200" "$label: sign-in after restart is accepted"
  session="$(json response.created_session_id < "$WORKDIR/$label.after.json")"
  [[ "$session" == sess_* ]] && ok "$label: the account survives the restart" || bad "$label: the account did not survive the restart"
}

# ── build ───────────────────────────────────────────────────────────────────

IMAGE="orbitid-smoke:$STAMP"
IMAGES+=("$IMAGE")

say "build $IMAGE"
"$DOCKER" build -t "$IMAGE" "$(host_path "$ROOT")"
ok "image builds"

say "image contents"
"$DOCKER" run --rm --entrypoint node "$IMAGE" -e "require('better-sqlite3');require('@node-rs/argon2');console.log(process.versions.modules)" > "$WORKDIR/abi" \
  && ok "native modules load on Node $(cat "$WORKDIR/abi")" || bad "native modules do not load"
"$DOCKER" run --rm --entrypoint node "$IMAGE" -e "require.resolve('@orbitid/shared')" >/dev/null \
  && ok "the @orbitid/shared workspace link resolves" || bad "the @orbitid/shared workspace link is dangling"
if "$DOCKER" run --rm --entrypoint sh "$IMAGE" -c 'for m in vitest typescript drizzle-kit jsdom; do test -e "node_modules/$m" && exit 1; done; exit 0'; then
  ok "the runtime image carries no test or build tooling"
else
  bad "the runtime image still carries development dependencies"
fi
if "$DOCKER" run --rm --entrypoint sh "$IMAGE" -c 'test -f dashboard/index.html && test -f packages/server/src/cli.ts'; then
  ok "the image holds the dashboard build and the server"
else
  bad "the image is missing the dashboard build or the server"
fi

# ── SQLite image ────────────────────────────────────────────────────────────

say "SQLite container"
SQLITE_NAME="orbitid-smoke-sqlite-$STAMP"
SQLITE_VOL="orbitid-smoke-sqlite-data-$STAMP"
SQLITE_PORT="$(pick_port)"
SQLITE_BASE="http://localhost:$SQLITE_PORT"
SECRET="$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')"
CONTAINERS+=("$SQLITE_NAME")
VOLUMES+=("$SQLITE_VOL")

sqlite_logs() { "$DOCKER" logs "$SQLITE_NAME" 2>&1; }
sqlite_env=(-e "ORBITID_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef"
            -e "ORBITID_SECRET_KEY=$SECRET"
            -e "ORBITID_BASE_URL=$SQLITE_BASE")

"$DOCKER" run -d --name "$SQLITE_NAME" "${sqlite_env[@]}" -p "$SQLITE_PORT:4000" -v "$SQLITE_VOL:/data" "$IMAGE" >/dev/null
if wait_health "$SQLITE_BASE" 120; then ok "SQLite container is healthy"; else bad "SQLite container never became healthy"; sqlite_logs | tail -30 >&2; exit 1; fi
assert_eq "$(curl -fsS "$SQLITE_BASE/health" | json database)" "sqlite" "SQLite container reports its database"

uid="$("$DOCKER" exec "$SQLITE_NAME" id -u)"
assert_eq "$uid" "1000" "the server runs as the unprivileged node user"
"$DOCKER" exec "$SQLITE_NAME" sh -c 'test ! -w /app' && ok "/app is not writable by the server" || bad "/app is writable by the server"
"$DOCKER" exec "$SQLITE_NAME" sh -c 'test -w /data' && ok "/data is writable by the server" || bad "/data is not writable by the server"
assert_eq "$("$DOCKER" exec "$SQLITE_NAME" node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts keys | awk -F': ' '/Secret key/ {print $2}' | xargs)" "$SECRET" "the CLI reports the configured secret key (documented docker exec command)"

smoke_instance "$SQLITE_BASE" sqlite_logs "$SECRET" "sqlite"

say "SQLite container: restart"
"$DOCKER" restart "$SQLITE_NAME" >/dev/null
if wait_health "$SQLITE_BASE" 90; then ok "SQLite container is healthy after a restart"; else bad "SQLite container did not come back"; sqlite_logs | tail -30 >&2; fi
assert_eq "$("$DOCKER" exec "$SQLITE_NAME" id -u)" "1000" "the restarted server is still unprivileged"
smoke_persistence "$SQLITE_BASE" "sqlite"

say "SQLite container: hardened (read-only root, all capabilities dropped)"
RO_NAME="orbitid-smoke-ro-$STAMP"
RO_VOL="orbitid-smoke-ro-data-$STAMP"
RO_PORT="$(pick_port)"
RO_BASE="http://localhost:$RO_PORT"
CONTAINERS+=("$RO_NAME")
VOLUMES+=("$RO_VOL")
"$DOCKER" run -d --name "$RO_NAME" --read-only --cap-drop ALL --security-opt no-new-privileges:true \
  -e "ORBITID_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef" \
  -e "ORBITID_SECRET_KEY=$SECRET" -e "ORBITID_BASE_URL=$RO_BASE" \
  -p "$RO_PORT:4000" -v "$RO_VOL:/data" "$IMAGE" >/dev/null
if wait_health "$RO_BASE" 120; then ok "a read-only container with no writable /tmp starts"; else bad "the read-only container never became healthy"; "$DOCKER" logs "$RO_NAME" 2>&1 | tail -20 >&2; fi
assert_eq "$("$DOCKER" exec "$RO_NAME" id -u)" "1000" "the read-only container runs unprivileged"
assert_eq "$(curl -fsS "$RO_BASE/health" | json database)" "sqlite" "the read-only container serves the API"
assert_eq "$("$DOCKER" exec "$RO_NAME" node node_modules/tsx/dist/cli.mjs packages/server/src/cli.ts keys | awk -F': ' '/Secret key/ {print $2}' | xargs)" "$SECRET" "the CLI works in the read-only container"

say "SQLite container: replacement with the same volume"
"$DOCKER" rm -f "$SQLITE_NAME" >/dev/null
SQLITE_NAME="$SQLITE_NAME-2"
CONTAINERS+=("$SQLITE_NAME")
"$DOCKER" run -d --name "$SQLITE_NAME" "${sqlite_env[@]}" -p "$SQLITE_PORT:4000" -v "$SQLITE_VOL:/data" "$IMAGE" >/dev/null
if wait_health "$SQLITE_BASE" 120; then ok "a new container on the same volume is healthy"; else bad "the replacement container never became healthy"; sqlite_logs | tail -30 >&2; fi
smoke_persistence "$SQLITE_BASE" "sqlite-volume"

# ── Postgres compose ────────────────────────────────────────────────────────

say "Postgres compose"
PROJECT="orbitid-smoke-pg-$STAMP"
PG_PORT="$(pick_port)"
PG_BASE="http://localhost:$PG_PORT"
PG_IMAGE="orbitid-smoke-pg:$STAMP"
COMPOSE_PROJECTS+=("$PROJECT")
IMAGES+=("$PG_IMAGE")
cat > "$WORKDIR/compose.env" <<EOF
ORBITID_IMAGE=$PG_IMAGE
ORBITID_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef
ORBITID_SECRET_KEY=$SECRET
ORBITID_BASE_URL=$PG_BASE
ORBITID_PORT=$PG_PORT
POSTGRES_PASSWORD=smoke-$STAMP
EOF

compose() {
  compose_for_project "$PROJECT" "$@"
}
compose_logs() { compose logs --no-color orbitid 2>&1; }

compose config >/dev/null && ok "docker-compose.yml resolves" || bad "docker-compose.yml does not resolve"
compose build orbitid >/dev/null
compose up -d >/dev/null
if wait_health "$PG_BASE" 180; then ok "compose stack is healthy"; else bad "compose stack never became healthy"; compose logs >&2; exit 1; fi
assert_eq "$(curl -fsS "$PG_BASE/health" | json database)" "postgres" "compose runs on Postgres"
assert_eq "$(compose ps --status running --format json 2>/dev/null | grep -c '"Service"')" "2" "compose runs both services"
assert_eq "$(compose exec -T orbitid id -u)" "1000" "the compose server runs unprivileged"

smoke_instance "$PG_BASE" compose_logs "$SECRET" "postgres"

say "Postgres compose: restart"
compose restart orbitid >/dev/null
if wait_health "$PG_BASE" 120; then ok "compose is healthy after a restart"; else bad "compose did not come back"; compose logs >&2; fi
smoke_persistence "$PG_BASE" "postgres"

# ── result ──────────────────────────────────────────────────────────────────

say "result"
printf '  %s checks, %s failures\n' "$CHECKS" "$FAILURES"
if (( FAILURES > 0 )); then
  exit 1
fi
printf '  container smoke test passed\n'
