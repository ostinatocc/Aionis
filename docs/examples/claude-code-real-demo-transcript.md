# Claude Code Real MCP Demo Transcript

Status: real Claude Code MCP run, summarized from local stream JSONL

Date: 2026-06-14

This transcript captures a live Claude Code run using the published MCP bridge
and a local Aionis Runtime. It is intentionally a curated operator summary, not
the raw stream dump.

## Environment

- Claude Code: `2.1.107`
- Runtime: focused local Runtime over Lite SQLite
- Runtime URL: `http://127.0.0.1:34118`
- Embedding provider: `EMBEDDING_PROVIDER=minimax`
- MCP package: `@aionis/mcp@latest` -> `0.1.10`
- SDK package: `@aionis/sdk@latest` -> `0.1.10`
- Scope: `claude-code-real-demo-pass`
- Raw local stream: `/tmp/aionis-claude-code-real-demo-pass2.stream.jsonl`

## Commands

Runtime:

```bash
PORT=34118 \
EMBEDDING_PROVIDER=minimax \
npm run -s lite:start
```

Claude Code:

```bash
AIONIS_BASE_URL=http://127.0.0.1:34118 \
AIONIS_SCOPE=claude-code-real-demo-pass \
AIONIS_TENANT_ID=default \
claude --print --verbose --output-format stream-json \
  --mcp-config docs/examples/claude-code-aionis-mcp.project.json \
  --strict-mcp-config \
  --permission-mode bypassPermissions \
  --allowedTools mcp__aionis__aionis_health,mcp__aionis__aionis_record_step,mcp__aionis__aionis_context,mcp__aionis__aionis_flight_recorder \
  --max-budget-usd 1 \
  "<demo prompt>"
```

The prompt matched the flow in
[claude-code-aionis-demo-prompt.md](claude-code-aionis-demo-prompt.md): check
health, record a failed branch, record an accepted branch, then request Aionis
context.

## Tool Sequence

1. `aionis_health`: passed.
2. `aionis_record_step`: recorded failed legacy route.
   - memory id: `2afb59e4-44a4-5f67-a872-6a47af86a8b9`
   - target: `src/legacy/checkout.ts`
   - outcome: `failed`
3. `aionis_record_step`: recorded accepted route.
   - memory id: `cd7060e5-67d8-5e65-b6a0-7a6f788d087c`
   - target: `packages/api/src/checkout.ts`
   - outcome: `succeeded`
4. `aionis_context`: passed.

Claude Code result metadata:

- session id: `b873a4b3-876c-45ea-9456-b403cfc63be9`
- model: `deepseek-v4-pro`
- total cost: `$0.372263`
- duration: `41357ms`

## Context Contract Evidence

`aionis_context` returned `AIONIS_EXECUTION_AGENT_CONTEXT v1` with:

- `memory_use_receipt.contract_version`:
  `aionis_memory_use_receipt_v1`
- `memory_admission_record.contract_version`:
  `aionis_memory_admission_record_v1`
- `feedback_required`: `false`
- `history_used`: `true`
- `actionable_history_used`: `true`
- `use_now_memory_ids`:
  `["cd7060e5-67d8-5e65-b6a0-7a6f788d087c"]`
- `inspect_before_use_memory_ids`:
  `["2afb59e4-44a4-5f67-a872-6a47af86a8b9"]`
- `do_not_use_memory_ids`: `[]`
- `reference_only_targets`: `["src/legacy/checkout.ts"]`
- execution warning: `reference_only_target_present`
- risk flag: `lifecycle_candidate_kept_out_of_use_now`

Admission details:

| Memory | Admission action | Prompt effect |
| --- | --- | --- |
| `cd7060e5-67d8-5e65-b6a0-7a6f788d087c` | `use_now` | Continue accepted route |
| `2afb59e4-44a4-5f67-a872-6a47af86a8b9` | `inspect_before_use` | Reference only, not direct instruction |

## What This Proves

- Published `@aionis/mcp` can connect to Claude Code over stdio.
- Claude Code can write execution observations through Aionis MCP tools.
- The Runtime can compile a governed execution-memory context back to Claude
  Code.
- Accepted route memory enters `use_now`.
- Failed legacy route memory is kept out of direct use and surfaced as
  inspect/reference memory.
- The drop-in path works without requiring host feedback wiring on the first
  integration pass.

## Setup Guardrail Learned

A previous run connected MCP and recorded steps, but `aionis_context` failed
with `400 /v1/guide` because the Runtime was started without a configured
embedding provider. Current Runtime builds a no-key agent context by omitting
semantic planning recall when `EMBEDDING_PROVIDER=none`; configure an embedding
provider when the demo needs semantic recall over stored memory.

For local demos with semantic recall, start the Runtime with:

```bash
export EMBEDDING_PROVIDER=minimax
export MINIMAX_API_KEY="your-minimax-key"
npm run -s lite:start
```

## Boundary

This transcript did not call `aionis_flight_recorder`; the scripted product
smoke covers that tool in
[claude-code-mcp-demo-result.json](claude-code-mcp-demo-result.json). This run
was kept focused on the external Claude Code context path.
