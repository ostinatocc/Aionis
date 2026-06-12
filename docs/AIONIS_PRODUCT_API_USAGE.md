# Aionis Product API Usage

Status: product API usage guide for the focused Runtime

This document explains how a host should use the product actions:
`observe`, `guide`, `feedback`, `measure`, `rehydrate`, and `snapshot`.

It is not a new mechanism proposal. It does not define an Agent framework,
benchmark runner, repair system, or host-specific adapter. It describes the
stable product path over the current Runtime implementation.

For host template wiring and runnable single-agent, multi-agent, and coding
Agent examples, see [AIONIS_HOST_INTEGRATION.md](AIONIS_HOST_INTEGRATION.md).
For curl-first HTTP integration, see
[AIONIS_HTTP_QUICKSTART.md](AIONIS_HTTP_QUICKSTART.md).
For explicit suppress/unsuppress lifecycle control, see
[AIONIS_CONTROLLED_FORGETTING_QUICKSTART.md](AIONIS_CONTROLLED_FORGETTING_QUICKSTART.md).
For the smallest SDK loop, see
[AIONIS_SDK_QUICKSTART.md](AIONIS_SDK_QUICKSTART.md).
For choosing SDK, raw HTTP, or multi-agent first-run commands, see
[AIONIS_QUICKSTART_MATRIX.md](AIONIS_QUICKSTART_MATRIX.md).
For one-command Runtime plus SDK installation, see
[AIONIS_INSTALL.md](AIONIS_INSTALL.md).

## Route Summary

| Route | Product Action | Caller | Primary Consumer | Main Output |
|---|---|---|---|---|
| `POST /v1/observe` | `observe` | Host after real work or memory input | Runtime write path | `observed`, `structured_memory` |
| `POST /v1/guide` | `guide` | Host before the next Agent run | Agent prompt builder | `agent_context` |
| `POST /v1/feedback` | `feedback` | Host after the Agent acts | Feedback attribution | `forget_effect` with `operation: "activate"` |
| `POST /v1/rehydrate` | `rehydrate` | Host when compact context needs original evidence or payload | Payload / archive lifecycle controller | `forget_effect` with `operation: "rehydrate"` |
| `POST /v1/measure` | `measure` | Host, operator, or product evaluator | Product diagnostics | `effect_report`, optional decision trace and audit |
| `POST /v1/forget` | controlled forgetting | Host, operator, or product policy | Explicit lifecycle controller | `forget_effect` |

Optional read-only operator route:

| Route | Product Role | Caller | Primary Consumer | Main Output |
|---|---|---|---|---|
| `POST /v1/operator/snapshot` | inspect | Host or operator after guide/feedback/measure | Operator / host observability | `operator_snapshot`, optional markdown |

The Agent should consume only `agent_context.prompt_text` or selected
`agent_context` fields. Full packets, decision traces, audit reports, raw rows,
and raw slots are operator surfaces, not Agent prompt surfaces.

For host decisions, distinguish these two fields:

| Field | Meaning | Product Use |
|---|---|---|
| `history_used` | The Aionis history/context channel participated in guide assembly. | Observability of the context channel. |
| `actionable_history_used` | The Agent received memory-backed guidance, rehydration hints, or execution branches that can affect the next action. | Whether Aionis actually supplied actionable memory. |

## Integration Flow

1. Call `POST /v1/observe` after real work, a user preference, a project fact,
   an execution trace, or a handoff should become memory.
2. Call `POST /v1/guide` before the next Agent run.
3. Pass only `agent_context.prompt_text` or selected `agent_context` fields to
   the Agent.
4. Call SDK `feedback()` or raw `POST /v1/feedback` after the Agent acts.
   Include `guide_trace_id`, `used_memory_ids`, `run_id`, `outcome`, and
   `used_surface`.
5. Call SDK `rehydrate()` or raw `POST /v1/rehydrate` when an archived memory
   or anchor payload needs to be expanded.
6. Call `POST /v1/measure` with before/after guide packets or direct
   observations when the product needs to prove whether history helped or hurt.
7. Call `POST /v1/operator/snapshot` when a host or operator needs a read-only
   summary of actionable history, feedback attribution, branch isolation, and
   measured effect.

## SDK Product Path

The focused Runtime also exposes a small TypeScript client for the product
actions. The SDK is intentionally a facade over the product routes; it does not
wrap debug, audit, benchmark, or host-specific adapter APIs. `feedback()` posts
to `/v1/feedback`, `rehydrate()` posts to `/v1/rehydrate`, and `snapshot()` is a
short alias for `/v1/operator/snapshot`. The lower-level `/v1/forget` route
remains available for explicit suppress/unsuppress lifecycle control.

```ts
import {
  agentPromptFromGuide,
  createAionisClient,
  feedbackFromGuide,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop,
} from "@aionis/sdk";

const aionis = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  apiKey: process.env.AIONIS_API_KEY,
  tenant_id: "default",
  scope: "payments-service",
  // SDK guide() defaults to the full-power product path. Set
  // default_guide_mode: "standard" only for legacy integrations.
});

await aionis.remember({
  kind: "preference",
  text: "Prefer concise status updates with concrete evidence references.",
  owner_agent_id: "agent-1",
  memory_lane: "private",
});

await aionis.observe({
  auto_embed: true,
  execution: {
    run_id: "run-001",
    task_signature: "checkout-continuation",
    title: "Recovered current checkout workflow",
    summary: "Current checkout work belongs in src/payments/checkout.ts.",
    outcome: "succeeded",
    target_files: ["src/payments/checkout.ts"],
    evidence: [{ ref: "run-001#verifier", summary: "Focused verifier passed." }],
  },
});

const guide = await aionis.guide<{
  guide_trace_id: string;
  agent_context: {
    prompt_text: string;
    use_now_memory_ids: string[];
  };
}>({
  query_text: "Continue checkout migration without repeating stale discovery.",
  consumer_agent_id: "agent-1",
  limit: 8,
});

const agentPromptContext = agentPromptFromGuide(guide);

const feedback = await aionis.feedback(feedbackFromGuide({
  guide,
  reason: "Agent used the exposed checkout continuation successfully.",
  run_id: "run-001",
  outcome: "positive",
  used_memory_ids: guide.agent_context.use_now_memory_ids.slice(0, 1),
  verifier_status: "passed",
  tool_status: "succeeded",
}));

const measure = await aionis.measure(measureInputFromGuideLoop({
  task: {
    task_id: "task-001",
    run_id: "run-001",
    task_signature: "checkout-continuation",
    task_family: "developer_sdk",
  },
  after_guide: guide,
  feedback_result: feedback,
  sufficient_evidence: true,
  evidence_ids: ["verifier:run-001"],
}));

await aionis.snapshot(snapshotInputFromGuideLoop({
  run_id: "run-001",
  task_signature: "checkout-continuation",
  task_family: "developer_sdk",
  guide,
  measure_result: measure,
  include_markdown: true,
}));

await aionis.rehydrate({
  reason: "Expand the archived checkout trace before exact replay.",
  anchor_uri: "aionis://anchors/checkout-trace",
  mode: "partial",
});
```

The Agent should receive `agentPromptContext` or selected `agent_context`
fields. It should not receive `memory_packet`, `guide_packet`,
`memory_decision_trace`, `memory_decision_audit`, or raw rows by default.
`feedbackFromGuide()` validates attribution against the guide exposure ledger,
while `measureInputFromGuideLoop()` and `snapshotInputFromGuideLoop()` hide the
internal `product_trace` and operator snapshot wiring from normal app code.

Runnable SDK e2e:

```bash
npm run -s runtime:quickstart:sdk
npm run -s runtime:quickstart:http
npm run -s runtime:e2e:product-loop
npm run -s runtime:e2e:ordinary-memory
npm run -s runtime:e2e:golden-product-loop
npm run -s runtime:e2e:agent-suite
```

By default the e2e starts an isolated local Runtime and therefore needs a real
embedding provider in the environment. To run against an already-started
Runtime, set:

```bash
export AIONIS_PRODUCT_E2E_BASE_URL="http://127.0.0.1:3001"
npm run -s runtime:e2e:product-loop
```

The product-loop e2e exercises `observe -> guide -> simulated Agent -> observe
outcome -> rehydrate -> measure`, and also verifies that the advanced
`/v1/execution/context/assemble` and product `/v1/guide mode=full_power`
`agent_context` keep passed branches, failed branches, and audit surfaces
separated.

The ordinary-memory e2e exercises the general cognitive memory path:
`observe ordinary memory -> guide -> trace/receipt -> feedback -> measure ->
snapshot`. It checks that active preferences and corrected facts can be used,
stale or contradicted facts stay inspect-first, and receipt decision summaries
make the use/suppress reason visible without becoming prompt content. Its
holdout coverage includes active project notes, candidate memory,
suppressed memory, private visibility boundaries, and a negative control that
ordinary memory writes do not produce execution-tree state.

The golden product loop exercises the full product path:

```text
observe -> guide -> agent action -> outcome feedback -> measure -> snapshot
```

It is the preferred product proof when validating that Aionis changes the next
Agent context, isolates failed branches, and gives operators a read-only memory
use receipt plus trace-to-procedure readiness.

The agent-suite e2e is the real LLM downstream demo. It compares `baseline`,
`long_context`, and `aionis` groups, then fails if Aionis does not recover the
verified active path, suppress failed branch direct use, provide evidence-backed
feedback, and keep execution context shorter than raw long history. This
validates Agent-context behavior; it is not an external task-success benchmark.

## Multi-Agent Execution Memory

Aionis can be used as a Multi-Agent execution memory backend. The host still
owns orchestration. Aionis owns memory visibility, branch-aware context,
feedback attribution, and measurement.

Use these identity rules:

1. Set `producer_agent_id` when an Agent writes `observe`.
2. Use `memory_lane: "shared"` without `owner_team_id` only for scope-wide
   shared memory.
3. Use `memory_lane: "shared"` plus `owner_team_id` when planner, worker,
   verifier, and reviewer should share execution memory inside one team.
4. Use `consumer_agent_id` and `consumer_team_id` on `guide`.
5. Use `memory_lane: "private"` with `owner_agent_id` when only the same Agent
   should retrieve the memory later. Use `memory_lane: "private"` with
   `owner_team_id` only for team-private memory that should stay invisible
   outside that team.
6. Put role hints such as `planner`, `worker`, `verifier`, or `reviewer` in
   top-level `agent_role` on `/v1/guide`. Legacy `context.agent_role` is still
   accepted as a compatibility fallback.
7. After the Agent acts, call SDK `feedback()` or raw `POST /v1/feedback` with
   `actor`, `guide_trace_id`, `used_memory_ids`, `run_id`, `outcome`, and
   `used_surface` so feedback is attributed only to memory actually used.
   For `guide_trace_id` feedback, Aionis inherits the guide ledger's
   `consumer_team_id` when activating team-owned shared memory.

### Recommended Host Adapter

Agent hosts should prefer the execution memory adapter over hand-writing the
whole loop. It keeps the product defaults consistent: `guideNext` uses
full-power guide mode, role and team identity are carried on every call, the
latest execution tree is reused for reviewer context, and `observeOutcome`
can attribute feedback through the last `guide_trace_id`.

Adapter contract version: `aionis_execution_memory_adapter_v1`.

| Surface | Host Required | Advanced Optional |
|---|---|---|
| `createExecutionMemoryAdapter` | `client`; for shared multi-agent memory, `team_id` or per-call `team_id` | `tenant_id`, `scope`, `default_agent_id`, `default_agent_role`, `default_memory_lane`, `default_limit` |
| `observeRunStart` / `observeStep` | `run_id`, `task_signature`, `agent_id` or `default_agent_id`, `title`, `summary` | `task_family`, `workflow_signature`, `target_files`, `workflow_steps`, `raw_ref`, `evidence_ref`, `slots`, `handoff.execution_tree_v1`, `handoff.execution_tree_operations_v1` |
| `guideNext` | `run_id`, `task_signature`, `agent_id` or `default_agent_id`, `query_text` | `context`, `execution_tree_v1`, `tool_candidates`, `limit`, `include_packets`, `mode` |
| `observeOutcome` | same as `observeStep`; `used_memory_ids` when feedback attribution is wanted | `guide_run_id`, `guide_trace_id`, `runtime_signal_refs`, `feedback_outcome`, `used_surface` |
| `measureRun` | `run_id`, `task_signature` | `before_guide`, `after_guide`, `forget_result`, `evidence_ids`, `task`, `product_trace` |
| `operatorSnapshotRun` | `run_id`, `task_signature` | `agent_context`, `execution_context`, `measure_result`, `guide_trace_id`, `include_markdown` |

The adapter rejects shared writes or guides without a team boundary. Use
`default_memory_lane: "private"` for single-Agent memory that should not require
`team_id`.

### Recommended Host Integration Templates

Hosts that want a ready-to-wire lifecycle should use the host integration
templates on top of `createExecutionMemoryAdapter`. These templates do not add a
new Runtime feature. They preserve host state across hooks so the next hook can
attribute feedback to the exact guide trace and `use_now` memories the Agent saw.

Template contract version: `aionis_host_integration_template_v1`.

| Template | Use When | Host Hooks | Persist Between Hooks |
|---|---|---|---|
| `createGenericAgentHostTemplate` | One Agent loop needs `observe -> guide -> outcome -> measure -> snapshot` without hand wiring trace state | `startRun`, `observeStep`, `beforeRun`, `afterRun`, `measure`, `snapshot` | `HostRunState` with `run_id`, `task_signature`, `guide_run_id`, `last_guide_trace_id`, `last_use_now_memory_ids` |
| `createMultiAgentHostTemplate` | Planner, worker, verifier, and reviewer share execution memory under one `team_id` | `plannerStart`, `workerStep`, `verifierStep`, `reviewerGuide`, `reviewerOutcome`, `measure`, `snapshot` | `HostRunState` plus role/team identity |
| `createCodingAgentHostTemplate` | A coding Agent needs repository and file-scope context around patch execution | `beforePatch`, `afterPatch`, `measure`, `snapshot` | `HostRunState` plus `repo_root` and `target_files` |

Only pass `agent_context` to the Agent. Keep `HostRunState` in the host runtime,
database, job state, or orchestration state; it is not prompt content.

```ts
import { createAionisClient } from "@aionis/sdk";
import {
  createExecutionMemoryAdapter,
  createMultiAgentHostTemplate,
} from "./src/adapters/index.ts";

const client = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  apiKey: process.env.AIONIS_API_KEY,
});

const memory = createExecutionMemoryAdapter({
  client,
  tenant_id: "default",
  scope: "checkout-migration",
  team_id: "checkout-agent-team",
  default_memory_lane: "shared",
});

const hostMemory = createMultiAgentHostTemplate(memory);

const planned = await hostMemory.plannerStart({
  run_id: "checkout-run-001",
  task_signature: "checkout-migration",
  agent_id: "planner-1",
  title: "Planner scoped checkout migration",
  summary: "Worker should edit src/payments/checkout.ts and verifier must reject legacy broad-search patches.",
});

const guided = await hostMemory.reviewerGuide({
  state: planned.state,
  run_id: "checkout-run-001",
  task_signature: "checkout-migration",
  agent_id: "reviewer-1",
  query_text: "Continue the passed checkout branch and avoid failed legacy patches.",
});

const agentPromptContext = guided.agent_context;

await hostMemory.reviewerOutcome({
  state: guided.state,
  run_id: "reviewer-run-001",
  task_signature: "checkout-migration",
  agent_id: "reviewer-1",
  title: "Reviewer continued passed checkout branch",
  summary: "Reviewer used Aionis context and avoided the failed branch.",
  outcome: "succeeded",
});
```

```ts
import { createAionisClient } from "@aionis/sdk";
import { createExecutionMemoryAdapter } from "./src/adapters/execution-memory.ts";

const client = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  apiKey: process.env.AIONIS_API_KEY,
});

const memory = createExecutionMemoryAdapter({
  client,
  tenant_id: "default",
  scope: "checkout-migration",
  team_id: "checkout-agent-team",
  default_memory_lane: "shared",
});

await memory.observeRunStart({
  run_id: "checkout-run-001",
  task_signature: "checkout-migration",
  agent_id: "planner-1",
  role: "planner",
  title: "Planner scoped checkout migration",
  summary: "Worker should edit src/payments/checkout.ts and verifier must reject legacy broad-search patches.",
});

const guide = await memory.guideNext<{
  agent_context: {
    prompt_text: string;
    use_now_memory_ids: string[];
  };
}>({
  run_id: "checkout-run-001",
  task_signature: "checkout-migration",
  agent_id: "reviewer-1",
  role: "reviewer",
  query_text: "Continue the passed checkout branch and avoid failed legacy patches.",
});

await memory.observeOutcome({
  run_id: "reviewer-run-001",
  guide_run_id: "checkout-run-001",
  task_signature: "checkout-migration",
  agent_id: "reviewer-1",
  role: "reviewer",
  title: "Reviewer continued passed checkout branch",
  summary: "Reviewer used Aionis context and avoided the failed branch.",
  outcome: "succeeded",
  used_memory_ids: guide.agent_context.use_now_memory_ids,
});
```

Runnable e2e:

```bash
npm run -s runtime:e2e:multi-agent
npm run -s runtime:e2e:multi-agent-negative
```

The positive e2e validates the Multi-Agent contract:

1. planner writes a scoped plan
2. worker writes a failed branch
3. verifier marks that branch failed
4. worker writes a passed branch
5. reviewer receives compact `agent_context`
6. execution context separates `use_now` and `do_not_use`
7. reviewer feedback is attributed through `guide_trace_id`
8. `measure` reports positive history impact
9. the flow uses `createExecutionMemoryAdapter`

The negative e2e validates the safety contract:

1. scope-wide shared memory remains visible
2. team-owned shared memory does not cross `consumer_team_id`
3. private Agent memory does not cross `consumer_agent_id`
4. `guide_trace_id` feedback rejects memory IDs not exposed by that guide
5. failed execution branches stay out of `use_now`

## `POST /v1/observe`

### Purpose

Write real memory into Aionis. This can be ordinary memory, execution memory, or
handoff state.

### Minimal Request Fields

| Field | Required | Meaning |
|---|---:|---|
| `tenant_id` | No | Tenant identity. Defaults to the Runtime environment. |
| `scope` | No | Memory scope. Defaults to the Runtime environment. |
| `input_text` | Conditional | Plain memory input. |
| `memory` | Conditional | Explicit memory object. |
| `execution` | Conditional | One execution observation. |
| `handoff` | Conditional | Resumable handoff state. |
| `auto_embed` | No | Whether the Runtime should embed written memory when a provider is configured. |

At least one of `input_text`, `memory`, `execution`, or `handoff` is required.

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `observed` | Host | Counts what was written or stored. |
| `structured_memory` | Host / audit | Shows how product input was projected into memory. |
| `memory_write` | Advanced host / audit | Internal write result. |
| `handoff` | Advanced host / audit | Internal handoff result. |
| `source_map` | Developer | Routes and surfaces used. |

The Agent should not consume the raw observe response. The observe response is
write confirmation, not guidance.

### Example

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "auto_embed": true,
  "input_text": "Checkout migration now uses src/payments/checkout.ts. The legacy checkout route should be inspected before reuse."
}
```

## `POST /v1/guide`

### Purpose

Return compact historical context for the next Agent run.

### Minimal Request Fields

| Field | Required | Meaning |
|---|---:|---|
| `tenant_id` | No | Tenant identity. Defaults to the Runtime environment. |
| `scope` | No | Memory scope. Defaults to the Runtime environment. |
| `query_text` | Yes | What the next run needs memory for. |
| `consumer_agent_id` | No | Agent receiving the guide. |
| `limit` | No | Maximum recall breadth. |
| `include_packets` | No | Adds `memory_packet` and `guide_packet` for audit or measure. |
| `context_mode` | No | `full_power` for full product guide mode, or `compact_agent` for the same governed path with a shorter Agent prompt. |

`POST /v1/guide` uses semantic recall, so a configured embedding provider is
required for normal product use.

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `guide_trace_id` | Host / measure / audit | Stable id for the persisted guide exposure ledger. Pass it back during feedback attribution. |
| `agent_context` | Agent / host prompt builder | Default product output. |
| `memory_packet` | Host / measure / audit | Returned only with `include_packets: true`. |
| `guide_packet` | Host / measure / audit | Returned only with `include_packets: true`. |
| `source_map` | Developer | Routes and omitted internal surfaces. |

### Agent-Facing Fields

Hosts may render `agent_context.prompt_text` directly, or use these structured
fields:

1. `agent_role`
2. `summary`
3. `recommended_posture`
4. `authority`
5. `target_files`
6. `use_now`
7. `inspect_before_use`
8. `do_not_use`
9. `rehydrate_hints`
10. `memory_ids`
11. `use_now_memory_ids`
12. `inspect_before_use_memory_ids`
13. `do_not_use_memory_ids`
14. `risk`

Do not pass `memory_packet`, `guide_packet`, `memory_decision_trace`,
`memory_decision_audit`, raw rows, or raw slots to the Agent by default.
Keep `guide_trace_id` in the host run record. It is not agent-facing; it lets
Aionis later know exactly which memories were exposed by that guide call.

### Example

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "query_text": "Continue checkout migration and avoid stale legacy route guidance.",
  "consumer_agent_id": "agent-1",
  "limit": 8,
  "include_packets": false
}
```

### Full-Power Guide Mode

For hosts that want the strongest product guide without calling lower-level
routes directly, set `mode: "full_power"` or `context_mode: "full_power"` on
`POST /v1/guide`.

The SDK `guide()` method defaults to `mode: "full_power"`, so normal SDK
integrations use this product path automatically. A host can opt out with
`createAionisClient({ default_guide_mode: "standard" })`, by passing
`mode: "standard"` in the guide body, or by passing `{ guide_mode: null }` as
the per-call SDK option when it wants to send the raw body unchanged.

Full-power guide still returns `agent_context` as the Agent-facing surface. It
internally combines semantic recall with the safe `agent_context` projection
from `/v1/execution/context/assemble`, so:

1. ordinary memory can still enter `use_now`
2. passed execution branches can enter `use_now`
3. failed branches enter `do_not_use`
4. contested or stale memory stays out of `use_now`
5. raw evidence, gated abstractions, and trace details remain omitted from
   `agent_context.prompt_text`

Use `execution_tree_v1` when the host has current branch state. Use
`context.task_signature`, `context.task_family`, or `context.workflow_signature`
to let the Runtime pull matching execution evidence into the internal
full-power assembly.

### Compact Agent Context

For hosts that are token-sensitive, set `context_mode: "compact_agent"` on
`POST /v1/guide`. This uses the same governed full-power product path as the
standard SDK guide default, but renders a shorter Agent-facing prompt. The
Runtime still returns the structured context fields needed for attribution and
audit:

1. `agent_context.agent_context_mode: "compact_agent"`
2. `use_now_memory_ids`
3. `inspect_before_use_memory_ids`
4. `do_not_use_memory_ids`
5. `rehydrate_hints`
6. optional packets and receipt/trace surfaces when requested

Compact mode must not change memory authority. If a memory is stale, failed,
contested, or rehydratable, it still belongs in `inspect_before_use`,
`do_not_use`, or `rehydrate_hints`; compact mode only changes how the safe
Agent prompt is rendered.

Example:

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "context_mode": "compact_agent",
  "query_text": "Continue checkout migration and avoid failed legacy branches.",
  "consumer_agent_id": "reviewer-1",
  "agent_role": "reviewer",
  "context": {
    "task_signature": "checkout-migration"
  }
}
```

Example:

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "mode": "full_power",
  "query_text": "Continue checkout migration and avoid failed legacy branches.",
  "consumer_agent_id": "reviewer-1",
  "agent_role": "reviewer",
  "context": {
    "task_signature": "checkout-migration"
  },
  "include_packets": true
}
```

## Advanced Execution Context Assembly

`POST /v1/execution/context/assemble` is the execution-tree-first context
surface used by advanced hosts and adapters. It is not the default product
guide facade, but it is the right path when a host already has an execution
tree, handoff tree id, or explicit execution evidence filters.

Default mode preserves the compact execution evidence contract:

1. `CURRENT_ACTIVE_PATH`
2. `PASSED_SOLUTIONS`
3. `FAILED_BRANCHES`
4. optional supporting evidence and rehydration refs

For full-power Runtime adapters, set `context_mode: "full_power"`. The response
keeps the existing fields and also exposes:

1. `raw_evidence`
2. `gated_abstractions`
3. `full_power_trace`

When `include_prompt_text: true`, the prompt text adds these sections:

1. `RAW_EVIDENCE`
2. `GATED_ABSTRACTIONS`
3. `TRACE`

The contract is evidence-first:

1. `PASSED_SOLUTIONS` are reusable only when validated or evidence-backed.
2. `FAILED_BRANCHES` are counter-evidence and must not be copied as answers.
3. `RAW_EVIDENCE` is first-class source material, not a passed solution.
4. `GATED_ABSTRACTIONS` are advisory and bounded by `applies_when`,
   `does_not_apply_when`, `counterexamples`, and source episode refs.
5. Summary-only execution memory remains blocked from promotion by the
   consolidation guard.

Example:

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "tree_id": "execution-tree:checkout-42",
  "tree_scope": "aionis://execution/checkout-42",
  "context_mode": "full_power",
  "prompt_detail": "full",
  "include_memory_evidence": true,
  "memory_filters": [
    {
      "slots_contains": {
        "task_signature": "checkout-migration"
      },
      "limit": 20
    }
  ]
}
```

## `POST /v1/feedback`

### Purpose

Attribute a real run outcome to the memory IDs the host knows were actually
used. This is the normal product path after `guide -> agent action`.

### Minimal Request Fields

| Field | Required | Meaning |
|---|---:|---|
| `reason` | Yes | Why this feedback is being recorded. |
| `run_id` | Yes | The concrete run that used the memory. |
| `outcome` | Yes | `positive`, `negative`, or `neutral`. |
| `used_surface` | Yes | `use_now` or `explicit_host_assertion` is required for non-neutral feedback. |
| `guide_trace_id` + `used_memory_ids` | Preferred | Lets Aionis verify attribution against the exact guide exposure ledger. |
| `memory_ids` / `node_ids` | Conditional | Direct attribution when the host already has precise memory IDs. |
| `verifier_status` / `tool_status` / `runtime_signal_refs` | No | Optional evidence for stronger positive or negative feedback. |

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `product_action` | Developer | Always `feedback`. |
| `operation` | Host / measure | Always `activate`; kept so `product_trace.forget_result` stays compatible. |
| `forget_effect` | Host / measure | Product-level feedback attribution effect. |
| `result` | Advanced host / audit | Internal node activation result. |

## `POST /v1/rehydrate`

### Purpose

Expand archived memory or anchor payload only when the compact context says the
Agent needs the colder evidence or payload.

### Minimal Request Fields

| Field | Required | Meaning |
|---|---:|---|
| `reason` | Yes | Why the compact context is insufficient. |
| `memory_ids` / `node_ids` / `client_ids` | Conditional | Archived memory to move back to `warm` or `hot`. |
| `anchor_id` / `anchor_uri` | Conditional | Anchor payload to expand. |
| `target` | No | `archive`, `payload`, or `memory`; inferred when possible. |
| `target_tier` | No | `warm` or `hot` for archived memory. |
| `mode` | No | `summary_only`, `partial`, `full`, or `differential` for payload rehydration. |

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `product_action` | Developer | Always `rehydrate`. |
| `operation` | Host / measure | Always `rehydrate`; kept so `product_trace.forget_result` stays compatible. |
| `forget_effect` | Host / measure | Product-level rehydration effect. |
| `result` | Advanced host / audit | Internal archive or anchor rehydration result. |

## `POST /v1/forget`

### Purpose

Controlled forgetting is a core Aionis capability. `POST /v1/forget` is the
explicit lifecycle-control API for suppressing stale or harmful memory,
unsuppressing reviewed memory, activating directly attributed memory, moving
archived memory, or rehydrating payloads without deleting source evidence
silently.

Normal host loops can use `/v1/feedback` for run attribution and
`/v1/rehydrate` for payload or archive expansion. Those are productized
forgetting/lifecycle paths; they do not replace `/v1/forget` when the host or
operator needs explicit lifecycle control.

### Minimal Request Fields

| Field | Required | Meaning |
|---|---:|---|
| `operation` | Yes | `suppress`, `unsuppress`, `rehydrate`, or `activate`. Use `/v1/forget` when explicit lifecycle control is the product action. |
| `reason` | Yes | Why this lifecycle action is being taken. |
| `target` | No | `memory`, `archive`, `payload`, or `pattern`. |
| `memory_ids` / `node_ids` / `client_ids` | Conditional | Required for memory activation and many rehydrate operations. |
| `guide_trace_id` + `used_memory_ids` | Conditional | Preferred for feedback attribution after `/v1/guide`; Aionis verifies the used ids were exposed by that guide. |
| `anchor_id` / `anchor_uri` | Conditional | Required for pattern suppression or payload rehydration. |
| `run_id` | Conditional | Required for `activate` so feedback can be attributed to a real run. |
| `outcome` | Conditional | Required for `activate`; `positive`, `negative`, or `neutral`. |
| `used_surface` | Conditional | Required for `activate`; `use_now` or `explicit_host_assertion` is required for non-neutral feedback. |
| `verifier_status` | No | Optional run evidence: `passed`, `failed`, `not_run`, or `unknown`. |
| `tool_status` | No | Optional run evidence: `succeeded`, `failed`, `not_run`, or `unknown`. |
| `runtime_signal_refs` | No | Optional ids for concrete runtime/verifier/tool failure signals supporting the attribution. |
| `mode` | No | Suppression or rehydration mode. |

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `forget_effect` | Host / measure | Product-level effect of the lifecycle action. |
| `result` | Advanced host / audit | Internal route result. |
| `source_map` | Developer | Routes and omitted internal surfaces. |

The host should consume `forget_effect`. It should not ask the Agent to reason
over internal lifecycle rows or raw slots.

For sparse-feedback attribution, prefer `/v1/feedback`. The explicit
`operation: "activate"` form remains available for advanced callers. In either
case, `run_id`, `outcome`, and `used_surface` are required. Non-neutral feedback
must use `used_surface: "use_now"` or `used_surface: "explicit_host_assertion"`;
this is the attribution gate that prevents Aionis from blaming every recalled
memory for a run outcome.

Prefer passing `guide_trace_id` from `/v1/guide` plus `used_memory_ids`. Aionis
will load the persisted guide exposure ledger, reject ids that were not exposed
by that guide, and record exposed-but-unused ids as unattributed rather than
blaming them for the run outcome. Direct `memory_ids` remain accepted when the
host already has a precise attribution source, but `guide_trace_id` is the
product path for normal guide-to-feedback loops.

A single negative outcome without aligned verifier/tool/runtime evidence is
stored as a weak counter-signal. It does not immediately lower authority. Aionis
lowers authority or moves a memory to `inspect_before_use` only after repeated
weak counter-signals, or after one negative outcome backed by aligned evidence
such as `verifier_status: "failed"`, `tool_status: "failed"`, or concrete
`runtime_signal_refs`.

Aionis does not infer that every recalled memory caused a run outcome unless the
host reports it as used.

### Example

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "operation": "activate",
  "target": "memory",
  "reason": "Agent used this memory successfully during the checkout continuation.",
  "memory_ids": ["mem_checkout_current"],
  "outcome": "positive",
  "run_id": "run-2026-06-06-001",
  "used_surface": "use_now",
  "verifier_status": "passed",
  "tool_status": "succeeded"
}
```

## `POST /v1/measure`

### Purpose

Measure whether history changed future behavior positively or negatively.

This route measures Aionis-owned product effects: continuity, repeated
discovery reduction, useful context ratio, stale-memory suppression,
rehydration, workflow candidate reuse, and authority blocking. It is not proof
that an external Agent solved a task unless a separate validation layer supplies
that outcome.

### Minimal Request Fields

Use one of these forms:

| Input | Required Shape | Meaning |
|---|---|---|
| Manual pair | `baseline` and `aionis` | Direct effect observations supplied by the host. |
| Product trace | `product_trace.before_guide` and `product_trace.after_guide` | Compare two guide outputs. |
| Product trace with baseline | `product_trace.baseline` and `product_trace.after_guide` | Compare manual baseline to active Aionis guide output. |

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `effect_report` | Product / operator | User-readable history impact report. |
| `measurement_input` | Developer | Inputs projected into the evaluator. |
| `memory_decision_trace` | Developer | Present when `product_trace` is supplied. |
| `memory_decision_trace.memory_use_receipt` | Host / operator | Compact read-only receipt of exposed, blocked, rehydrated, attributed, and unattributed memory IDs. |
| `memory_decision_trace.judgment_calibration_summary` | Host / operator | Read-only summary of supported, contradicted, unused, weak, and inconclusive memory judgments. |
| `memory_decision_audit` | Operator | Present when `product_trace` is supplied. |
| `kernel_report` | Advanced developer | Internal effect evaluator output. |

When `product_trace.forget_result` contains `operation: "activate"` feedback,
`memory_decision_trace.feedback_attribution` explains the attribution path:
which memory ids were host-marked as used, whether the signal was weak or
strong, whether the threshold was met, and which recalled memory ids stayed
unattributed. Per-memory `feedback_detail` explains why a single weak negative
does not lower authority, and why repeated weak or verifier/tool/runtime-aligned
negative feedback moves memory to `inspect_before_use`.
When feedback is tied to a `guide_trace_id`, the trace also reports exposure
counts and surface-level `unattributed_*_memory_ids` so developers can audit
which shown memories were not used. These fields are read-only observability:
they do not lower authority, suppress memories, or write feedback slots by
themselves.
`unused_exposure_observation` adds the repeated-exposure view: it identifies
memories that were shown across multiple guide traces but not host-marked as
used in the current activation, and separately lists the subset with no positive
attributed use recorded. The observation object is still read-only evidence for
product debugging. When the repeated-unused-without-positive gate passes,
`forget_effect.guide_trace.feedback_learning_control` records the separate persistence
action that set `feedback_learning_control_posture=inspect_before_use` on the affected
memory ids. This is not suppression, archive, deletion, or task-rule learning; it
only prevents direct reuse until the Agent or host inspects/revalidates the
memory. A later positive attributed use clears this feedback-learning control posture.
`sparse_feedback_signal_summary` rolls positive attribution, weak/strong
counter-signals, and repeated unused exposure into one read-only debug summary.
It sets `authority_mutation: false` to make the boundary explicit.
`memory_use_receipt` is the smallest stable audit object for memory use. It is
derived from the same decision trace and keeps `agent_prompt_included: false`
and `runtime_mutation: false`, so hosts can log or display usage without
turning the audit surface into Agent context.
`judgment_calibration_summary` is the first Judgment Ledger projection. It is
derived from the same decision trace and feedback attribution: positive
host-used memory becomes supported, threshold-met negative evidence becomes
contradicted, single weak negative evidence remains weak/inconclusive, and
shown-but-unreported memory becomes unused. The summary is read-only and does
not mutate authority, ranking, suppression, or lifecycle state.
`memory_decision_audit.feedback_signal_review` exposes the same buckets in a
more operator-readable shape, with memory ids, titles, and reasons. It is for
measure/debug/audit surfaces only and must not be appended to the Agent prompt.
`effect_report.feedback_signal_summary` gives the same signal ids in product
summary form, so product dashboards can show positive attribution, weak/strong
counter-signals, and repeated unused exposure without parsing the full trace.
It also keeps `authority_mutation: false`; authority changes remain governed by
the underlying feedback/forgetting mechanisms, not by this report field.
`confidence_decay_candidate_summary` is the Direction 2 shadow view: it lists
memories that may deserve lower future reliance, memories protected by positive
attribution, drift-only observations, and temporal staleness candidates. Time
decay is based on old active trusted/advisory memory still exposed to the Agent,
relative to the freshest scoped observed memory. It is still measure/debug/audit
only; it does not demote, suppress, archive, or rewrite guide authority.
`inspect_before_use_shadow_delta` is the disabled product-flag preview for the
same candidate set. It reports which memories would move to
`inspect_before_use` if the flag were enabled, which memories are already on
that surface, and which memories were blocked by positive attribution or recent
validation. It always reports `enabled: false`, `authority_mutation: false`, and
`agent_prompt_included: false`.

### Example

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "baseline": {
    "label": "no-memory",
    "continuity": {
      "repeatedDiscoverySteps": 6,
      "recoveredStateFacts": 0,
      "expectedStateFacts": 3
    },
    "forgetting": {
      "contextItems": 0,
      "usefulContextItems": 0,
      "staleMemorySurfaced": 0
    }
  },
  "aionis": {
    "label": "aionis-guide",
    "continuity": {
      "repeatedDiscoverySteps": 1,
      "recoveredStateFacts": 3,
      "expectedStateFacts": 3
    },
    "forgetting": {
      "contextItems": 4,
      "usefulContextItems": 3,
      "staleMemorySurfaced": 0,
      "staleMemorySuppressed": 1
    },
    "learning_control": {
      "blockedAuthorityVisible": true,
      "unverifiedAuthorityApplied": 0
    }
  }
}
```

## Product Boundaries

1. Aionis remembers, guides, gates, forgets, and measures.
2. The Agent or host still owns task reasoning, tool execution, and semantic
   repair.
3. `agent_context` is the only default Agent-facing output.
4. Debug and audit outputs explain Aionis decisions; they are not prompts.
5. Full packets are available for advanced integration, measurement, and audit,
   but they are not the default prompt payload.
6. Product API usage must not depend on a specific external Agent framework.
7. Runtime behavior must not be changed because of one task result.

## Related Documents

1. [AIONIS_PRODUCT_CONTRACT.md](AIONIS_PRODUCT_CONTRACT.md)
2. [AIONIS_PRODUCT_OUTPUT_CONTRACT.md](AIONIS_PRODUCT_OUTPUT_CONTRACT.md)
3. [AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md](AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md)
4. [AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md](AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md)
