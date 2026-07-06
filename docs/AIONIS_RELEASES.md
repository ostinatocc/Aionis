# Aionis Releases

Status: v0.3 stable baseline for Runtime, npm packages, Docker, MCP, SDK, AIFS,
and native adapter release paths.

## Current Public Artifacts

| Artifact | Current channel | Purpose |
|---|---:|---|
| GitHub Runtime source | `v0.3.3` tag | Runtime source, product APIs, docs, Docker build, and Runtime validation loops. |
| Docker image | `ghcr.io/ostinatocc/aionis:v0.3.3` | Local-first Runtime container with persistent SQLite state under `/data`. |
| `aionis` | `0.3.8` npm / [repo](https://github.com/ostinatocc/aionis-cli) | Top-level product CLI. Owns `npx aionis setup`, read-only `doctor`/`health`/`boundary`/`snapshot` inspection, Agent Flight Recorder audit, explicit `forget` lifecycle control, and trace-derived skill candidate review commands. |
| `@aionis/create` | `0.3.5` npm / [repo](https://github.com/ostinatocc/aionis-create) | One-command Runtime installer. |
| `@aionis/sdk` | `0.3.8` npm / [repo](https://github.com/ostinatocc/aionis-sdk) | TypeScript facade over Aionis product APIs, including trace-derived skill materialization helpers and typed task context profiles for `/v1/guide`. |
| `@aionis/mcp` | `0.3.2` npm / [repo](https://github.com/ostinatocc/aionis-mcp) | MCP stdio bridge for Claude Code, Cursor, Codex-style tools, and other MCP clients. |
| `@aionis/aifs` | `0.3.0` npm / [repo](https://github.com/ostinatocc/aionis-aifs) | Aionis File Surface for file-aware Agent context. |
| `@aionis/claude-code` and Claude Code plugin | `0.3.1` npm / [repo](https://github.com/ostinatocc/aionis-claude-code) | Claude Code lifecycle hooks plus plugin marketplace manifest. |
| `@aionis/substrate` | `0.1.11` npm / [repo](https://github.com/ostinatocc/AionisSubstrate) | External durable evidence sidecar for Runtime mirror, audit, backup, preview, and migration planning. Requires Node 24+. |

Fresh-install verification: [v0.3.0 release verification](./releases/v0.3.0-verification.md).
Runtime patch notes: [v0.3.3 release notes](./releases/v0.3.3.md).

Latest SDK patch: `@aionis/sdk@0.3.8` exposes
`materializeSkillCandidate()` and `observeMaterializedSkillCandidate()` for the
reviewed trace-derived skill memory loop, while keeping typed
`task_context_profile` guide requests for host adapters that want task-specific
Agent context rendering without changing Runtime governance.

Latest CLI patch: `aionis@0.3.8` adds the `--profile full-local` setup profile
on top of operator `snapshot`, `audit flight-recorder`, explicit `forget`
lifecycle commands, trace-derived skill review, and read-only Runtime
inspection commands.

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
  ghcr.io/ostinatocc/aionis:v0.3.3
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
  ghcr.io/ostinatocc/aionis:v0.3.3
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
npm run -s runtime:smoke:published-cli
docker build -t aionis:release-smoke .
docker run -d --rm --name aionis-release-smoke \
  -p 127.0.0.1:3001:3001 \
  -v aionis-release-smoke:/data \
  aionis:release-smoke
curl -fsS http://127.0.0.1:3001/healthz
docker rm -f aionis-release-smoke
```

After publishing the top-level CLI, pin the just-published npm version in the
published CLI smoke:

```bash
AIONIS_PUBLISHED_CLI_SMOKE_SPEC="aionis@0.3.8" \
npm run -s runtime:smoke:published-cli
```

Create a Runtime release:

```bash
git tag -a v0.3.3 -m "Aionis v0.3.3"
git push origin main v0.3.3
gh release create v0.3.3 \
  --repo ostinatocc/Aionis \
  --title "Aionis v0.3.3" \
  --notes-file docs/releases/v0.3.3.md
```

The Docker workflow publishes:

```text
ghcr.io/ostinatocc/aionis:v0.3.3
ghcr.io/ostinatocc/aionis:latest
```
