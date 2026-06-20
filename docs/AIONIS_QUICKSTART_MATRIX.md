# Aionis Quickstart Matrix

Status: public entrypoint selection guide for the focused Runtime

Use this matrix to choose the first Aionis product loop to run. Every command
starts or targets a real Runtime and verifies a concrete product contract.

## Start Here

The fastest path is the published installer:

```bash
npx @aionis/create@latest
```

This runs the no-key first-value demo. If you use Claude Code, Cursor, or
another MCP-compatible coding Agent, connect MCP next. Use the SDK quickstart
after you are ready to wire Aionis into your own application loop:

```bash
OPENAI_API_KEY="your-key" npx @aionis/create@latest --provider openai --quickstart sdk
```

| If you are building... | Run this | Transport | Main API path | Result contract |
|---|---|---|---|---|
| You want the fastest first proof | `npm run -s runtime:demo:first-value` | SDK facade over local API | `governMemory(mode=firewall)` over dirty external candidates | `aionis_first_value_demo_result_v1` |
| Claude Code external demo | `npm run -s runtime:quickstart:claude-code-mcp` | MCP stdio + SDK facade | `aionis_health -> aionis_record_step -> aionis_context -> aionis_flight_recorder` | `aionis_claude_code_mcp_demo_result_v1` |
| Cursor, Zed/Zcode, or another MCP client | `npx @aionis/mcp@latest --base-url http://127.0.0.1:3001 --scope-from workspace` | MCP stdio | `aionis_context -> agent action -> aionis_record_step` | MCP tool result JSON |
| A TypeScript or Node Agent | `npm run -s runtime:quickstart:sdk` | SDK facade | `remember -> guide -> feedback -> measure -> snapshot` | `aionis_sdk_quickstart_result_v1` |
| A service that calls Aionis over HTTP | `npm run -s runtime:quickstart:http` | Raw HTTP | `observe -> guide -> feedback -> measure -> snapshot -> rehydrate` | `aionis_http_quickstart_result_v1` |
| A planner/worker/verifier/reviewer system | `npm run -s runtime:quickstart:multi-agent` | SDK + execution memory adapter | `observe -> guide -> feedback -> measure -> snapshot` with shared team memory | `aionis_multi_agent_quickstart_result_v1` |
| A host with Mem0/Zep/vector/markdown memories | `npm run -s runtime:quickstart:memory-firewall` | SDK facade | `governMemory(mode=firewall)` over external candidates | `aionis_memory_firewall_quickstart_result_v1` |
| An operator debugging an Agent decision | `npm run -s runtime:quickstart:flight-recorder` | SDK facade | `flightRecorder` over agent context, receipt, admission record, and feedback | `aionis_flight_recorder_quickstart_result_v1` |

## What Each Quickstart Proves

| Quickstart | Proves | Best For | Example Output |
|---|---|---|---|
| First-value demo | Raw retrieval would direct-use failed/stale history; Aionis admits current memory, blocks unsafe memory, keeps rehydrate pointer-only, and emits a receipt. | First local aha, no embedding key, no LLM, no Agent harness. | [first-value-demo-result.json](examples/first-value-demo-result.json) |
| SDK quickstart | Ordinary preference and project memory become compact Agent context; feedback is attributed to IDs exposed by the guide; admission dataset JSONL export is produced; measure and snapshot stay read-only. | Single-Agent product integration, SDK users, first local smoke test. | [sdk-quickstart-result.json](examples/sdk-quickstart-result.json) |
| Claude Code MCP demo | Claude Code's MCP tool path can record failed and accepted branches, compile execution context, and replay the decision through Agent Flight Recorder. | Claude Code users, external coding-agent demos, MCP-first trials. | [claude-code-mcp-demo-result.json](examples/claude-code-mcp-demo-result.json) |
| HTTP quickstart | The public HTTP product surface works without SDK helpers; raw `guide_trace_id + used_memory_ids` attribution works; `/v1/rehydrate` can restore archived memory. | Backend services, non-TypeScript hosts, curl/API validation. | [http-quickstart-result.json](examples/http-quickstart-result.json) |
| Multi-agent quickstart | Planner, worker, verifier, and reviewer can share execution memory; reviewer continues the passed branch and avoids the failed branch. | Multi-Agent execution memory, handoff, branch isolation. | [multi-agent-quickstart-result.json](examples/multi-agent-quickstart-result.json) |
| Memory Firewall quickstart | External memory candidates are routed into `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`; unsafe direct use stays zero; no external candidates are written into Runtime memory. | Teams keeping Mem0, Zep, vector DBs, markdown notes, or custom stores while adding admission governance. | [memory-firewall-quickstart-result.json](examples/memory-firewall-quickstart-result.json) |
| Flight Recorder quickstart | Aionis reconstructs direct-use, blocked, and rehydrate memory IDs from read-only artifacts, joins feedback attribution, and excludes prompt payload. | Operator incident replay, support debugging, audit logging. | [flight-recorder-quickstart-result.json](examples/flight-recorder-quickstart-result.json) |

## Product Proof Loops

After one quickstart passes, use these loops to validate deeper product
surfaces.

| Product Proof | Run this | Verifies |
|---|---|---|
| First-value demo | `npm run -s runtime:demo:first-value` | Demonstrates memory admission and audit without an embedding key or LLM. Produces `aionis_first_value_demo_result_v1`; see [first-value-demo-result.json](examples/first-value-demo-result.json). |
| External package smoke | `npm run -s runtime:smoke:external-packages` | Packs `@aionis/sdk`, `@aionis/mcp`, and `@aionis/create`, installs them into a temporary external project, then verifies SDK, MCP stdio, and CLI entrypoints against a real Runtime. |
| Memory Firewall A/B demo | `npm run -s runtime:e2e:memory-firewall-ab` | Compares raw retrieved external memory against Aionis-governed memory for unsafe direct-use, current/procedure recall, and audit coverage. Produces `aionis_memory_firewall_ab_demo_result_v1`; see [memory-firewall-ab-demo-result.json](examples/memory-firewall-ab-demo-result.json). |
| Flight Recorder incident demo | `npm run -s runtime:e2e:flight-recorder-incident` | Replays healthy attribution, blocked-memory misuse, and missing feedback attribution without exposing prompt text. Produces `aionis_flight_recorder_incident_demo_result_v1`; see [flight-recorder-incident-demo-result.json](examples/flight-recorder-incident-demo-result.json). |
| Admission Dataset Export | `npm run -s runtime:e2e:admission-dataset-export` | Exports multi-run guide/feedback/measure admission rows as appendable JSONL for audit or future learned policy training. Produces `aionis_admission_dataset_export_e2e_result_v1`; see [admission-dataset-export-result.json](examples/admission-dataset-export-result.json). |
| Loop Engineering profile | `npm run -s runtime:e2e:loop-engineering-profile` | Shows Aionis as the memory governance layer around a host-owned plan/action/validate/revise loop. Produces `aionis_loop_engineering_profile_result_v1`; see [loop-engineering-profile-result.json](examples/loop-engineering-profile-result.json). |
| Golden product loop | `npm run -s runtime:e2e:golden-product-loop` | End-to-end product path, failed branch isolation, read-only operator snapshot, trace-to-procedure readiness. |
| Judgment calibration loop | `npm run -s runtime:e2e:judgment-calibration` | Supported memory, unused recalled memory, and judgment calibration stay separated and read-only. |
| Ordinary memory loop | `npm run -s runtime:e2e:ordinary-memory` | Preference, fact, stale, suppressed, private visibility, and non-execution-memory behavior. |

## Choosing The Right Interface

| Interface | Use When | Avoid When |
|---|---|---|
| SDK facade | Your host can import TypeScript/JavaScript helpers and wants fewer handwritten payloads. | You need to prove raw HTTP behavior or integrate from another language. |
| MCP bridge | You want to try Aionis in Claude Code, Cursor, or another MCP client before writing a host adapter. | You need a deeply customized production feedback and measurement loop. |
| Raw HTTP | You want the smallest language-neutral contract and explicit request bodies. | You prefer helper functions for feedback attribution, measure input, and snapshot input. |
| Execution memory adapter | You run multi-agent or long-horizon workflows and need role, team, branch, and handoff state carried consistently. | You only need ordinary preference/fact memory for one Agent. |

## Stable Product Boundary

All quickstarts follow the same boundary:

1. The Agent receives `agent_context.prompt_text` or selected `agent_context`
   fields.
2. The host keeps `guide_trace_id`, exposed memory IDs, packets, traces,
   receipts, and snapshots outside the Agent prompt.
3. Feedback is attributed only to memory IDs the host reports as used.
4. Measure and operator snapshot are read-only product surfaces.
5. Rehydrate expands colder memory or payload only when the host asks for it.
6. Admission dataset export stays in host/operator logs and excludes raw prompt payload.

Focused dataset export guide:
[AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md](AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md).

## Environment

Most quickstarts need a real embedding provider unless
`AIONIS_PRODUCT_E2E_BASE_URL`, `AIONIS_BASE_URL`, or `AIONIS_URL` points at an
already-running Runtime. The first-value demo is the exception: it uses external
memory admission only and can run with `EMBEDDING_PROVIDER=none`.

OpenAI example:

```bash
export EMBEDDING_PROVIDER="openai"
export OPENAI_API_KEY="your-openai-key"
```

MiniMax example:

```bash
export EMBEDDING_PROVIDER="minimax"
export MINIMAX_API_KEY="your-minimax-key"
```
