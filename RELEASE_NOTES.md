# Aionis v0.3 Stable Release Notes

Aionis v0.3 is the first stable baseline release train for the public Aionis
Runtime and integration packages. The Runtime source patch documented here is
`v0.3.1`; npm packages may carry different `0.3.x` patch numbers because they
release from standalone repositories.

## Headline

> Aionis turns long-running agent history into shorter, cleaner, auditable
> execution context.

Aionis records plans, decisions, validation evidence, outcomes, handoffs,
controlled forgetting signals, and rehydrate pointers. It then compiles that
history into governed Agent context: what to use now, what to inspect first,
what to keep out of direct use, and what raw evidence can be restored on demand.

## Stable Baseline Package Train

Current public patch versions for the v0.3 train:

- `aionis@0.3.4`
- `@aionis/create@0.3.3`
- `@aionis/sdk@0.3.1`
- `@aionis/mcp@0.3.2`
- `@aionis/aifs@0.3.0`
- `@aionis/claude-code@0.3.1`
- Runtime source tag `v0.3.1`
- Docker image `ghcr.io/ostinatocc/aionis:v0.3.1`

`@aionis/substrate` remains an experimental sidecar/research package at
`0.1.0`; it is not part of this stable release train.

## What Ships

### Execution Memory Runtime

The Runtime owns the state model, product APIs, SQLite fact store, optional Zvec
ANN candidate sidecar, guide/context compiler, feedback attribution, measure,
forget, rehydrate, and operator snapshot surfaces.

### State-Preserving Context Compression

Aionis compiles long execution history into a bounded context contract that
preserves current state, validated routes, rejected evidence, rehydrate
pointers, and audit receipts without transferring full history by default.

### Memory Firewall

Aionis can govern internal memory and external memory candidates from Mem0, Zep,
Supermemory, vector stores, markdown stores, logs, or custom retrieval systems.
The backend retrieves candidates; Aionis decides whether each candidate is
admissible for the current agent state.

### Agent Flight Recorder

Every guide/context decision can be traced through admission records, memory-use
receipts, feedback attribution, and operator snapshots. This gives host teams a
replayable record of what memory was shown, suppressed, restored, or acted on.

### AIFS, MCP, SDK, CLI, and Native Adapters

- `npx aionis setup` is the guided product installer.
- `@aionis/create` installs the Runtime and writes the Runtime `.env`.
- `@aionis/sdk` is the TypeScript host integration facade.
- `@aionis/mcp` gives MCP clients a portable Aionis bridge.
- `@aionis/aifs` mirrors governed context into `.aionis` files for file-aware
  coding agents.
- `@aionis/claude-code` provides native Claude Code lifecycle hooks without
  making Claude Code the only product path.

## Installation

Recommended first command:

```bash
npx aionis setup
```

Direct Runtime installer:

```bash
npx @aionis/create@latest
```

Docker:

```bash
docker run --rm \
  -p 127.0.0.1:3001:3001 \
  -v aionis-data:/data \
  ghcr.io/ostinatocc/aionis:v0.3.1
```

Optional Zvec candidate index:

```bash
npx aionis setup --with-zvec-ann
```

SQLite remains the Runtime fact source. Zvec is a persisted candidate index:
new and updated memories are synchronized after successful Runtime writes, then
all candidates still pass through Aionis scope, lifecycle, authority,
admission, and rehydrate governance before they reach an Agent.

## Verification Checklist

Before publishing this release train, run:

```bash
npm run -s typecheck
npm run -s lite:test
npm run -s runtime:smoke:external-packages
npm run -s runtime:smoke:fresh-install
docker build -t aionis:release-smoke .
```

For pre-publish candidate validation of external packages, pass explicit
package specs or tarballs:

```bash
AIONIS_FRESH_INSTALL_CREATE_SPEC="@aionis/create@latest" \
AIONIS_FRESH_INSTALL_SDK_SPEC="@aionis/sdk@latest" \
AIONIS_FRESH_INSTALL_MCP_SPEC="@aionis/mcp@latest" \
AIONIS_FRESH_INSTALL_REPO="file:///absolute/path/to/Aionis" \
npm run -s runtime:smoke:fresh-install
```

## Publish Order

Publish packages from standalone repositories in dependency order:

```bash
# 1. SDK first
cd /Volumes/ziel/aionis-sdk
npm publish --access public

# 2. Packages that depend on the SDK
cd /Volumes/ziel/aionis-mcp
npm publish --access public
cd /Volumes/ziel/aionis-aifs
npm publish --access public
cd /Volumes/ziel/aionis-claude-code/packages/aionis-claude-code
npm publish --access public

# 3. Installer and top-level CLI
cd /Volumes/ziel/aionis-create
npm publish --access public
cd /Volumes/ziel/aionis-cli
npm publish --access public
```

Then tag Runtime and publish Docker:

```bash
git tag -a v0.3.1 -m "Aionis v0.3.1"
git push origin main v0.3.1
gh release create v0.3.1 \
  --repo ostinatocc/Aionis \
  --title "Aionis v0.3.1" \
  --notes-file docs/releases/v0.3.1.md
```
