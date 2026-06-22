# Aionis MCP

Status: drop-in MCP bridge for coding agents

`@aionis/mcp` exposes Aionis through MCP stdio so Claude Code, Cursor, and other
MCP clients can use governed execution memory without a custom host adapter.

Standalone adapter repo:
[ostinatocc/aionis-mcp](https://github.com/ostinatocc/aionis-mcp).
The Runtime repository keeps a bundled copy for compatibility, tests, and
local development.

## Why MCP

MCP is the fastest way to try Aionis inside a coding agent. The bridge runs as
a local stdio server and lets an existing agent ask Aionis for governed
execution context before it continues work.

This should be the first public trial path for Claude Code and Cursor users:
they can connect Aionis to an existing Agent loop, see route-safe execution
context, then add feedback attribution later.

The bridge uses the same product path as the SDK:

1. MCP tools call `@aionis/sdk`.
2. The SDK calls product APIs such as `/v1/observe`, `/v1/guide`, `/v1/feedback`,
   `/v1/measure`, and `/v1/operator/snapshot`.
3. Runtime core returns lifecycle, authority, scope, source, execution tree,
   context compilation, and audit surfaces.

## Install

Install Runtime, SDK, and MCP bridge:

```bash
npx @aionis/create@latest
```

Start Runtime from the generated checkout:

```bash
cd Aionis
npm run -s lite:start
```

Run MCP over stdio:

```bash
npx @aionis/mcp@latest --base-url http://127.0.0.1:3001 --scope-from workspace
```

Or configure through env:

```bash
AIONIS_BASE_URL=http://127.0.0.1:3001 \
AIONIS_TENANT_ID=default \
AIONIS_SCOPE_FROM=workspace \
npx @aionis/mcp@latest
```

`--scope` has the highest priority. Use it when the host
already knows the exact Aionis memory boundary. Use `--scope-from workspace` for
MCP-first coding agents where the bridge should create or reuse a stable
workspace identity in `.aionis/workspace.json`. If the MCP host starts the
server from a different working directory, add
`--repo-root /absolute/path/to/repo`. Git root, git remote, and cwd identities
are stored as aliases for the same workspace, while the primary
`ws:<name>:<id>` scope remains stable.

## Claude Code

For Claude Code, prefer the plugin path because it installs both MCP and
lifecycle hooks:

```bash
npx @aionis/create@latest .aionis-runtime --with-claude-code
cd .aionis-runtime
npm run -s lite:start
```

```text
/plugin marketplace add https://github.com/ostinatocc/aionis-claude-code
/plugin install aionis@aionis-claude-code
/aionis:doctor
```

The Claude Code plugin defaults to `http://127.0.0.1:3101`, matching the
`@aionis/create --with-claude-code` Runtime port.
Its standalone adapter repo is
[ostinatocc/aionis-claude-code](https://github.com/ostinatocc/aionis-claude-code).

Add Aionis as raw MCP only when you are configuring another MCP client or you do
not want lifecycle hooks:

```bash
claude mcp add --transport stdio --scope project aionis -- \
  npx -y @aionis/mcp@latest \
  --base-url http://127.0.0.1:3001 \
  --scope-from workspace \
  --workspace-id-store user
```

Use local scope for a private machine-only config:

```bash
claude mcp add --transport stdio --scope local aionis -- \
  npx -y @aionis/mcp@latest \
  --base-url http://127.0.0.1:3001 \
  --scope-from workspace \
  --workspace-id-store user
```

Inspect the server with:

```bash
claude mcp list
claude mcp get aionis
```

The smallest useful trial is context-first:

```text
aionis_context -> Claude Code action
```

For enforced Claude Code lifecycle integration, onboard the hook pack once:

```bash
npx @aionis/claude-code@latest onboard --base-url http://127.0.0.1:3001
```

MCP-only gives Claude Code tools. Onboarding adds user-level MCP plus
`SessionStart`,
`UserPromptSubmit`, `PostToolUse`, `PostToolUseFailure`, `PostCompact`, and
`SessionEnd` automation so Aionis context is injected and execution evidence is
recorded even when the Agent does not proactively call MCP tools.

See [AIONIS_CLAUDE_CODE_INTEGRATION.md](AIONIS_CLAUDE_CODE_INTEGRATION.md).

The stronger coding-agent loop is:

```text
aionis_context -> Claude Code action -> aionis_record_step -> aionis_flight_recorder
```

The full loop adds `aionis_measure` and `aionis_snapshot` once the host can
report outcome and used memory IDs.

For native Claude Code hooks, use the official plugin integration instead of
the MCP-only bridge:
[AIONIS_CLAUDE_CODE_INTEGRATION.md](AIONIS_CLAUDE_CODE_INTEGRATION.md).

## MCP Client Config

Claude Code, Cursor, and most MCP clients use the common `mcpServers` shape:

```json
{
  "mcpServers": {
    "aionis": {
      "command": "npx",
      "args": [
        "-y",
        "@aionis/mcp@latest",
        "--base-url",
        "http://127.0.0.1:3001",
        "--scope-from",
        "workspace"
      ],
      "env": {
        "AIONIS_TENANT_ID": "default"
      }
    }
  }
}
```

Zed/Zcode-style clients use `context_servers` instead:

```json
{
  "context_servers": {
    "aionis": {
      "command": "npx",
      "args": [
        "-y",
        "@aionis/mcp@latest",
        "--base-url",
        "http://127.0.0.1:3001",
        "--scope-from",
        "workspace"
      ],
      "env": {
        "AIONIS_TENANT_ID": "default"
      }
    }
  }
}
```

If Zed/Zcode launches the MCP process outside the project root, use:

```json
{
  "context_servers": {
    "aionis": {
      "command": "npx",
      "args": [
        "-y",
        "@aionis/mcp@latest",
        "--base-url",
        "http://127.0.0.1:3001",
        "--scope-from",
        "workspace",
        "--repo-root",
        "/absolute/path/to/your/repo"
      ]
    }
  }
}
```

The derived scope is a stable project boundary such as
`ws:checkout-service:<id>`. Planner, worker, verifier, reviewer, and external
Agent sessions that use the same derived scope share execution memory while
still preserving run/task/role metadata inside that project boundary. If the
directory later becomes a git repo or gains a remote, Aionis keeps the same
workspace scope and adds the new git identity as an alias.

## Tools

| Tool | What it does |
|---|---|
| `aionis_context` | Compiles SDK execution-agent context for the current run. Can also record a lightweight observation first. |
| `aionis_record_step` | Records execution state and optionally attributes feedback if memory IDs are supplied. |
| `aionis_handoff` | Records planner/worker/verifier/reviewer handoff state. |
| `aionis_remember` | Stores ordinary memory through the governed observe path. |
| `aionis_govern_memory` | Routes external Mem0/Zep/vector/markdown candidates through Aionis Memory Firewall before prompt use. |
| `aionis_measure` | Measures guide and feedback impact. |
| `aionis_snapshot` | Returns read-only operator/audit state. |
| `aionis_flight_recorder` | Replays what memory the Agent could see at decision time. |
| `aionis_health` | Checks Runtime reachability. |

The primary tool is `aionis_context`. It exposes Aionis's core product surface:
Execution Memory compiled into a route-safe Agent context. The Memory Firewall
tool is for MCP hosts that already have candidates from Mem0, Zep, vector DBs,
markdown, logs, or another recall backend.

## Context Output

`aionis_context` is the MCP version of the SDK product path:

```text
guide -> compileExecutionAgentContext -> agent_prompt + receipt + warnings
```

The tool keeps `agent_prompt` at the top level for drop-in MCP clients, but it
also returns `structuredContent.execution_context` with contract version
`aionis_execution_agent_context_v1`. That compiled context includes:

- active targets and missing active targets
- pending artifacts and blocked/reference-only targets
- memory use receipt
- rehydrate requests
- execution warnings
- final prompt budget metadata

MCP hosts can pass `repo_state` with `existing_files`, `missing_files`, or
per-file `{ target, exists }` entries. Aionis uses that observation to mark
missing active targets as pending work so the accepted route remains actionable.
Hosts can also set `budget_profile`, `max_prompt_chars`,
`include_base_prompt`, and `additional_instructions`.

## Memory Firewall

`aionis_govern_memory` is the backend-agnostic admission path. Use it when the
MCP client already has candidate memories from Mem0, Zep, a vector database, a
markdown knowledge base, or another source, but still wants Aionis to decide
which memories may direct the Agent.

Minimal request:

```json
{
  "query_text": "Continue without reusing failed branches.",
  "mode": "firewall",
  "candidates": [
    {
      "external_memory_id": "mem0:current",
      "source_backend": "mem0",
      "text": "Current accepted target is packages/api/src/checkout.ts.",
      "authority": {
        "source_trust": "trusted",
        "scope": "project",
        "evidence_requirement": "none"
      },
      "lifecycle_hint": "current"
    },
    {
      "external_memory_id": "zep:failed",
      "source_backend": "zep",
      "text": "The old checkout adapter rewrite failed verification.",
      "lifecycle_hint": "failed"
    }
  ]
}
```

The response includes `agent_context`, `memory_use_receipt`,
`memory_firewall`, optional `memory_admission_records`, and
`admission_summary`. External memories remain external; Aionis governs their
admission surface before prompt use.

## Agent Flight Recorder

`aionis_flight_recorder` is the read-only incident replay path. It lets an MCP
host answer what memory the Agent could see when a decision was made, which
memory IDs were exposed or suppressed, and what feedback attribution was known.

The tool accepts the same audit surfaces that Runtime and SDK integrations
already produce: `product_trace`, `agent_context`, `memory_decision_trace`,
`memory_use_receipt`, `memory_admission_record`, `operator_snapshot`, and
`feedback_result`. The report intentionally excludes raw prompt text and raw
memory payloads; it is for audit and debugging, not for mutating memory.

## Drop-In Mode

The MCP bridge is intentionally usable without full feedback wiring.

Minimum loop:

```text
aionis_context -> agent action
```

Better loop:

```text
aionis_context -> agent action -> aionis_record_step
```

Full loop:

```text
aionis_context -> agent action -> aionis_record_step -> aionis_measure -> aionis_snapshot
```

This lets a developer try Aionis in an existing coding agent first, then add
feedback attribution and operator measurement when the integration matures.
