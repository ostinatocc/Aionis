# Aionis Releases

Status: v0.3 stable baseline for Runtime, npm packages, Docker, MCP, SDK, AIFS,
and native adapter release paths.

## Current Public Artifacts

| Artifact | Current channel | Purpose |
|---|---:|---|
| GitHub Runtime source | `v0.3.1` tag | Runtime source, product APIs, docs, Docker build, and Runtime validation loops. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.1` | Local-first Runtime container with persistent SQLite state under `/data`. |
| `aionis` | `0.3.4` npm / [repo](https://github.com/ostinatocc/aionis-cli) | Top-level product CLI. Owns `npx aionis setup` and delegates Runtime install to `@aionis/create`. |
| `@aionis/create` | `0.3.2` npm / [repo](https://github.com/ostinatocc/aionis-create) | One-command Runtime installer. |
| `@aionis/sdk` | `0.3.1` npm / [repo](https://github.com/ostinatocc/aionis-sdk) | TypeScript facade over Aionis product APIs. |
| `@aionis/mcp` | `0.3.2` npm / [repo](https://github.com/ostinatocc/aionis-mcp) | MCP stdio bridge for Claude Code, Cursor, Codex-style tools, and other MCP clients. |
| `@aionis/aifs` | `0.3.0` npm / [repo](https://github.com/ostinatocc/aionis-aifs) | Aionis File Surface for file-aware Agent context. |
| `@aionis/claude-code` and Claude Code plugin | `0.3.1` npm / [repo](https://github.com/ostinatocc/aionis-claude-code) | Claude Code lifecycle hooks plus plugin marketplace manifest. |
| `@aionis/substrate` | `0.1.9` npm / [repo](https://github.com/ostinatocc/AionisSubstrate) | External durable evidence sidecar for Runtime mirror, audit, backup, preview, and migration planning. Requires Node 24+. |

Fresh-install verification: [v0.3.0 release verification](./releases/v0.3.0-verification.md).
Runtime patch notes: [v0.3.1 release notes](./releases/v0.3.1.md).

Release tags are immutable. If the release surface changes after a tag, create a
new patch tag instead of moving the old one.

## Repository Boundary

| Repository | Release responsibility |
|---|---|
| [ostinatocc/Aionis](https://github.com/ostinatocc/Aionis) | Runtime source tags, Docker image, product docs, release artifacts, and Runtime validation loops. |
| [ostinatocc/aionis-cli](https://github.com/ostinatocc/aionis-cli) | `aionis` npm package and guided product setup releases. |
| [ostinatocc/aionis-create](https://github.com/ostinatocc/aionis-create) | `@aionis/create` npm package and installer releases. |
| [ostinatocc/aionis-sdk](https://github.com/ostinatocc/aionis-sdk) | `@aionis/sdk` npm package and SDK releases. |
| [ostinatocc/aionis-mcp](https://github.com/ostinatocc/aionis-mcp) | `@aionis/mcp` npm package and MCP adapter releases. |
| [ostinatocc/aionis-aifs](https://github.com/ostinatocc/aionis-aifs) | `@aionis/aifs` npm package and file-surface releases. |
| [ostinatocc/aionis-claude-code](https://github.com/ostinatocc/aionis-claude-code) | Claude Code plugin releases and `@aionis/claude-code` npm helper releases. |
| [ostinatocc/AionisSubstrate](https://github.com/ostinatocc/AionisSubstrate) | `@aionis/substrate` npm package and external sidecar releases. |

`@aionis/substrate` is tracked separately from the Runtime stable package train.
It is an external sidecar package, not a Runtime dependency or storage
replacement.

## Docker Quickstart

Run the published image:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.3.1
```

Check the Runtime:

```bash
curl http://127.0.0.1:3001/healthz
curl http://127.0.0.1:3001/readyz
```

The Docker image defaults to the local-first Runtime:

```text
AIONIS_EDITION=lite
AIONIS_MODE=local
APP_ENV=dev
MEMORY_AUTH_MODE=off
LITE_WRITE_SQLITE_PATH=/data/aionis-lite-write.sqlite
LITE_REPLAY_SQLITE_PATH=/data/aionis-lite-replay.sqlite
```

The container listens on `0.0.0.0` internally so Docker port publishing works.
Bind the host port to loopback for local use. For remote SDK/MCP clients, put
the Runtime behind your service boundary and enable Server mode authentication.

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

For a remote SDK/MCP endpoint, run Server mode with auth:

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
  ghcr.io/ostinatocc/aionis:v0.3.1
```

Then call product routes with either `Authorization: Bearer <key>` or
`x-api-key: <key>`.

## Release Checklist

Before creating a GitHub Runtime release:

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s runtime:smoke:external-packages
npm run -s runtime:smoke:fresh-install
docker build -t aionis:release-smoke .
docker run -d --rm --name aionis-release-smoke \
  -p 127.0.0.1:3001:3001 \
  -v aionis-release-smoke:/data \
  aionis:release-smoke
curl -fsS http://127.0.0.1:3001/healthz
docker rm -f aionis-release-smoke
```

Create a Runtime release:

```bash
git tag -a v0.3.1 -m "Aionis v0.3.1"
git push origin main v0.3.1
gh release create v0.3.1 \
  --repo ostinatocc/Aionis \
  --title "Aionis v0.3.1" \
  --notes-file docs/releases/v0.3.1.md
```

The Docker workflow publishes:

```text
ghcr.io/ostinatocc/aionis:v0.3.1
ghcr.io/ostinatocc/aionis:latest
```
