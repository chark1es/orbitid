# syntax=docker/dockerfile:1
#
# One image, three stages:
#   dashboard – builds the React dashboard with Bun.
#   server    – builds the Rust binary (`orbitid`) from the Cargo workspace.
#   runtime   – minimal Debian bookworm-slim with the binary, the dashboard and the
#               shared libraries SAML needs. No Node, no compiler and no curl.
#
# The server is Postgres-only. There is no database inside the image and no data
# volume: settings, signing keys and uploaded avatars/logos all live in Postgres.

FROM node:20-bookworm-slim AS dashboard
RUN npm install -g bun@1.4.4
WORKDIR /app
# Manifests first: the dependency layer is reused until a package.json or the lockfile changes.
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json packages/backend/
COPY packages/js/package.json packages/js/
COPY packages/nextjs/package.json packages/nextjs/
COPY packages/node/package.json packages/node/
COPY packages/react/package.json packages/react/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY apps/dashboard/package.json apps/dashboard/
RUN bun install --frozen-lockfile
COPY packages/shared packages/shared
COPY packages/ui packages/ui
# The SDK packages the dashboard's account sign-in renders (consumed from source).
COPY packages/js packages/js
COPY packages/react packages/react
COPY apps/dashboard apps/dashboard
COPY tsconfig.base.json ./
RUN bun run --filter @orbitid/dashboard build

FROM rust:1-slim-bookworm AS server
# SAML verification links libxmlsec, which links OpenSSL and libxml2. Build-only headers:
# the runtime image installs the matching shared libraries.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      clang \
      pkg-config \
      libxml2-dev \
      libxmlsec1-dev \
      libssl-dev \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /src

# Manifests first, then a dummy build of the workspace. Cargo compiles every dependency
# once; the real source copy below only recompiles the OrbitID crates.
COPY Cargo.toml Cargo.lock ./
COPY crates/orbitid-core/Cargo.toml crates/orbitid-core/
COPY crates/orbitid-platform/Cargo.toml crates/orbitid-platform/
COPY crates/orbitid-credentials/Cargo.toml crates/orbitid-credentials/
COPY crates/orbitid-federation/Cargo.toml crates/orbitid-federation/
COPY crates/orbitid-identity/Cargo.toml crates/orbitid-identity/
COPY crates/orbitid-fapi-auth/Cargo.toml crates/orbitid-fapi-auth/
COPY crates/orbitid-fapi-account/Cargo.toml crates/orbitid-fapi-account/
COPY crates/orbitid-bapi/Cargo.toml crates/orbitid-bapi/
COPY crates/orbitid-oidc/Cargo.toml crates/orbitid-oidc/
COPY crates/orbitid-server/Cargo.toml crates/orbitid-server/
RUN for crate in crates/*; do \
      mkdir -p "$crate/src"; \
      test -f "$crate/src/lib.rs" || : > "$crate/src/lib.rs"; \
    done \
 && printf 'fn main() {}\n' > crates/orbitid-server/src/main.rs \
 && cargo build --release --locked -p orbitid-server

COPY crates ./crates
COPY docs/openapi.json docs/openapi.json
# COPY preserves the source files' mtimes from the build context. The dummy build above
# just created newer artifacts, so Cargo would consider this real (older) source fresh
# and silently keep the stub binary. Touch every real input so the workspace crates are
# recompiled; external dependencies stay cached.
RUN find crates docs -type f -exec touch {} + \
 && cargo build --release --locked -p orbitid-server

FROM debian:bookworm-slim AS runtime
# Only the runtime libraries the binary actually links: confirm with
#   ldd /usr/local/bin/orbitid
# The xmlsec1 packages pull their own transitive dependencies from apt.
RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates \
      libxml2 \
      libxmlsec1 \
      libxmlsec1-openssl \
      libssl3 \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=4000 \
    ORBITID_DATA_DIR=/tmp/orbitid \
    ORBITID_DASHBOARD_DIR=/app/dashboard

WORKDIR /app
COPY --from=server /src/target/release/orbitid /usr/local/bin/orbitid
COPY --from=dashboard /app/apps/dashboard/dist /app/dashboard

# Fail the build, not the deploy, when the layout or the binary is wrong:
# the binary runs without a database for `help`, the dashboard is a real build,
# no shared library is missing and nobody runs as root. The OpenAPI document is
# compiled into the binary, so the runtime image needs no source tree.
RUN test -x /usr/local/bin/orbitid \
 && orbitid help | grep -q 'Usage: orbitid' \
 && test -f /app/dashboard/index.html \
 && ! ldd /usr/local/bin/orbitid | grep -q "not found" \
 && groupadd --system --gid 10001 orbitid \
 && useradd --system --uid 10001 --gid orbitid --home-dir /app --no-create-home orbitid \
 && install -d -o 10001 -g 10001 -m 1777 /tmp/orbitid

USER 10001:10001
# The runtime really is unprivileged, and the application tree is not writable under a read-only root.
RUN test "$(id -u)" = "10001" && test ! -w /app
EXPOSE 4000
STOPSIGNAL SIGTERM
# /ready is the database-aware endpoint (`/health` is liveness only); the binary
# probes it itself, so the runtime image needs no curl or shell.
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=5 \
  CMD ["/usr/local/bin/orbitid", "healthcheck"]
CMD ["start"]
ENTRYPOINT ["/usr/local/bin/orbitid"]
