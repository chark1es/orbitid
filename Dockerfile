# syntax=docker/dockerfile:1

FROM node:20-bookworm-slim AS build
RUN npm install -g bun@1.4.4
WORKDIR /app
COPY . .
RUN bun install --frozen-lockfile
RUN bun run --filter @orbitid/dashboard build

FROM node:20-bookworm-slim AS runtime
ENV NODE_ENV=production \
    PORT=4000 \
    ORBITID_DATA_DIR=/data \
    ORBITID_DASHBOARD_DIR=/app/dashboard
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared ./packages/shared
COPY --from=build /app/packages/server ./packages/server
COPY --from=build /app/apps/dashboard/dist ./dashboard
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 4000
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=5 \
  CMD node -e "fetch('http://localhost:'+(process.env.PORT||4000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node_modules/.bin/tsx", "packages/server/src/cli.ts", "start"]
