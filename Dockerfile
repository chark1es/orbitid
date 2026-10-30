# syntax=docker/dockerfile:1
#
# One image, two installs:
#   build  – the whole workspace, so the dashboard can be built.
#   deps   – only the workspaces the server needs at runtime, production dependencies only.
# The runtime stage copies the `deps` node_modules, so it holds no test runner, bundler or type definitions,
# and every `node_modules/@orbitid/*` link resolves (the server imports `@orbitid/shared`).

FROM node:20-bookworm-slim AS build
RUN npm install -g bun@1.4.4
WORKDIR /app

# Manifests first: the dependency layer is reused until a package.json or the lockfile changes.
COPY package.json bun.lock bunfig.toml ./
COPY packages/backend/package.json packages/backend/
COPY packages/js/package.json packages/js/
COPY packages/nextjs/package.json packages/nextjs/
COPY packages/node/package.json packages/node/
COPY packages/react/package.json packages/react/
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
COPY packages/ui/package.json packages/ui/
COPY apps/dashboard/package.json apps/dashboard/
COPY playground/package.json playground/
RUN bun install --frozen-lockfile

COPY . .
RUN bun run --filter @orbitid/dashboard build

# Production dependency tree for the server. `better-sqlite3` and `@node-rs/argon2` are native modules: their
# prebuilt binaries are fetched for the Node 20 ABI of this image and verified below, so the runtime never needs
# a compiler toolchain.
FROM node:20-bookworm-slim AS deps
RUN npm install -g bun@1.4.4
WORKDIR /app
COPY package.json bun.lock bunfig.toml ./
COPY packages/server/package.json packages/server/
COPY packages/shared/package.json packages/shared/
RUN bun install --frozen-lockfile --production

FROM node:20-bookworm-slim AS runtime
# TMPDIR lives in the data volume: the TypeScript runner unpacks a loader there, and a read-only root filesystem
# must not break `docker exec … cli.ts keys` either. /data is the one path a deployment always makes writable.
ENV NODE_ENV=production \
    PORT=4000 \
    ORBITID_DATA_DIR=/data \
    ORBITID_DASHBOARD_DIR=/app/dashboard \
    TMPDIR=/data/tmp
WORKDIR /app

COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/package.json ./package.json
COPY packages/server ./packages/server
COPY packages/shared ./packages/shared
COPY docker-entrypoint.sh /usr/local/bin/docker-entrypoint
COPY --from=build /app/apps/dashboard/dist ./dashboard

RUN chmod +x /usr/local/bin/docker-entrypoint

# Fail the build, not the deploy, when the layout is wrong: native bindings must load on this Node's ABI, every
# workspace link must resolve, and the server entry (with its whole import graph) must load under tsx.
# TMPDIR is overridden here: the runtime value points into the data volume, which must stay untouched (and
# owned by `node`) in the image, because Docker copies an image's /data into a fresh named volume.
RUN TMPDIR=/tmp node -e "require('better-sqlite3'); require('@node-rs/argon2'); console.log('native modules load')" \
 && node -e "console.log('shared resolves:', require.resolve('@orbitid/shared'))" \
 && for link in node_modules/@orbitid/*; do test -e "$link" || { echo "dangling workspace link: $link" >&2; exit 1; }; done \
 && test -f dashboard/index.html \
 && TMPDIR=/tmp node node_modules/tsx/dist/cli.mjs -e "import('./packages/server/src/app.ts').then(() => console.log('server entry loads'))"

# The data volume is the only writable path, and it must be owned by the unprivileged user from the first
# start, so nothing above may have left anything in it.
RUN mkdir -p /data && chown node:node /data && test -z "$(ls -A /data)"
USER node
VOLUME /data
EXPOSE 4000
STOPSIGNAL SIGTERM
HEALTHCHECK --interval=15s --timeout=3s --start-period=30s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
ENTRYPOINT ["/usr/local/bin/docker-entrypoint"]
CMD ["start"]
