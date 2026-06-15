# Aionis Claude Code MCP Demo

Status: external coding-agent demo over Claude Code MCP stdio

This demo wires Aionis into Claude Code without a custom Claude Code adapter.
Claude Code talks to `@aionis/mcp`; the MCP bridge calls the same Runtime and
SDK product APIs used by normal host integrations.

For a screen-recording script, talk track, and proof checklist, use the demo
pack: [AIONIS_CLAUDE_CODE_MCP_DEMO_PACK.md](AIONIS_CLAUDE_CODE_MCP_DEMO_PACK.md).

Use it to prove this loop:

```text
Claude Code -> MCP tool -> Aionis Runtime -> governed Agent context -> Claude Code
```

## What This Demo Proves

The demo covers Aionis's product path for an external coding agent:

1. Claude Code can reach Aionis through MCP stdio.
2. Aionis can record a failed branch and an accepted branch.
3. `aionis_context` compiles a compact execution-memory prompt with receipt and
   admission records.
4. Failed history is surfaced as guard memory, not direct implementation
   instruction.
5. `aionis_flight_recorder` can replay what memory the Agent could see without
   including raw prompt text or mutating Runtime state.

## Prerequisites

- Node.js `>=22.5.0` with built-in `node:sqlite`
- Claude Code CLI
- Aionis Runtime running locally or reachable through `AIONIS_BASE_URL`
- An embedding provider for local Runtime startup

For local Runtime:

```bash
npm install

export EMBEDDING_PROVIDER="minimax"
export MINIMAX_API_KEY="your-minimax-key"

npm run -s lite:start
```

## Add Aionis To Claude Code

In the project where you run Claude Code:

```bash
claude mcp add --transport stdio --scope project aionis -- \
  npx -y @aionis/mcp@latest \
  --base-url http://127.0.0.1:3001 \
  --scope my-project
```

Use `--scope local` instead of `--scope project` when the config should stay on
your machine only.

To inspect the configured server:

```bash
claude mcp list
claude mcp get aionis
```

Inside Claude Code, run:

```text
/mcp
```

Claude Code should show the `aionis` MCP server and the Aionis tools.

## Project Config Example

You can also copy this example into a project `.mcp.json`:

[examples/claude-code-aionis-mcp.project.json](examples/claude-code-aionis-mcp.project.json)

The example uses Claude Code's environment expansion syntax so a team can keep
the same config while each developer sets local values:

```bash
export AIONIS_BASE_URL="http://127.0.0.1:3001"
export AIONIS_SCOPE="checkout-migration"
```

## Run The Runtime Smoke

This command does not automate the Claude Code UI. It verifies the same MCP tool
handler that Claude Code calls:

```bash
npm run -s runtime:quickstart:claude-code-mcp
```

Expected result contract:

[examples/claude-code-mcp-demo-result.json](examples/claude-code-mcp-demo-result.json)

Real Claude Code transcript:

[examples/claude-code-real-demo-transcript.md](examples/claude-code-real-demo-transcript.md)

The smoke starts or targets a real Runtime and calls:

```text
aionis_health
-> aionis_record_step
-> aionis_record_step
-> aionis_context
-> aionis_flight_recorder
```

## Claude Code Prompt

After the MCP server is configured, paste this prompt into Claude Code:

[examples/claude-code-aionis-demo-prompt.md](examples/claude-code-aionis-demo-prompt.md)

The prompt asks Claude Code to call Aionis tools first, then summarize the
execution-memory contract it received.

## What To Look For

In the `aionis_context` result:

- `agent_prompt` contains `AIONIS_EXECUTION_AGENT_CONTEXT`.
- `memory_use_receipt.use_now_memory_ids` or `should_continue_memory_ids`
  contains the accepted route.
- `inspect_before_use_memory_ids`, `must_not_memory_ids`, or
  `inspect_first_memory_ids` contains guarded history.
- `memory_use_receipt.contract_version` is `aionis_memory_use_receipt_v1`.
- `memory_admission_record.contract_version` is
  `aionis_memory_admission_record_v1`.
- `feedback_required` is `false`, so the demo works in drop-in mode.

In the `aionis_flight_recorder` result:

- `agent_prompt_included` is `false`.
- `runtime_mutation` is `false`.
- replay sources include agent context, memory use receipt, admission record,
  and feedback result.

## Production Loop

The drop-in loop is:

```text
aionis_context -> Claude Code action
```

The product loop is:

```text
aionis_context
-> Claude Code action
-> aionis_record_step
-> aionis_measure
-> aionis_snapshot
```

Add `aionis_flight_recorder` when an operator needs to replay a decision after
an incident.

## Troubleshooting

If Claude Code connects to MCP and `aionis_record_step` works, but
`aionis_context` returns `400 /v1/guide`, check the Runtime embedding provider.
The guide/context path needs recall and planning context; local Runtime startup
should include an embedding provider:

```bash
export EMBEDDING_PROVIDER="minimax"
export MINIMAX_API_KEY="your-minimax-key"
npm run -s lite:start
```

Candidate-only governance can still work without embeddings, but the full
execution-context path should be run with embeddings configured.

## Boundary

Aionis does not replace Claude Code's reasoning loop. It gives Claude Code an
external execution-memory contract: what to continue, what to inspect first,
what not to use, and what to rehydrate on demand.

Raw traces, receipts, admission records, and flight-recorder reports stay host
or operator data. Claude Code receives the compiled Agent context.
