# Aionis Releases

Status: public Runtime, npm, MCP, SDK, and Docker release path

## Current Public Artifacts

| Artifact | Current channel | Purpose |
|---|---:|---|
| GitHub Runtime source | `v0.2.x` tags | Source release for the Runtime, product APIs, docs, examples, Docker build, and Runtime validation loops. |
| Docker image | `ghcr.io/ostinatocc/aionis:<tag>` | Local-first Aionis Runtime container with persistent SQLite state under `/data`. |
| `aionis` | npm latest / [repo](https://github.com/ostinatocc/aionis-cli) | Top-level product CLI. Owns `npx aionis setup` and delegates Runtime install to `@aionis/create`. |
| `@aionis/create` | npm latest / [repo](https://github.com/ostinatocc/aionis-create) | One-command installer for Runtime plus SDK/MCP packages. |
| `@aionis/sdk` | npm latest / [repo](https://github.com/ostinatocc/aionis-sdk) | TypeScript facade over Aionis product APIs. |
| `@aionis/mcp` | npm latest / [repo](https://github.com/ostinatocc/aionis-mcp) | MCP stdio bridge for Claude Code, Cursor, and other MCP clients. |
| `@aionis/claude-code` and Claude Code plugin | npm latest / [repo](https://github.com/ostinatocc/aionis-claude-code) | Claude Code lifecycle hooks plus plugin marketplace manifest. |

Release tags are immutable. If the release surface changes after a tag, create a
new patch tag instead of moving the old one.

## Repository Boundary

| Repository | Release responsibility |
|---|---|
| [ostinatocc/Aionis](https://github.com/ostinatocc/Aionis) | Runtime source tags, Docker image, product docs, examples, and Runtime validation loops. |
| [ostinatocc/aionis-cli](https://github.com/ostinatocc/aionis-cli) | `aionis` npm package and guided product setup releases. |
| [ostinatocc/aionis-create](https://github.com/ostinatocc/aionis-create) | `@aionis/create` npm package and installer releases. |
| [ostinatocc/aionis-sdk](https://github.com/ostinatocc/aionis-sdk) | `@aionis/sdk` npm package and SDK releases. |
| [ostinatocc/aionis-mcp](https://github.com/ostinatocc/aionis-mcp) | `@aionis/mcp` npm package and MCP adapter releases. |
| [ostinatocc/aionis-claude-code](https://github.com/ostinatocc/aionis-claude-code) | Claude Code plugin releases and `@aionis/claude-code` npm helper releases. |

## Docker Quickstart

Run the published image:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.2.2
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
  ghcr.io/ostinatocc/aionis:v0.2.2
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
git tag -a v0.2.2 -m "Aionis v0.2.2"
git push origin main v0.2.2
gh release create v0.2.2 \
  --repo ostinatocc/Aionis \
  --title "Aionis v0.2.2" \
  --notes-file docs/releases/v0.2.2.md
```

The Docker workflow publishes:

```text
ghcr.io/ostinatocc/aionis:v0.2.2
ghcr.io/ostinatocc/aionis:latest
```
