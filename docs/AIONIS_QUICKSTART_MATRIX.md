# Aionis Quickstart Matrix

Status: public entrypoint selection guide for the v0.3.10 development Runtime

Use this matrix to choose the Aionis integration surface for your Agent. Setup
installs and configures the Runtime first; verification loops are optional.

## Start Here

The fastest path is the guided product setup:

```bash
npx aionis setup
```

This prompts for the install directory, provider, and optional AIFS/Zvec/native
adapter setup, writes the generated Runtime `.env`, and prints the start and
integration commands. Verification flows are disabled by default. If you use Claude Code,
Cursor, or another MCP-compatible coding Agent, connect MCP next. If you are
building your own Agent loop, use the SDK or HTTP product API path:

```bash
OPENAI_API_KEY="your-key" npx aionis setup --provider openai --yes
```

If you want the lower-level installer without prompts, use `@aionis/create`
directly. The recommended public entry remains `npx aionis setup`.

If semantic candidate coverage or local recall latency becomes the bottleneck,
enable the optional Zvec sidecar during setup:

```bash
npx aionis setup --with-zvec-ann
```

Zvec only expands candidate retrieval. SQLite remains the fact source, and the
normal Aionis admission/governance path still decides `use_now`,
`inspect_before_use`, `do_not_use`, and `rehydrate`.

| If you are building... | Run this | Transport | Main API path | Result contract |
|---|---|---|---|---|
| Claude Code lifecycle integration | `npx aionis setup --with-claude-code` | Claude Code plugin + hooks + MCP | `SessionStart -> UserPromptSubmit -> agent action -> PostToolUse/PostCompact` | [AIONIS_CLAUDE_CODE_INTEGRATION.md](AIONIS_CLAUDE_CODE_INTEGRATION.md) |
| Cursor, Zed/Zcode, or another MCP client | `npx @aionis/mcp@latest --base-url http://127.0.0.1:3001 --scope-from workspace` | MCP stdio | `aionis_context -> agent action -> aionis_record_step` | MCP tool result JSON |
| A TypeScript or Node Agent | `npm run -s runtime:quickstart:sdk` | SDK facade | `remember -> guide -> feedback -> measure -> snapshot` | `aionis_sdk_quickstart_result_v1` |
| A service that calls Aionis over HTTP | `npm run -s runtime:quickstart:http` | Raw HTTP | `observe -> guide -> feedback -> measure -> snapshot -> rehydrate` | `aionis_http_quickstart_result_v1` |
| A planner/worker/verifier/reviewer system | `npm run -s runtime:quickstart:multi-agent` | SDK + execution memory adapter | `observe -> guide -> feedback -> measure -> snapshot` with shared team memory | `aionis_multi_agent_quickstart_result_v1` |
| A host with Mem0/Zep/vector/markdown memories | `npm run -s runtime:quickstart:memory-firewall` | SDK facade | `governMemory(mode=firewall)` over external candidates | `aionis_memory_firewall_quickstart_result_v1` |
| A host enabling the reviewed admission profile | Configure `AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON` | Runtime env + `/v1/guide` | selected profile only; global mode remains `off` | [AIONIS_ADMISSION_PROFILE_ACTIVATION_QUICKSTART.md](AIONIS_ADMISSION_PROFILE_ACTIVATION_QUICKSTART.md) |
| An operator debugging an Agent decision | `npm run -s runtime:quickstart:flight-recorder` | SDK facade | `flightRecorder` over agent context, receipt, admission record, and feedback | `aionis_flight_recorder_quickstart_result_v1` |

## What Each Verification Flow Proves

| Flow | Proves | Best For | Output |
|---|---|---|---|
| SDK verification | Ordinary preference and project memory become compact Agent context; host-observed actual-use IDs are verified against persisted guide attribution; admission dataset JSONL export is produced; protected measure persists and exactly replays its immutable measurement while snapshot stays read-only. | Single-Agent product integration and SDK users. | [sdk-quickstart-result.json](examples/sdk-quickstart-result.json) |
| Claude Code lifecycle integration | The official plugin installs lifecycle hooks plus MCP so Claude Code receives governed context and records execution evidence automatically. | Claude Code users who want project-scoped execution memory across sessions. | [AIONIS_CLAUDE_CODE_INTEGRATION.md](AIONIS_CLAUDE_CODE_INTEGRATION.md) |
| HTTP verification | The public HTTP product surface works without SDK helpers; raw `guide_trace_id + used_memory_ids` attribution works; `/v1/rehydrate` can restore archived memory. | Backend services, non-TypeScript hosts, curl/API validation. | [http-quickstart-result.json](examples/http-quickstart-result.json) |
| Multi-agent verification | Planner, worker, verifier, and reviewer can share execution memory; reviewer continues the passed branch and avoids the failed branch. | Multi-Agent execution memory, handoff, branch isolation. | [multi-agent-quickstart-result.json](examples/multi-agent-quickstart-result.json) |
| Memory Firewall verification | External memory candidates are routed into `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate`; unsafe direct use stays zero; no external candidates are written into Runtime memory. | Teams keeping Mem0, Zep, vector DBs, markdown notes, or custom stores while adding admission governance. | [memory-firewall-quickstart-result.json](examples/memory-firewall-quickstart-result.json) |
| Flight Recorder verification | Aionis reconstructs direct-use, blocked, and rehydrate memory IDs from read-only artifacts, joins feedback attribution, and excludes prompt payload. | Operator incident replay, support debugging, audit logging. | [flight-recorder-quickstart-result.json](examples/flight-recorder-quickstart-result.json) |

## Product Proof Loops

After one quickstart passes, use these loops to validate deeper product
surfaces.

| Product Proof | Run this | Verifies |
|---|---|---|
| External package smoke | `npm run -s runtime:smoke:external-packages` | Installs published or env-selected `@aionis/sdk`, `@aionis/mcp`, and `@aionis/create` package specs into a temporary external project, then verifies SDK, MCP stdio, and CLI entrypoints against a real Runtime. Embedding-available mode proves the exact persisted model, 1536-d query, and semantic/ANN provenance; unavailable mode proves structured continuity plus context-only feedback rejection. Provider keys are stripped from external package child processes. |
| Published fresh install smoke | `npm run -s runtime:smoke:fresh-install` | Uses `@aionis/create@latest` from npm to install a clean Runtime, verifies no-key startup with `EMBEDDING_PROVIDER=none`, then runs `@aionis/mcp@latest` through `aionis_record_step -> aionis_context`. |
| Published CLI operator smoke | `npm run -s runtime:smoke:published-cli` | Installs the published `aionis` CLI package into a temporary project, starts a real isolated Runtime, then verifies `health`, `boundary`, `doctor`, `snapshot`, Agent Flight Recorder audit, and non-mutating `forget` preview. |
| Zvec ANN scale diagnostic | `npm run -s recall:ann:scale` | Compares bounded SQLite scan, local in-memory ANN, and optional Zvec sidecar on a low-salience semantic needle. Verifies candidate coverage without changing admission/governance semantics. |
| Memory Firewall A/B verification | `npm run -s runtime:e2e:memory-firewall-ab` | Compares raw retrieved external memory against Aionis-governed memory for unsafe direct-use, current/procedure recall, and audit coverage. Produces `aionis_memory_firewall_ab_demo_result_v1`; see [memory-firewall-ab-demo-result.json](examples/memory-firewall-ab-demo-result.json). |
| Flight Recorder incident verification | `npm run -s runtime:e2e:flight-recorder-incident` | Replays healthy attribution, blocked-memory misuse, and missing feedback attribution without exposing prompt text. Produces `aionis_flight_recorder_incident_demo_result_v1`; see [flight-recorder-incident-demo-result.json](examples/flight-recorder-incident-demo-result.json). |
| Admission Dataset Export | `npm run -s runtime:e2e:admission-dataset-export` | Exports multi-run guide/feedback/measure admission rows as appendable JSONL for audit or future learned policy training. Produces `aionis_admission_dataset_export_e2e_result_v1`; see [admission-dataset-export-result.json](examples/admission-dataset-export-result.json). |
| Loop Engineering profile | `npm run -s runtime:e2e:loop-engineering-profile` | Shows Aionis as the memory governance layer around a host-owned plan/action/validate/revise loop. Produces `aionis_loop_engineering_profile_result_v1`; see [loop-engineering-profile-result.json](examples/loop-engineering-profile-result.json). |
| Long-flow product verification | `npm run -s runtime:e2e:long-flow-demo` | Runs a longer cross-session coding Agent flow through observe, guide, compiled Agent Context, feedback, measure, operator snapshot, and Flight Recorder. Produces `aionis_long_flow_product_demo_result_v1`; see [long-flow-product-demo-result.json](examples/long-flow-product-demo-result.json). |
| External Agent case protocol | See [AIONIS_EXTERNAL_AGENT_CASE_RUNBOOK.md](AIONIS_EXTERNAL_AGENT_CASE_RUNBOOK.md) | Defines the isolated Runtime setup, evidence artifacts, pass criteria, and metrics for real external Agent cases. |
| External Claude Code long-flow case | See [AIONIS_EXTERNAL_CLAUDE_CODE_LONGFLOW.md](AIONIS_EXTERNAL_CLAUDE_CODE_LONGFLOW.md) | Runs two separate Claude Code sessions in an isolated sandbox through published Aionis Claude Code hooks. Verifies injected execution context, tool-outcome recording, active-route continuation, and post-run guide recovery. Produces [external-claude-code-longflow-result.json](examples/external-claude-code-longflow-result.json). |
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

## Stable Product Boundary For Public Beta

All quickstarts follow the same contract:

1. The Agent receives SDK `agent_prompt`. Direct HTTP quickstarts may use only
   `agent_context.prompt_text` or selected `agent_context` fields.
2. The host keeps `guide_trace_id`, exposed memory IDs, packets, traces,
   receipts, and snapshots outside the Agent prompt.
3. Feedback is attributed only to memory IDs the host reports as used.
4. Measure does not mutate memory posture, but a protected measure is a durable
   evidence write: it persists the measurement and exact receipt, and can bind
   a verified effect to an episode pair. Operator snapshot remains read-only.
5. Rehydrate expands colder memory or payload only when the host asks for it.
6. Admission dataset export stays in host/operator logs and excludes raw prompt payload.
7. Client `sufficient_evidence` and `evidence_ids` are ignored by the measure
   gate; only Runtime-owned evidence can make learning or skill export-ready.
8. This development Runtime supports one Local Runtime process. Multi-instance HA needs
   shared persistence and cross-instance projection reconciliation.

Focused dataset export guide:
[AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md](AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md).

## Environment

Most verification flows need a real embedding provider unless
`AIONIS_PRODUCT_E2E_BASE_URL`, `AIONIS_BASE_URL`, or `AIONIS_URL` points at an
already-running Runtime.

OpenAI example:

```bash
export EMBEDDING_PROVIDER="openai"
export OPENAI_API_KEY="your-openai-key"
```

DashScope `text-embedding-v4` example:

```bash
export EMBEDDING_PROVIDER="dashscope"
export DASHSCOPE_API_KEY="your-dashscope-key"
export DASHSCOPE_EMBEDDING_MODEL="text-embedding-v4"
```

MiniMax example:

```bash
export EMBEDDING_PROVIDER="minimax"
export MINIMAX_API_KEY="your-minimax-key"
```
