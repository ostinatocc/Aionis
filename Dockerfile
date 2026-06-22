# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps

WORKDIR /app

COPY package.json package-lock.json ./
COPY packages/aionis-sdk/package.json packages/aionis-sdk/package.json
COPY packages/aionis-mcp/package.json packages/aionis-mcp/package.json
COPY packages/create-aionis/package.json packages/create-aionis/package.json

RUN npm ci

FROM deps AS build

COPY . .
RUN npm run -s build

FROM node:22-bookworm-slim AS runtime

WORKDIR /app

ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    AIONIS_EDITION=lite \
    AIONIS_MODE=local \
    APP_ENV=dev \
    AIONIS_LISTEN_HOST=0.0.0.0 \
    AIONIS_ALLOW_UNAUTHENTICATED_REMOTE=true \
    MEMORY_AUTH_MODE=off \
    TENANT_QUOTA_ENABLED=false \
    RATE_LIMIT_BYPASS_LOOPBACK=true \
    LITE_WRITE_SQLITE_PATH=/data/aionis-lite-write.sqlite \
    LITE_REPLAY_SQLITE_PATH=/data/aionis-lite-replay.sqlite \
    LITE_LOCAL_ACTOR_ID=local-docker

COPY --from=build --chown=node:node /app /app

RUN mkdir -p /data /app/.tmp && chown -R node:node /data /app/.tmp

USER node

EXPOSE 3001
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/healthz').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["npm", "run", "-s", "lite:start"]
