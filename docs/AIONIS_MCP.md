# Aionis MCP

Status: drop-in MCP bridge for coding agents

`@aionis/mcp` exposes Aionis through MCP stdio so Claude Code, Cursor, and other
MCP clients can use governed execution memory without a custom host adapter.

## Why MCP

The fastest way to try Aionis is not a custom SDK integration. It is a local
MCP server that lets an existing coding agent ask Aionis for context before it
continues work.

The bridge keeps Aionis's product boundary intact:

1. MCP tools call `@aionis/sdk`.
2. The SDK calls product APIs such as `/v1/observe`, `/v1/guide`, `/v1/feedback`,
   `/v1/measure`, and `/v1/operator/snapshot`.
3. Runtime core still owns lifecycle, authority, scope, source, execution tree,
   context compilation, and audit.

## Install

Start Runtime:

```bash
cd Aionis
npm run -s lite:start
```

Run MCP over stdio:

```bash
npx @aionis/mcp@latest --base-url http://127.0.0.1:3001 --scope my-project
```

Or configure through env:

```bash
AIONIS_BASE_URL=http://127.0.0.1:3001 \
AIONIS_TENANT_ID=default \
AIONIS_SCOPE=my-project \
npx @aionis/mcp@latest
```

## Claude Code

Add Aionis to the current Claude Code project:

```bash
claude mcp add --transport stdio --scope project aionis -- \
  npx -y @aionis/mcp@latest \
  --base-url http://127.0.0.1:3001 \
  --scope my-project
```

Use local scope for a private machine-only config:

```bash
claude mcp add --transport stdio --scope local aionis -- \
  npx -y @aionis/mcp@latest \
  --base-url http://127.0.0.1:3001 \
  --scope my-project
```

Inspect the server with:

```bash
claude mcp list
claude mcp get aionis
```

Full Claude Code demo:
[AIONIS_CLAUDE_CODE_DEMO.md](AIONIS_CLAUDE_CODE_DEMO.md).

Project config example:
[examples/claude-code-aionis-mcp.project.json](examples/claude-code-aionis-mcp.project.json).

Runtime smoke:

```bash
npm run -s runtime:quickstart:claude-code-mcp
```

## MCP Client Config

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
        "--scope",
        "my-project"
      ],
      "env": {
        "AIONIS_TENANT_ID": "default"
      }
    }
  }
}
```

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
missing active targets as pending work, not as proof that the accepted route is
stale. Hosts can also set `budget_profile`, `max_prompt_chars`,
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
