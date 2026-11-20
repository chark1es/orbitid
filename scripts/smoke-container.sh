#!/usr/bin/env bash
# Container smoke test: build the image and prove it runs a real instance.
#
#   bash scripts/smoke-container.sh                  # Postgres compose stack, then 2 replicas
#   SMOKE_KEEP=1 bash scripts/smoke-container.sh     # leave the resources behind for inspection
#
# What it checks, against the built image and not a source checkout:
#   image layout and non-root uid, health and readiness, the served dashboard, the operator-session
#   key exchange and its cookie, password sign-up (delivery-dependent factors disabled), password
#   sign-in, an uploaded avatar stored in Postgres, survival across a restart, three replicas
#   booting concurrently against an empty database without restarts, and a two-replica scale-out.
#   The scale-out proves Caddy distributes requests to more than one replica (from each replica's
#   request log, because the shipped proxy adds no upstream header), that a session created through
#   the load balancer is valid on every replica, and that ORBITID_TRUST_PROXY=1 reads (and Caddy
#   sanitises) the forwarded client address and scheme.
#
# Every container, volume, network, image and compose project is named for this run and removed at the end.
# The script never touches a Docker resource it did not create.
#
# On WSL with Docker Desktop's Windows CLI (WSL integration off), point DOCKER at the Windows binary
# and at the Docker Desktop named pipe:
#   DOCKER_HOST='npipe:////./pipe/docker_engine' \
#   DOCKER='/mnt/c/Program Files/Docker/Docker/resources/bin/docker.exe' bash scripts/smoke-container.sh
# Paths handed to the daemon are then converted with wslpath. The scale override uses Compose's
# `!reset` tag, which needs Compose 2.24 or newer.
set -euo pipefail

DOCKER="${DOCKER:-docker}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STAMP="$(date +%s)-$$"
SMOKE_KEEP="${SMOKE_KEEP:-0}"

# Detect the WSL interop client even when it is reached through the plain `docker` name.
# Docker Desktop with WSL integration disabled needs its Linux engine pipe explicitly and
# expects Windows paths; an explicit DOCKER/DOCKER_HOST still wins.
DOCKER_BIN="$(command -v "$DOCKER" 2>/dev/null || true)"
WSL_PATHS=0
case "$DOCKER" in
  *.exe|/mnt/*) WSL_PATHS=1 ;;
esac
if (( ! WSL_PATHS )) && [[ "$DOCKER_BIN" == /mnt/* ]]; then
  WSL_PATHS=1
  # Docker Desktop's `docker` wrapper drops DOCKER_HOST; use the real executable.
  if [[ "$DOCKER_BIN" != *.exe && -x "$DOCKER_BIN.exe" ]]; then
    DOCKER="$DOCKER_BIN.exe"
  fi
fi
if (( WSL_PATHS )) && [[ -z "${DOCKER_HOST:-}" ]]; then
  if DOCKER_HOST='npipe:////./pipe/docker_engine' "$DOCKER" version >/dev/null 2>&1; then
    DOCKER_HOST='npipe:////./pipe/docker_engine'
    export DOCKER_HOST
  fi
fi

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
IMAGE=""
PG_BASE=""
PG_PORT=""
# A password with / + = would have broken the old raw-interpolated database URL; the stack must still connect.
DB_PASSWORD="smoke/$STAMP+x="
SECRET="$(node -p 'require("node:crypto").randomBytes(32).toString("hex")')"

say()  { printf '\n== %s\n' "$*"; }
ok()   { CHECKS=$((CHECKS + 1)); printf '  ok   %s\n' "$*"; }
bad()  { CHECKS=$((CHECKS + 1)); FAILURES=$((FAILURES + 1)); printf '  FAIL %s\n' "$*" >&2; }
assert_eq() { if [[ "$1" == "$2" ]]; then ok "$3"; else bad "$3 (expected '$2', got '$1')"; fi; }

# Shell variables override --env-file in Compose. Pin every interpolated value for both startup and cleanup,
# including empty provider credentials, so an operator's exported configuration cannot affect this test.
# WSLENV forwards these assignments when DOCKER is the Windows executable.
compose_env() {
  local project="$1"
  shift
  env \
    WSLENV="${WSLENV:+$WSLENV:}DOCKER_HOST:ORBITID_IMAGE:ORBITID_ENCRYPTION_KEY:ORBITID_SECRET_KEY:ORBITID_BASE_URL:ORBITID_PORT:POSTGRES_PASSWORD:ORBITID_TRUST_PROXY:ORBITID_DB_MAX_CONNECTIONS:ORBITID_DB_ACQUIRE_TIMEOUT_MS:ORBITID_RESEND_API_KEY:ORBITID_SMTP_URL:ORBITID_EMAIL_FROM" \
    ORBITID_IMAGE="$IMAGE" \
    ORBITID_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef \
    ORBITID_SECRET_KEY="$SECRET" \
    ORBITID_BASE_URL="$PG_BASE" \
    ORBITID_PORT="$PG_PORT" \
    POSTGRES_PASSWORD="$DB_PASSWORD" \
    ORBITID_TRUST_PROXY=0 \
    ORBITID_DB_MAX_CONNECTIONS=20 \
    ORBITID_DB_ACQUIRE_TIMEOUT_MS=30000 \
    ORBITID_RESEND_API_KEY= \
    ORBITID_SMTP_URL= \
    ORBITID_EMAIL_FROM= \
    "$DOCKER" "$@"
}

compose_for_project() {
  local project="$1"
  shift
  compose_env "$project" compose -p "$project" -f "$(host_path "$ROOT/docker-compose.yml")" \
    --env-file "$(host_path "$WORKDIR/compose.env")" "$@"
}

# The documented scale-out: the base file plus the override for one project.
compose_scaled_for_project() {
  local project="$1"
  shift
  compose_env "$project" compose -p "$project" \
    -f "$(host_path "$ROOT/docker-compose.yml")" \
    -f "$(host_path "$ROOT/docker-compose.scale.yml")" \
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
    compose_scaled_for_project "$project" down -v --remove-orphans >/dev/null 2>&1 || true
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

wait_url() {
  local path="$1" seconds="${2:-90}" i
  for i in $(seq 1 "$seconds"); do
    if curl -fsS -m 2 "$PG_BASE$path" >/dev/null 2>&1; then return 0; fi
    sleep 1
  done
  return 1
}

wait_health() { wait_url /health "$@"; }
wait_ready()  { wait_url /ready "$@"; }

# No console/file mail transport exists, so the throwaway instance turns email verification off (an operator setting).

# The behaviour every instance must show.
#   $1 base URL   $2 a function that prints the instance's logs   $3 secret key   $4 label
smoke_instance() {
  local base="$1" logs_fn="$2" secret="$3" label="$4"
  local email="smoke-$label-$STAMP@example.test"
  local jar="$WORKDIR/$label.jar" operator_jar="$WORKDIR/$label.operator.jar" code body status signup_id session image_url

  say "$label: health and readiness"
  body="$(curl -fsS -m 5 "$base/health")"
  assert_eq "$(printf '%s' "$body" | json status)" "ok" "$label: /health reports ok"
  assert_eq "$(printf '%s' "$body" | json database)" "postgres" "$label: /health reports Postgres"
  assert_eq "$(printf '%s' "$body" | json database_driver)" "postgres" "$label: /health reports the Postgres driver"
  assert_eq "$(printf '%s' "$body" | json publishable_key | cut -c1-7)" "pk_live" "$label: /health has the publishable key"
  assert_eq "$(curl -sS -m 5 -o "$WORKDIR/$label.ready" -w '%{http_code}' "$base/ready")" "200" "$label: /ready reports the database ready"

  say "$label: dashboard"
  status="$(curl -sS -m 5 -o "$WORKDIR/$label.html" -w '%{http_code}' "$base/")"
  assert_eq "$status" "200" "$label: / serves the dashboard"
  if grep -q 'window.__ORBITID__' "$WORKDIR/$label.html"; then ok "$label: dashboard is bootstrapped with its own URL"; else bad "$label: dashboard bootstrap is missing"; fi
  if grep -q '<div id="root">' "$WORKDIR/$label.html"; then ok "$label: dashboard HTML is the built app"; else bad "$label: dashboard HTML is not the built app"; fi
  assert_eq "$(curl -sS -m 5 -o /dev/null -w '%{http_code}' "$base/v1/openapi.json")" "200" "$label: the OpenAPI document is served"
  assert_eq "$(curl -sS -m 5 -o "$WORKDIR/$label.docs.html" -w '%{http_code}' "$base/docs")" "200" "$label: the embedded docs viewer is served"

  say "$label: dashboard console (owner setup; the secret key does not open it)"
  status="$(curl -sS -m 5 -D "$WORKDIR/$label.keyexchange" -o /dev/null -w '%{http_code}' -X POST "$base/v1/operator_sessions" \
    -H 'content-type: application/json' -H "origin: $base" -d "{\"secret_key\":\"$secret\"}")"
  if [[ "$status" == 2* ]]; then bad "$label: the secret key opened a dashboard session (HTTP $status)"; else ok "$label: the secret key does not open the dashboard"; fi
  grep -qi 'set-cookie: *__orbit_operator=' "$WORKDIR/$label.keyexchange" && bad "$label: the secret key received a console cookie" || ok "$label: no console cookie for the secret key"
  local owner_password; owner_password="smoke-owner-$(node -e "process.stdout.write(require('crypto').randomBytes(8).toString('hex'))")"
  status="$(curl -sS -m 15 -D "$WORKDIR/$label.setup" -o "$WORKDIR/$label.setup.json" -c "$operator_jar" -w '%{http_code}' \
    -X POST "$base/v1/operator_sessions/setup" -H 'content-type: application/json' -H "origin: $base" \
    -d "{\"email_address\":\"owner@smoke.example\",\"password\":\"$owner_password\"}")"
  assert_eq "$status" "201" "$label: the first visitor creates the owner and opens the console"
  for attr in httponly samesite=strict path=/v1; do grep -qi "set-cookie: *__orbit_operator=.*$attr" "$WORKDIR/$label.setup" && ok "$label: console cookie has $attr" || bad "$label: console cookie lacks $attr"; done
  if grep -qF "$owner_password" "$WORKDIR/$label.setup.json"; then bad "$label: setup echoed the password"; else ok "$label: setup does not echo the password"; fi
  status="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -X POST "$base/v1/operator_sessions/setup" -H 'content-type: application/json' -H "origin: $base" -d '{"email_address":"second@smoke.example","password":"another-long-passphrase"}')"
  assert_eq "$status" "403" "$label: owner setup closes once an account exists"

  status="$(curl -sS -m 5 -o "$WORKDIR/$label.users" -w '%{http_code}' -b "$operator_jar" -H "origin: $base" "$base/v1/users?limit=1")"
  assert_eq "$status" "200" "$label: the cookie authenticates a Backend API call"
  status="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -b "$operator_jar" -H "origin: http://not-this-instance.example" "$base/v1/users?limit=1")"
  assert_eq "$status" "403" "$label: the cookie is refused from another origin"
  status="$(curl -sS -m 5 -o /dev/null -w '%{http_code}' -X DELETE -b "$operator_jar" -c "$operator_jar" -H "origin: $base" "$base/v1/operator_sessions/current")"
  assert_eq "$status" "204" "$label: the console session can be revoked"
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

  # Uploaded avatars live in the `uploads` table now, so this must work on a read-only root filesystem
  # with no writable application volume.
  say "$label: profile image upload"
  status="$(curl -sS -m 10 -o "$WORKDIR/$label.upload.json" -w '%{http_code}' -b "$WORKDIR/$label.signin.jar" \
    -X POST "$base/v1/client/me/profile_image" -H 'content-type: application/json' \
    -d '{"file":"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC"}')"
  assert_eq "$status" "200" "$label: a profile image is stored in Postgres"
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
assert_eq "$("$DOCKER" run --rm --entrypoint id "$IMAGE" -u)" "10001" "the runtime image runs as the unprivileged orbitid user"
"$DOCKER" run --rm --entrypoint orbitid "$IMAGE" help >/dev/null \
  && ok "the binary starts without a database for 'orbitid help'" || bad "the binary does not run"
if "$DOCKER" run --rm --entrypoint sh "$IMAGE" -c 'test -f /app/dashboard/index.html && test ! -e /src/docs/openapi.json && test -x /usr/local/bin/orbitid'; then
  ok "the image holds the dashboard and the binary, with the OpenAPI document embedded"
else
  bad "the image layout is wrong (dashboard, binary or a stray OpenAPI file)"
fi
if "$DOCKER" run --rm --entrypoint sh "$IMAGE" -c '! command -v node >/dev/null 2>&1 && ! command -v bun >/dev/null 2>&1'; then
  ok "the runtime image carries no Node or Bun runtime"
else
  bad "the runtime image still carries a JavaScript runtime"
fi
if "$DOCKER" run --rm --entrypoint sh "$IMAGE" -c 'ldd /usr/local/bin/orbitid | grep -q "not found" && exit 1; exit 0'; then
  ok "every shared library the binary links is present"
else
  bad "the binary links a missing shared library"
fi
if "$DOCKER" run --rm --entrypoint sh "$IMAGE" -c 'test ! -w /app'; then
  ok "/app is not writable by the server"
else
  bad "/app is writable by the server"
fi

# ── one port and one environment file for every compose project in this run ─

PG_PORT="$(pick_port)"
PG_BASE="http://localhost:$PG_PORT"
cat > "$WORKDIR/compose.env" <<EOF
ORBITID_IMAGE=$IMAGE
ORBITID_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef
ORBITID_SECRET_KEY=$SECRET
ORBITID_BASE_URL=$PG_BASE
ORBITID_PORT=$PG_PORT
POSTGRES_PASSWORD=$DB_PASSWORD
ORBITID_DB_MAX_CONNECTIONS=20
ORBITID_DB_ACQUIRE_TIMEOUT_MS=30000
EOF

# ── concurrent first boot ───────────────────────────────────────────────────
# Reviewed risk: every replica boots against the same empty database at once.

say "concurrent first boot (3 replicas on an empty database)"
BOOT_PROJECT="orbitid-smoke-boot-$STAMP"
COMPOSE_PROJECTS+=("$BOOT_PROJECT")
if ! compose_scaled_for_project "$BOOT_PROJECT" up -d --scale orbitid=3 >/dev/null; then
  bad "three replicas could not start together on an empty database"
  compose_scaled_for_project "$BOOT_PROJECT" logs --no-color >&2 || true
fi
if wait_health 240 && wait_ready 90; then
  ok "three replicas became healthy on an empty database"
  case "$DB_PASSWORD" in */*+*=*) ok "the stack connected with a Postgres password containing /, + and =" ;; *) bad "the smoke password lost its / + = characters" ;; esac
else
  bad "three replicas did not become healthy on an empty database"
  compose_scaled_for_project "$BOOT_PROJECT" logs --no-color >&2 || true
fi
boot_ids="$(compose_scaled_for_project "$BOOT_PROJECT" ps -q orbitid)"
assert_eq "$(printf '%s\n' "$boot_ids" | sed '/^$/d' | wc -l | xargs)" "3" "three replicas are running after the concurrent boot"
for id in $boot_ids; do
  assert_eq "$("$DOCKER" inspect --format '{{.State.Health.Status}}' "$id")" "healthy" "replica ${id:0:12} is healthy after the concurrent boot"
  assert_eq "$("$DOCKER" inspect --format '{{.RestartCount}}' "$id")" "0" "replica ${id:0:12} did not restart"
done
compose_scaled_for_project "$BOOT_PROJECT" down -v --remove-orphans >/dev/null

# ── Postgres compose ────────────────────────────────────────────────────────

say "Postgres compose"
PROJECT="orbitid-smoke-pg-$STAMP"
COMPOSE_PROJECTS+=("$PROJECT")

compose() { compose_for_project "$PROJECT" "$@"; }
scaled()  { compose_scaled_for_project "$PROJECT" "$@"; }
compose_logs() { compose logs --no-color orbitid 2>&1; }

compose config >/dev/null && ok "docker-compose.yml resolves" || bad "docker-compose.yml does not resolve"
scaled config >/dev/null && ok "docker-compose.scale.yml resolves" || bad "docker-compose.scale.yml does not resolve"
# The image was built above; compose only has to start it.
compose up -d >/dev/null
if wait_health 180; then ok "compose stack is healthy"; else bad "compose stack never became healthy"; compose logs >&2; exit 1; fi
if wait_ready 90; then ok "compose stack is ready (database reached)"; else bad "compose /ready never answered"; compose logs >&2; fi
assert_eq "$(compose ps --status running --format json 2>/dev/null | grep -c '"Service"')" "2" "compose runs both services"
assert_eq "$(compose exec -T orbitid id -u)" "10001" "the compose server runs unprivileged"
assert_eq "$(compose exec -T orbitid orbitid keys | awk -F': ' '/Secret key/ {print $2}' | xargs)" "$SECRET" "the CLI reports the configured secret key (documented docker exec command)"

smoke_instance "$PG_BASE" compose_logs "$SECRET" "postgres"

say "Postgres compose: restart"
compose restart orbitid >/dev/null
if wait_health 120; then ok "compose is healthy after a restart"; else bad "compose did not come back"; compose logs >&2; fi
smoke_persistence "$PG_BASE" "postgres"

# ── scaled replicas behind Caddy ────────────────────────────────────────────

say "scaled replicas (2 behind Caddy)"
scaled up -d --scale orbitid=2 >/dev/null
if wait_health 180 && wait_ready 90; then ok "the load balancer reaches a ready replica"; else bad "the scaled stack never became ready"; scaled logs --no-color >&2; fi
replica_ids="$(scaled ps -q orbitid)"
assert_eq "$(printf '%s\n' "$replica_ids" | sed '/^$/d' | wc -l | xargs)" "2" "two orbitid replicas are running"

# The shipped Caddy configuration adds no upstream header: responses must not disclose internal
# addresses. Distribution is proven from each replica's request log instead (one line per request,
# with its path); a unique path keeps these probes apart from the readiness checks above.
say "scaled replicas: distribution"
probe="/smoke-distribution-$STAMP"
for _ in $(seq 1 15); do
  for _ in $(seq 1 8); do curl -sS -m 5 -o /dev/null "$PG_BASE$probe" 2>/dev/null || true; done
  observed=""
  for id in $replica_ids; do
    "$DOCKER" logs "$id" 2>&1 | grep -qF "$probe" && observed+="$id"$'\n'
  done
  if (( $(printf '%s' "$observed" | sed '/^$/d' | wc -l) >= 2 )); then break; fi
  sleep 1
done
served="$(printf '%s' "$observed" | sed '/^$/d' | wc -l | xargs)"
if (( served >= 2 )); then ok "requests were distributed across $served replicas (from their request logs)"
else
  bad "requests reached only $served replica(s) (see the replica request logs)"
  scaled logs --no-color --tail 40 >&2 || true
fi
if curl -sS -m 5 -D "$WORKDIR/distribution.headers" -o /dev/null "$PG_BASE/health" 2>/dev/null \
  && ! grep -qi '^x-orbitid-upstream:' "$WORKDIR/distribution.headers"; then
  ok "responses do not disclose the handling replica or its internal address"
else
  bad "a response leaked an upstream replica header"
fi

# Sign in through the load balancer. The spoofed forwarding headers must be replaced by Caddy:
# a forged X-Forwarded-For must not become the session IP, and a plain-http request must not
# get a Secure cookie even when the client claims X-Forwarded-Proto: https.
: > "$WORKDIR/scaled.jar"
status="$(curl -sS -m 10 -D "$WORKDIR/scaled.signin.headers" -o "$WORKDIR/scaled.signin.json" \
  -w '%{http_code}' -c "$WORKDIR/scaled.jar" \
  -X POST "$PG_BASE/v1/client/sign_ins" -H 'content-type: application/json' \
  -H 'x-forwarded-for: 203.0.113.77' -H 'x-forwarded-proto: https' \
  -d "{\"identifier\":\"$SMOKE_EMAIL\",\"password\":\"Sup3rSecret!\"}")"
assert_eq "$status" "200" "sign-in through the load balancer is accepted"
if grep -qi 'set-cookie:.*secure' "$WORKDIR/scaled.signin.headers"; then
  bad "a plain-http request behind Caddy received a Secure cookie"
else
  ok "Caddy's http scheme produces no Secure cookie"
fi
session="$(json response.created_session_id < "$WORKDIR/scaled.signin.json")"
if [[ "$session" == sess_* ]]; then
  db_ip="$(scaled exec -T postgres psql -U orbitid -d orbitid -tAc \
    "SELECT ip FROM sessions WHERE id = '$session'" 2>/dev/null | tr -d '[:space:]')"
  if [[ -n "$db_ip" && "$db_ip" != "203.0.113.77" ]]; then
    ok "Caddy replaced the spoofed X-Forwarded-For (session IP $db_ip)"
  else
    bad "the session kept the spoofed client address '$db_ip'"
  fi
else
  bad "sign-in through the load balancer returned no session id"
fi

# Trusted-proxy behaviour the other way round: a direct request to one replica (the runtime image
# has no curl) with explicit forwarded headers must use that client IP and scheme because
# ORBITID_TRUST_PROXY=1 is set by the scale file.
say "scaled replicas: trusted proxy headers"
direct_id="$(printf '%s\n' "$replica_ids" | head -1)"
if "$DOCKER" run --rm --network "container:$direct_id" --entrypoint wget postgres:17-alpine \
  -S -O /dev/null \
  --header='content-type: application/json' \
  --header='x-forwarded-for: 198.51.100.7' \
  --header='x-forwarded-proto: https' \
  --post-data="{\"identifier\":\"$SMOKE_EMAIL\",\"password\":\"Sup3rSecret!\"}" \
  "http://127.0.0.1:4000/v1/client/sign_ins" 2> "$WORKDIR/direct.headers"; then
  ok "a replica accepts a request with trusted proxy headers"
else
  bad "a replica refused a request with trusted proxy headers"
fi
if grep -qi 'set-cookie:.*secure' "$WORKDIR/direct.headers"; then
  ok "X-Forwarded-Proto: https produces a Secure cookie when the proxy is trusted"
else
  bad "X-Forwarded-Proto: https did not produce a Secure cookie"
fi
direct_ip_count="$(scaled exec -T postgres psql -U orbitid -d orbitid -tAc \
  "SELECT COUNT(*) FROM sessions WHERE ip = '198.51.100.7'" 2>/dev/null | tr -d '[:space:]')"
if [[ "$direct_ip_count" =~ ^[0-9]+$ ]] && (( direct_ip_count >= 1 )); then
  ok "the trusted proxy header supplies the session client IP"
else
  bad "the trusted proxy header did not supply the session client IP"
fi

# Call the Frontend API on each replica directly with the cookie created through the load
# balancer. Round-robin means the login and the session read land on different containers.
cookie="$(awk '
  /^#HttpOnly_/ { sub(/^#HttpOnly_/, "") }
  $1 !~ /^#/ && NF >= 7 { printf "%s%s=%s", sep, $6, $7; sep = "; " }
' "$WORKDIR/scaled.jar")"
if [[ -n "$cookie" ]]; then
  for id in $replica_ids; do
    if "$DOCKER" run --rm --network "container:$id" --entrypoint wget postgres:17-alpine \
      -q -O /dev/null --header="cookie: $cookie" http://127.0.0.1:4000/v1/client/me; then
      ok "the session created through the load balancer is valid on replica ${id:0:12}"
    else
      bad "the session created through the load balancer is invalid on replica ${id:0:12}"
    fi
    "$DOCKER" exec "$id" /usr/local/bin/orbitid healthcheck \
      && ok "replica ${id:0:12} answers its own readiness probe" \
      || bad "replica ${id:0:12} fails its readiness probe"
  done
else
  bad "sign-in through the load balancer returned no client cookie"
fi

# ── result ──────────────────────────────────────────────────────────────────

say "result"
printf '  %s checks, %s failures\n' "$CHECKS" "$FAILURES"
if (( FAILURES > 0 )); then
  exit 1
fi
printf '  container smoke test passed\n'
