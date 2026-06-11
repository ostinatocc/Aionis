# @aionis/mcp

MCP stdio bridge for Aionis execution memory.

Use this package when you want Claude Code, Cursor, or another MCP client to
try Aionis without rewriting the host Agent loop first.

```bash
npx @aionis/mcp@latest --base-url http://127.0.0.1:3001 --scope my-project
```

Environment form:

```bash
AIONIS_BASE_URL=http://127.0.0.1:3001 \
AIONIS_TENANT_ID=default \
AIONIS_SCOPE=my-project \
npx @aionis/mcp@latest
```

## Tools

The server exposes stable product tools, not internal Runtime packets:

| Tool | Purpose |
|---|---|
| `aionis_context` | Compile governed Agent context for the current run. Optionally records a lightweight observation first. |
| `aionis_record_step` | Record a planner/worker/verifier/reviewer step. Feedback attribution is optional. |
| `aionis_handoff` | Record branch-aware multi-agent handoff state. |
| `aionis_remember` | Store ordinary project memory through the governed observe path. |
| `aionis_measure` | Measure whether guided memory changed the run. |
| `aionis_snapshot` | Return read-only operator/audit state. |
| `aionis_health` | Check Runtime reachability. |

## Claude Code / Cursor Config

Use the MCP client's command/args configuration:

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

Start a local Runtime first:

```bash
cd Aionis
npm run -s lite:start
```

For deeper host integration, use `@aionis/sdk`. The MCP bridge is the
drop-in path; the SDK is the full application integration path.
