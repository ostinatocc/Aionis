# Aionis v0.2.0 Release Notes

Aionis v0.2.0 is the public beta release for developers building long-running
agents that need governed execution memory instead of raw history transfer.

## Headline

> Aionis gives long-running agents shorter, safer, auditable context.

It turns plans, decisions, outcomes, failed branches, procedures, and rehydrate
pointers into governed execution context. The agent receives what to use now,
what to inspect first, what not to use, and what needs raw evidence recovery.

## What Ships

### Execution Memory

Use Aionis to preserve accepted routes, action boundaries, failed branches,
procedures, and active paths across sessions, roles, model boundaries, and
multi-agent handoffs.

### Memory Firewall

Keep an existing memory backend for retrieval, then put Aionis in front of the
agent as an admission layer. Aionis can govern candidates from Mem0, Zep,
Supermemory, Pinecone, pgvector, Chroma, Weaviate, LangGraph Store, markdown,
logs, or custom memory systems.

### Agent Flight Recorder

Replay what memory the agent could see at decision time, which memory was
blocked, which memory was admitted, and why.

### MCP, SDK, and Installer

- `@aionis/create@0.2.0`
- `@aionis/mcp@0.2.0`
- `@aionis/sdk@0.2.22`

The SDK artifact uses `0.2.22` because npm registry tombstones already reserve
earlier `0.2.x` SDK versions. MCP depends on `@aionis/sdk@^0.2.0`, so
`@aionis/mcp@0.2.0` installs with `@aionis/sdk@0.2.22`.

Fastest trial path:

```bash
npx @aionis/create@latest
```

MCP bridge:

```bash
npx @aionis/mcp@latest --base-url http://127.0.0.1:3001 --scope-from workspace
```

## Recommended Users

Use v0.2.0 if you are building or testing:

- coding agents
- Claude Code / Cursor / Zcode / Codex MCP memory
- multi-agent planner/worker/reviewer/verifier workflows
- cross-session task continuation
- memory firewalling for existing retrieval systems
- audit and replay for agent decisions
- admission dataset collection for memory-governance research

## Boundary

v0.2.0 is a Runtime release, not a finished Cloud SaaS.

Included:

- local-first Lite Runtime
- self-managed Managed Server beta
- SDK
- MCP bridge
- installer
- product APIs
- audit surfaces

Not included:

- hosted Aionis Cloud
- billing
- org management
- managed multi-tenant control plane
- hosted dashboard account system
- production SLA

## Verification Checklist

Before publishing this release, run:

```bash
npm run -s typecheck
npm run -s sdk:source-sync
npm run -s packages:build
npm run -s packages:test
npm run -s lite:test
npm run -s runtime:smoke:external-packages
npm run -s runtime:smoke:fresh-install
```

If an embedding-backed quickstart is needed, provide `OPENAI_API_KEY` or
`MINIMAX_API_KEY`. The default fresh install path intentionally supports
`EMBEDDING_PROVIDER=none`.

For pre-publish candidate validation, pack all three workspaces and pass them
to the fresh install smoke:

```bash
tmpdir=$(mktemp -d /tmp/aionis-v020-pack-XXXXXX)
npm pack --workspace @aionis/create --pack-destination "$tmpdir"
npm pack --workspace @aionis/sdk --pack-destination "$tmpdir"
npm pack --workspace @aionis/mcp --pack-destination "$tmpdir"

AIONIS_FRESH_INSTALL_CREATE_SPEC="$tmpdir/aionis-create-0.2.0.tgz" \
AIONIS_FRESH_INSTALL_SDK_SPEC="$tmpdir/aionis-sdk-0.2.22.tgz" \
AIONIS_FRESH_INSTALL_MCP_SPEC="$tmpdir/aionis-mcp-0.2.0.tgz" \
AIONIS_FRESH_INSTALL_REPO="file:///absolute/path/to/Aionis" \
npm run -s runtime:smoke:fresh-install
```

## Publish Order

Publish packages in dependency order:

```bash
npm publish --workspace @aionis/sdk --access public
npm publish --workspace @aionis/mcp --access public
npm publish --workspace @aionis/create --access public
```

Then create a GitHub release/tag:

```bash
git tag v0.2.0
git push origin main
git push origin v0.2.0
```
