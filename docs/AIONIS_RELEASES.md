# Aionis Releases

Status: public Runtime, npm, MCP, SDK, and Docker release path

## Current Public Artifacts

| Artifact | Current channel | Purpose |
|---|---:|---|
| GitHub Runtime source | `v0.2.x` tags | Source release for the Runtime, docs, examples, SDK workspace, MCP bridge, and installer workspace. |
| Docker image | `ghcr.io/ostinatocc/aionis:<tag>` | Local-first Aionis Runtime container with persistent SQLite state under `/data`. |
| `@aionis/create` | npm latest | One-command installer for Runtime plus SDK/MCP packages. |
| `@aionis/sdk` | npm latest | TypeScript facade over Aionis product APIs. |
| `@aionis/mcp` | npm latest / [repo](https://github.com/ostinatocc/aionis-mcp) | MCP stdio bridge for Claude Code, Cursor, and other MCP clients. |

Release tags are immutable. If the release surface changes after a tag, create a
new patch tag instead of moving the old one.

## Docker Quickstart

Run the published image:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.2.1
```

Check the Runtime:

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/readyz
```

The Docker image defaults to the local-first Lite Runtime:

```text
AIONIS_EDITION=lite
AIONIS_MODE=local
APP_ENV=dev
MEMORY_AUTH_MODE=off
LITE_WRITE_SQLITE_PATH=/data/aionis-lite-write.sqlite
LITE_REPLAY_SQLITE_PATH=/data/aionis-lite-replay.sqlite
```

The container listens on `0.0.0.0` internally so Docker port publishing works.
Bind the host port to loopback, as shown above, unless you intentionally put the
Runtime behind a reverse proxy or switch to Server mode with authentication.

Build locally:

```bash
docker build -t aionis:local .
docker run --rm -p 127.0.0.1:3001:3001 -v aionis-data:/data aionis:local
```

Compose:

```bash
docker compose up --build
```

## Server Mode Container

For a remote SDK/MCP endpoint, run Server mode with auth instead of exposing the
Lite no-auth local mode:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  -e AIONIS_EDITION=server \
  -e AIONIS_MODE=service \
  -e APP_ENV=prod \
  -e MEMORY_AUTH_MODE=api_key \
  -e MEMORY_API_KEYS_JSON='{"local-dev":"replace-me"}' \
  -e AIONIS_LISTEN_HOST=0.0.0.0 \
  ghcr.io/ostinatocc/aionis:v0.2.1
```

Then call product routes with either `Authorization: Bearer <key>` or
`x-api-key: <key>`.

## Release Checklist

Before creating a GitHub Runtime release:

```bash
npm run -s build
npm run -s test:focused
docker build -t aionis:release-smoke .
docker run -d --rm --name aionis-release-smoke \
  -p 127.0.0.1:3001:3001 \
  -v aionis-release-smoke:/data \
  aionis:release-smoke
curl -fsS http://127.0.0.1:3001/healthz
docker rm -f aionis-release-smoke
```

Create a release:

```bash
git tag -a v0.2.1 -m "Aionis v0.2.1"
git push origin main v0.2.1
gh release create v0.2.1 \
  --repo ostinatocc/Aionis \
  --title "Aionis v0.2.1" \
  --notes-file docs/releases/v0.2.1.md
```

The Docker workflow publishes:

```text
ghcr.io/ostinatocc/aionis:v0.2.1
ghcr.io/ostinatocc/aionis:latest
```
