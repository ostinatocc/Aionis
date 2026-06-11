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
| `aionis_context` | Compiles governed context for the current run. Can also record a lightweight observation first. |
| `aionis_record_step` | Records execution state and optionally attributes feedback if memory IDs are supplied. |
| `aionis_handoff` | Records planner/worker/verifier/reviewer handoff state. |
| `aionis_remember` | Stores ordinary memory through the governed observe path. |
| `aionis_measure` | Measures guide and feedback impact. |
| `aionis_snapshot` | Returns read-only operator/audit state. |
| `aionis_health` | Checks Runtime reachability. |

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
