# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

FROM --platform=$BUILDPLATFORM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS verify

WORKDIR /verify

COPY package.json package-lock.json ./

RUN npm ci

COPY . .
RUN npm run -s build && touch /tmp/aionis-build-verified

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS runtime-deps

WORKDIR /app

COPY package.json package-lock.json ./

RUN npm ci

FROM node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5 AS runtime

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
    LITE_LOCAL_ACTOR_ID=local-docker

COPY --chown=node:node . /app
COPY --from=runtime-deps --chown=node:node /app/node_modules /app/node_modules
COPY --from=verify /tmp/aionis-build-verified /tmp/aionis-build-verified

RUN mkdir -p /data /app/.tmp && chown -R node:node /data /app/.tmp

USER node

EXPOSE 3001
VOLUME ["/data"]

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.PORT || '3001') + '/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"

CMD ["bash", "scripts/start-lite.sh"]
