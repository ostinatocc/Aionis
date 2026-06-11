# Aionis Quickstart Matrix

Status: public entrypoint selection guide for the focused Runtime

Use this matrix to choose the first Aionis product loop to run. Every command
starts or targets a real Runtime and verifies a concrete product contract.

## Start Here

After npm package publishing, the fastest path is:

```bash
MINIMAX_API_KEY="your-key" npx @aionis/create --provider minimax --quickstart sdk
```

| If you are building... | Run this | Transport | Main API path | Result contract |
|---|---|---|---|---|
| A TypeScript or Node Agent | `npm run -s runtime:quickstart:sdk` | SDK facade | `remember -> guide -> feedback -> measure -> snapshot` | `aionis_sdk_quickstart_result_v1` |
| A service that calls Aionis over HTTP | `npm run -s runtime:quickstart:http` | Raw HTTP | `observe -> guide -> feedback -> measure -> snapshot -> rehydrate` | `aionis_http_quickstart_result_v1` |
| A planner/worker/verifier/reviewer system | `npm run -s runtime:quickstart:multi-agent` | SDK + execution memory adapter | `observe -> guide -> feedback -> measure -> snapshot` with shared team memory | `aionis_multi_agent_quickstart_result_v1` |

## What Each Quickstart Proves

| Quickstart | Proves | Best For | Example Output |
|---|---|---|---|
| SDK quickstart | Ordinary preference and project memory become compact Agent context; feedback is attributed to IDs exposed by the guide; measure and snapshot stay read-only. | Single-Agent product integration, SDK users, first local smoke test. | [sdk-quickstart-result.json](examples/sdk-quickstart-result.json) |
| HTTP quickstart | The public HTTP product surface works without SDK helpers; raw `guide_trace_id + used_memory_ids` attribution works; `/v1/rehydrate` can restore archived memory. | Backend services, non-TypeScript hosts, curl/API validation. | [http-quickstart-result.json](examples/http-quickstart-result.json) |
| Multi-agent quickstart | Planner, worker, verifier, and reviewer can share execution memory; reviewer continues the passed branch and avoids the failed branch. | Multi-Agent execution memory, handoff, branch isolation. | [multi-agent-quickstart-result.json](examples/multi-agent-quickstart-result.json) |

## Product Proof Loops

After one quickstart passes, use these loops to validate deeper product
surfaces.

| Product Proof | Run this | Verifies |
|---|---|---|
| Golden product loop | `npm run -s runtime:e2e:golden-product-loop` | End-to-end product path, failed branch isolation, read-only operator snapshot, trace-to-procedure readiness. |
| Judgment calibration loop | `npm run -s runtime:e2e:judgment-calibration` | Supported memory, unused recalled memory, and judgment calibration stay separated and read-only. |
| Ordinary memory loop | `npm run -s runtime:e2e:ordinary-memory` | Preference, fact, stale, suppressed, private visibility, and non-execution-memory behavior. |

## Choosing The Right Interface

| Interface | Use When | Avoid When |
|---|---|---|
| SDK facade | Your host can import TypeScript/JavaScript helpers and wants fewer handwritten payloads. | You need to prove raw HTTP behavior or integrate from another language. |
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

## Environment

All quickstarts need a real embedding provider unless `AIONIS_PRODUCT_E2E_BASE_URL`,
`AIONIS_BASE_URL`, or `AIONIS_URL` points at an already-running Runtime.

MiniMax example:

```bash
export EMBEDDING_PROVIDER="minimax"
export MINIMAX_API_KEY="your-minimax-key"
```
