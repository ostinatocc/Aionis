# syntax=docker/dockerfile:1.7@sha256:a57df69d0ea827fb7266491f2813635de6f17269be881f696fbfdf2d83dda33e

ARG NODE_IMAGE=node:24-bookworm-slim@sha256:cb4e8f7c443347358b7875e717c29e27bf9befc8f5a26cf18af3c3dec80e58c5

FROM --platform=$BUILDPLATFORM ${NODE_IMAGE} AS build

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts

COPY tsconfig.json ./
COPY LICENSE NOTICE ./
COPY tools ./tools
COPY src ./src

RUN npm run -s build \
    && node tools/stage-continuation-runtime-v1-oci.mjs

FROM ${NODE_IMAGE} AS production-dependencies

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts \
    && npm cache clean --force

FROM ${NODE_IMAGE} AS runtime

ENV NODE_ENV=production \
    npm_config_update_notifier=false \
    npm_config_fund=false \
    npm_config_audit=false

WORKDIR /app

COPY --from=production-dependencies --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist-oci-runtime ./

RUN mkdir -p /data /run/aionis \
    && chown node:node /data /run/aionis \
    && chmod 0700 /data /run/aionis

USER node

EXPOSE 3000
VOLUME ["/data"]
STOPSIGNAL SIGTERM

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:' + (process.env.AIONIS_HTTP_PORT || '3000') + '/healthz').then((response) => process.exit(response.status === 200 ? 0 : 1)).catch(() => process.exit(1))"

CMD ["node", "dist/runtime-v1/daemon-entry.js"]
