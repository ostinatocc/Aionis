# Aionis Product Surface Matrix

Updated: 2026-07-09
Scope: Runtime product, SDK/API contracts, and public integration boundaries.

This is the engineering maintenance matrix for Aionis public and semi-public
surfaces. It is intentionally more implementation-oriented than the public docs
page in `aionis-docs/content/api-reference/surface-matrix.mdx`.
For the Agent-facing context contract, see
[AIONIS_AGENT_CONTEXT_CONTRACT.md](AIONIS_AGENT_CONTEXT_CONTRACT.md).

## Rule

Do not create a new Agent-facing context path unless this matrix is updated
first. The primary final Agent context path already exists:

```text
@aionis/sdk guideAgentContext().agent_prompt
@aionis/sdk execution.guideAgentContextForRole().agent_prompt
```

`POST /v1/guide -> agent_context.prompt_text` remains the lower-level Runtime
guide contract. New integrations should use the SDK AgentContext helpers unless
they have a specific reason to manage compilation themselves.

There are three prompt renderings, but only one should be passed to an Agent for
a given run:

| Header | Owner | Use |
|---|---|---|
| `AIONIS_EXECUTION_AGENT_CONTEXT v1` | SDK | Default recommended final Agent prompt. |
| `AIONIS_AGENT_CONTEXT v1` | Runtime | Standard raw HTTP `agent_context.prompt_text`. |
| `AIONIS_CTX v2` | Runtime | Explicit compact Runtime prompt; SDK final prompt only with `prompt_format: "runtime_compact"`. |

Execution-scoped memory that reaches the final Agent prompt must be admitted as
current task execution state: exact `task_signature` evidence or accepted /
passed same-`workflow_signature` continuation evidence promoted by the route
contract. Broad task-family evidence, different-workflow evidence, rejected
branches, failed branches, stale branches, and contested evidence may remain in
`memory_packet` for audit, measurement, and later analysis, but they are not by
themselves direct prompt admission.

## Status Labels

| Status | Meaning |
|---|---|
| `Primary` | Recommended product path. |
| `Stable` | Public and supported, but lower-level than the primary path. |
| `Integration` | Package or plugin that delivers the same Runtime contract to a host. |
| `Operator-only` | Audit, debug, review, lifecycle, or dashboard surface. |
| `Advanced` | Optional deployment, storage, workflow, or power-user surface. |
| `Internal` | Runtime support implementation. Do not expose as product surface. |
| `Do not build` | Explicit non-goal. |

## Core Product Surface

| Capability | Runtime API | SDK / Package Surface | Agent-facing output | Status | Code path | Test / verification |
|---|---|---|---|---|---|---|
| Observe memory and execution evidence | `POST /v1/observe` | `observe()`, `remember()`, `execution.observeStep()` | No | `Primary` | `AionisRuntime-focused/src/routes/product-facade.ts`, `aionis-sdk/src/index.ts` | SDK tests, Runtime product-loop eval |
| Raw guide | `POST /v1/guide` | `guide()`, `execution.guideForRole()` | Lower-level `agent_context.prompt_text` | `Stable` | `AionisRuntime-focused/src/routes/product-facade.ts`, `aionis-sdk/src/index.ts` | SDK guide tests, Runtime guide e2e |
| Final SDK Agent context | `POST /v1/guide`, `POST /v1/memory/resolve` | `guideAgentContext()` | `agent_prompt` | `Primary` | `aionis-sdk/src/index.ts:2074`, `AionisRuntime-focused/src/sdk.ts:2074` | `aionis-sdk/test/sdk.test.ts`, `AionisRuntime-focused/scripts/ci/lite-sdk-guide-agent-context.test.ts` |
| Role-aware final SDK Agent context | `POST /v1/guide`, `POST /v1/memory/resolve` | `execution.guideAgentContextForRole()` | `agent_prompt` | `Primary` | `aionis-sdk/src/index.ts:2389`, `AionisRuntime-focused/src/sdk.ts:2389` | `aionis-sdk/test/sdk.test.ts` |
| Local execution prompt compiler | N/A | `compileExecutionAgentContext()` | `agent_prompt` | `Advanced` | `aionis-sdk/src/index.ts:2991`, `AionisRuntime-focused/src/sdk.ts:2991` | SDK tests |
| Feedback attribution | `POST /v1/feedback` | `feedback()`, `feedbackFromGuide()`, `execution.feedbackFromOutcome()` | No | `Primary` | `AionisRuntime-focused/src/routes/product-facade.ts`, `aionis-sdk/src/index.ts` | SDK tests, feedback governance evals |
| Measure effect | `POST /v1/measure` | `measure()`, `execution.measureRun()` | No | `Primary` | `AionisRuntime-focused/src/routes/product-facade.ts`, `aionis-sdk/src/index.ts` | SDK tests, product-loop eval |
| Trace-derived skill candidates | `POST /v1/measure`, skill review routes | `traceDerivedSkillCandidatesFromMeasure()`, `traceDerivedSkillReviewItemsFromMeasure()` | No | `Stable` | `AionisRuntime-focused/src/memory/skill-candidate-*`, `aionis-sdk/src/index.ts` | SDK trace-to-skill verification |
| External memory firewall | `POST /v1/memory/govern` | `governMemory()`, `governMem0SearchResults()` | `agent_context.prompt_text` | `Stable` | `AionisRuntime-focused/src/routes/product-facade.ts`, `aionis-sdk/src/index.ts` | Memory Firewall evals |
| Rehydrate evidence | `POST /v1/rehydrate` | `rehydrate()` | No direct default | `Stable` | `AionisRuntime-focused/src/routes/product-facade.ts`, `aionis-sdk/src/index.ts` | Runtime and SDK tests |
| Resolve memory | `POST /v1/memory/resolve` | `resolveMemory()` | No direct default | `Stable` | `AionisRuntime-focused/src/routes/memory-access.ts`, `AionisRuntime-focused/src/memory/resolve.ts`, `aionis-sdk/src/index.ts` | SDK guideAgentContext tests |

## Integration Surface

| Integration | Role | Final Agent output | Current code path | Status | Duplication / gap |
|---|---|---|---|---|---|
| `@aionis/sdk` | Primary TypeScript host surface | `guideAgentContext().agent_prompt` | `aionis-sdk/src/index.ts` | `Primary` | None. This is the canonical SDK path. |
| `@aionis/mcp` | MCP tool bridge | `aionis_context.agent_prompt` | `aionis-mcp/src/tools.ts` | `Integration` | Uses `execution.guideAgentContextForRole()` and returns the same SDK AgentContext. |
| `@aionis/aifs` | File surface for file-reading Agents | `.aionis/guide.md` | `aionis-aifs/src/index.ts` | `Integration` | Uses `guideAgentContext()` or `execution.guideAgentContextForRole()` and writes the SDK `agent_prompt`. |
| `aionis-claude-code` | Claude Code lifecycle hooks | injected context | `aionis-claude-code/packages/aionis-claude-code/src/index.ts` | `Integration` | Uses `execution.guideAgentContextForRole()` for injected prompt context. |
| HTTP | Raw Runtime integration | `agent_context.prompt_text` | `AionisRuntime-focused/src/routes/product-facade.ts:3660` | `Stable` | Lower-level by design. |
| CLI `aionis` | Setup and operator commands | None | `aionis-cli/src/index.ts` | `Primary` for setup, `Operator-only` for audit | No final context output. |
| `@aionis/create` | Runtime installer used by CLI | None | `aionis-create/src/index.ts` | `Primary` for install | Supports `--profile full-local` as local option composition. |
| `@aionis/substrate` | Durable evidence sidecar | None as default prompt | `AionisSubstrate/src`, Runtime sidecar provider | `Advanced` | Must not become Runtime replacement or final prompt interface. |
| `@aionis/manifest` | Executable workflow / handoff | Handoff evidence, not generic prompt | `AionisManifest/src` | `Advanced` | Must not become default Agent context renderer. |
| `aionis-dashboard` | Read-only trust window | None | `aionis-dashboard/src` | `Operator-only` | Must remain read-only. |

## Setup Surface

| Command / flag | Current behavior | Status | Gap |
|---|---|---|---|
| `npx aionis setup` | Calls `npm exec --package @aionis/create@latest -- create-aionis .aionis-runtime ...`; clones Runtime, writes `.env`, installs, builds. | `Primary` | Good core path. |
| `--with-zvec-ann` | Writes `RECALL_ANN_PROVIDER=zvec`, `RECALL_ANN_REBUILD_ON_START=true`; installs and verifies `@zvec/zvec@0.5.0`. | `Advanced` | Existing full-local component. |
| `--with-aifs` | Prints AIFS init/doctor/refresh commands. | `Integration` | Does not initialize an Agent workspace by itself. |
| `--with-claude-code` | Runs `@aionis/claude-code` installer and hook setup. | `Integration` | Existing host integration path. |
| MCP setup | Printed as `npx @aionis/mcp@latest ...` in completion docs. | `Integration` | No first-class `--with-mcp` yet. |
| Substrate setup | Manual docs install and env setup. | `Advanced` | No `--with-substrate` or profile integration yet. |
| `--profile full-local` | Enables existing `--with-aifs` and `--with-zvec-ann` behavior. | `Primary local profile` | Does not silently install Claude Code hooks, MCP, or Substrate. |

## Operator Surface

| Surface | Runtime API | SDK / CLI | Agent-facing | Status |
|---|---|---|---|---|
| Snapshot | `GET /v1/operator/snapshot` | `snapshot()`, `operatorSnapshot()`, `aionis snapshot` | No | `Operator-only` |
| Flight Recorder | `POST /v1/audit/flight-recorder` | `flightRecorder()`, `aionis audit flight-recorder` | No | `Operator-only` |
| Decision trace | `POST /v1/debug/memory-decision-trace` | Dashboard/runtime clients | No | `Operator-only` |
| Decision report | `POST /v1/audit/memory-decision-report` | Dashboard/runtime clients | No | `Operator-only` |
| Skill candidates list/review | `/v1/skills/candidates` routes | `aionis skills ...`, SDK helpers | No | `Operator-only` |
| Forget/lifecycle | `POST /v1/forget` | `forget()`, `aionis forget ... --commit` | No | `Operator-only` |
| Health | `GET /health` | `health()`, `aionis health` | No | `Stable` |
| Boundary / doctor | Runtime health/boundary routes | `aionis boundary`, `aionis doctor` | No | `Operator-only` |

## Do Not Expose To Agents

| Surface | Rule |
|---|---|
| `memory_packet` | Keep in host/operator logs. |
| `guide_packet` | Keep in host/operator logs. |
| `memory_decision_trace` | Debug and dashboard only. |
| `memory_decision_audit` | Audit only. |
| `memory_use_receipt` | Host/operator metadata; not the main prompt. |
| `operator_snapshot` | Operator/dashboard only. |
| `flight_recorder` | Audit/replay only. |
| raw slots, raw payloads, raw embeddings | Do not pass wholesale to Agents. Rehydrate selectively. |

## Explicit Non-goals

| Non-goal | Reason |
|---|---|
| Build another SDK final-context method | `guideAgentContext().agent_prompt` and `execution.guideAgentContextForRole().agent_prompt` already exist. |
| Build another final-Agent-context HTTP endpoint | `/v1/guide -> agent_context.prompt_text` is the lower-level HTTP guide contract; SDK adds the recommended top-level `agent_prompt`. |
| Make Substrate the Runtime storage authority | Runtime Lite SQLite remains the fact source and admission authority. |
| Make Dashboard drive Agent behavior | Dashboard is read-only review. |
| Put benchmark runners into Runtime | Eval workspaces validate product behavior; Runtime must stay product-general. |
| Make Manifest the default Agent context renderer | Manifest is workflow/handoff, not the main Agent prompt path. |

## Recommended Next Engineering Work

1. Keep install profile semantics stable:

```bash
npx aionis setup --profile full-local
```

Current mapping:

```text
full-local = core Runtime + embeddings + AIFS setup guidance + Zvec ANN candidate index
```

Substrate remains an advanced manual sidecar. Claude Code hooks still require
`--with-claude-code`.

2. Keep eval adapters out of the product surface:

```text
Terminal-Bench selective evidence adapters are eval-only or deleted. They must
not define "Full Aionis" or become another final Agent context path.
```

3. Keep this matrix updated before changing public API shape, SDK helper names,
or setup profile semantics.
