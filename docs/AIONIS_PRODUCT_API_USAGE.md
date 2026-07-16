# Aionis Product API Usage

Status: product API usage guide for the v0.3.10 development Runtime

This document explains how a host should use the product actions:
`observe`, `guide`, `feedback`, `measure`, `rehydrate`, and `snapshot`.

It describes the development product path over the current Runtime
implementation. Contract changes in this development train are carried by SDK
`0.3.18`; this is a Public Beta contract, not a GA compatibility promise.

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
For the final Agent-facing context contract, see
[AIONIS_AGENT_CONTEXT_CONTRACT.md](AIONIS_AGENT_CONTEXT_CONTRACT.md).
For admission dataset JSONL export, see
[AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md](AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md).
For backend-agnostic Memory Firewall, see
[AIONIS_MEMORY_FIREWALL.md](AIONIS_MEMORY_FIREWALL.md).
For the versioned external memory governance decision table, see
[AIONIS_GOVERNANCE_POLICY_V1.md](AIONIS_GOVERNANCE_POLICY_V1.md).
For the rehydrate lifecycle and payload expansion contract, see
[AIONIS_REHYDRATE_CONTRACT.md](AIONIS_REHYDRATE_CONTRACT.md).
For multi-Agent scope, lane, team, and identity boundaries, see
[AIONIS_MULTI_AGENT_SCOPE_MODEL.md](AIONIS_MULTI_AGENT_SCOPE_MODEL.md).
For incident replay, see
[AIONIS_AGENT_FLIGHT_RECORDER.md](AIONIS_AGENT_FLIGHT_RECORDER.md).
For trace-derived skill candidate review and the explicit skill-memory path, see
[AIONIS_TRACE_DERIVED_SKILL_MEMORY.md](AIONIS_TRACE_DERIVED_SKILL_MEMORY.md).

## Route Summary

| Route | Product Action | Caller | Primary Consumer | Main Output |
|---|---|---|---|---|
| `POST /v1/observe` | `observe` | Host after real work or memory input | Runtime write path | durable `operation_id`, `observed`, `post_commit_projections` |
| `POST /v1/handoff/store` | direct durable handoff | Host that uses the lower-level handoff surface | Runtime handoff/write path | durable `operation_id`, `aionis_handoff_store_result_v1` |
| `POST /v1/guide` | `guide` | Host before the next Agent run | Agent prompt builder | `agent_context` |
| `POST /v1/memory/govern` | govern external memory | Host before using Mem0/Zep/vector DB/markdown candidates | Memory admission gateway | `agent_context`, `memory_use_receipt`, optional `memory_admission_records` |
| `POST /v1/feedback` | `feedback` | Host after the Agent acts | Feedback attribution | `forget_effect` with `operation: "activate"` |
| `POST /v1/rehydrate` | `rehydrate` | Host when compact context needs original evidence or payload | Payload / archive lifecycle controller | `forget_effect` with `operation: "rehydrate"` |
| `POST /v1/measure` | `measure` | Host, operator, or product evaluator | Product diagnostics | `evidence_assessment`, `effect_report`, optional decision trace and audit |
| `POST /v1/skills/candidates` | queue skill candidates | Host or operator after measure | Trace-derived skill review ledger | queued candidate rows |
| `GET /v1/skills/candidates` | list skill candidates | Host or operator | Trace-derived skill review ledger | pending/promoted/rejected candidate rows |
| `POST /v1/skills/candidates/:id/promote` | review skill candidate | Operator or host review workflow | Trace-derived skill review ledger | promoted review row |
| `POST /v1/skills/candidates/:id/reject` | review skill candidate | Operator or host review workflow | Trace-derived skill review ledger | rejected review row |
| `POST /v1/skills/candidates/:id/materialize` | materialize reviewed skill candidate | Host or operator after promotion | Procedure memory draft gate | draft and recommended observe payload |
| `POST /v1/audit/flight-recorder` | incident replay | Host or operator after a run | Agent Flight Recorder | `agent_flight_recorder` |
| `POST /v1/forget` | controlled forgetting | Host, operator, or product policy | Explicit lifecycle controller | `forget_effect` |

Optional read-only operator route:

| Route | Product Role | Caller | Primary Consumer | Main Output |
|---|---|---|---|---|
| `POST /v1/operator/snapshot` | inspect | Host or operator after guide/feedback/measure | Operator / host observability | `operator_snapshot`, optional markdown |

The recommended Agent-facing surface is SDK `guideAgentContext().agent_prompt`
or `execution.guideAgentContextForRole().agent_prompt`. Direct HTTP hosts may
consume only `agent_context.prompt_text` or selected `agent_context` fields.
Full packets, decision traces, audit reports, raw rows, memory admission
records, and raw slots are operator surfaces.

Do not concatenate SDK and Runtime prompt renderings. Pick exactly one final
Agent prompt:

| Host path | Final prompt | Header |
|---|---|---|
| Recommended SDK path | `guideAgentContext().agent_prompt` or `execution.guideAgentContextForRole().agent_prompt` | `AIONIS_EXECUTION_AGENT_CONTEXT v1` |
| Raw HTTP path | `POST /v1/guide -> agent_context.prompt_text` | `AIONIS_AGENT_CONTEXT v1` by default; `AIONIS_CTX v2` in compact Runtime mode |
| Explicit SDK low-token path | `guideAgentContext(..., { prompt_format: "runtime_compact" }).agent_prompt` | Runtime `agent_context.prompt_text` |

`context_mode: "compact_agent"` requests compact Runtime base guide text. It
does not by itself switch the SDK final prompt away from
`AIONIS_EXECUTION_AGENT_CONTEXT v1`.

Execution-scoped memory follows exact-task prompt admission. With a current
`task_signature`, exact-task execution evidence and accepted / passed
same-workflow continuation evidence can become `should_continue` / active
route guidance when the route contract admits it. Broad family-only evidence,
different-workflow evidence, rejected branches, failed branches, stale branches,
and contested evidence can remain in `memory_packet` or inspection surfaces; they
must not become `agent_prompt` / `agent_context.prompt_text` direct action text
just because they are nearby.

For host decisions, distinguish these two fields:

| Field | Meaning | Product Use |
|---|---|---|
| `history_used` | The Aionis history/context channel participated in guide assembly. | Observability of the context channel. |
| `actionable_history_used` | The Agent received memory-backed guidance, rehydration hints, or execution branches that can affect the next action. | Whether Aionis actually supplied actionable memory. |

## Integration Flow

1. Call `POST /v1/observe` after real work, a user preference, a project fact,
   an execution trace, or a handoff should become memory.
2. Call `POST /v1/guide` before the next Agent run.
3. Pass SDK `agent_prompt` to the Agent. If integrating directly over HTTP, pass
   only `agent_context.prompt_text` or selected `agent_context` fields. Never
   append `agent_context.prompt_text` to SDK `agent_prompt`.
4. After the Agent acts, SDK hosts pass the complete source guide plus
   host-observed `used_memory_ids` to `feedbackFromGuide()`; the helper derives
   the exact persisted served surface. Raw HTTP hosts pass `guide_trace_id`,
   `used_memory_ids`, `run_id`, `outcome`, and `used_surface`, and Runtime
   reloads the persisted exposure before accepting attribution.
5. Call SDK `rehydrate()` or raw `POST /v1/rehydrate` when an archived memory
   or anchor payload needs to be expanded.
6. Call `POST /v1/measure` with before/after guide packets or direct
   observations when the product needs to prove whether history helped or hurt.
7. Queue trace-derived skill candidates with `POST /v1/skills/candidates` only
   when `measure.evidence_assessment.eligible_for_skill_export` is true and
   `measure.effect_report.training_candidates` contains reusable execution
   lessons that should enter operator review. Promote or reject each candidate.
   To make a promoted candidate recallable, call
   `POST /v1/skills/candidates/:id/materialize`, inspect the returned draft,
   then explicitly submit `recommended_observe_payload` to `POST /v1/observe`.
   Candidate review and materialize do not mutate memory or inject prompt
   context by themselves; see
   [AIONIS_TRACE_DERIVED_SKILL_MEMORY.md](AIONIS_TRACE_DERIVED_SKILL_MEMORY.md).
8. Call `POST /v1/operator/snapshot` when a host or operator needs a read-only
   summary of actionable history, feedback attribution, branch isolation, and
   measured effect.

## Durable Writes And Projection Status

Treat `operation_id` as the idempotency key for every logical write attempt.
Generate it before the first request and reuse it only when retrying the exact
same effective request:

- `/v1/observe` returns `aionis_observe_result_v1` with the durable
  `operation_id` and `post_commit_projections`.
- Direct `/v1/handoff/store` returns `aionis_handoff_store_result_v1` with the
  durable `operation_id`.
- A retry with the same ID and same request returns the stored receipt. Reusing
  the ID for different content returns HTTP `409`.
- `post_commit_projections.embedding: "scheduled"` and
  `ann_sync: "scheduled"` mean a durable job was committed; they do not claim
  that the external embedding provider or ANN side effect has completed.

The semantic write and projection intent share the SQLite transaction. The
worker may report `pending`, `running`, `retry`, `dead_letter`, or `succeeded`
jobs under `/health -> lite.stores.write.projections`; worker liveness is under
`/health -> lite.stores.projection_worker`. Operators should alert on
`dead_letter`, persistent `retry`, provider mismatch, or legacy pending rows.

This recovery model covers one Lite Runtime process. Its local in-memory ANN is
rebuilt from committed SQLite vectors at startup. Several Runtime processes
require a shared persistent ANN or cross-instance reconciliation.

## Measure Evidence Gate

`/v1/measure` computes evidence sufficiency from Runtime-owned receipts. Client
fields named `sufficient_evidence` and `evidence_ids` remain accepted for wire
compatibility, but they are claims, not proof, and are exposed only under
`evidence_assessment.client_claims_ignored`.

Manual observations always have `provenance: "manual_unverified"`,
`sufficient_evidence: false`, and `eligible_for_skill_export: false`. A measure
becomes export-eligible only when Runtime verifies the paired guide receipts,
task/run binding, ordered observations, trusted Runtime verifier receipt,
linked positive tool feedback, and complete passing kernel metrics. Hosts must
branch on `evidence_assessment`, never on fields they supplied in the request.

## SDK Product Path

The focused Runtime also exposes a small TypeScript client for the product
actions. The SDK is a facade over the product routes.
`feedback()` posts to `/v1/feedback`. `rehydrate()` posts to `/v1/rehydrate`.
`snapshot()` is a short alias for `/v1/operator/snapshot`. The lower-level
`/v1/forget` route remains available for explicit suppress/unsuppress lifecycle
control.

```ts
import {
  compileExecutionAgentContext,
  createAionisClient,
  feedbackAttributionFromGuide,
  feedbackFromGuide,
  memoryAdmissionDatasetJsonlFromGuide,
  memoryAdmissionRecordFromGuide,
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
  operation_id: "observe:checkout:run-001:recovered-workflow",
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

const guide = await aionis.execution.guideForRole<{
  guide_trace_id: string;
  feedback_attribution_v1: unknown;
  agent_context: {
    prompt_text: string;
    use_now_memory_ids: string[];
  };
}>({
  agent_id: "agent-1",
  run_id: "run-001",
  task_signature: "checkout-continuation",
  query_text: "Continue checkout migration without repeating stale discovery.",
  limit: 8,
  context_mode: "compact_agent",
});

const agentContext = compileExecutionAgentContext({
  guide,
  task: {
    run_id: "run-001",
    task_signature: "checkout-continuation",
    query_text: "Continue checkout migration without repeating stale discovery.",
  },
  repo_state: {
    existing_files: ["src/payments/checkout.ts"],
  },
  budget_profile: "balanced",
});

// Your host runs the Agent with agentContext.agent_prompt.
// Keep the admission record in host/operator logs, not in the Agent prompt.
const admissionRecord = memoryAdmissionRecordFromGuide(guide);
const admissionDatasetJsonl = memoryAdmissionDatasetJsonlFromGuide(guide, {
  run_id: "run-001",
  task_id: "task-001",
  task_signature: "checkout-continuation",
});

const attribution = feedbackAttributionFromGuide(guide);
if (attribution.status !== "available") {
  throw new Error("Request a new guide before submitting learning feedback.");
}
const agentResult = await runYourInstrumentedAgent(agentContext.agent_prompt);
const feedback = agentResult.used_memory_ids.length === 0
  ? null
  : await aionis.feedback(feedbackFromGuide({
      guide,
      reason: "The host observed these persisted guide items being used.",
      run_id: "run-001",
      outcome: "positive",
      used_memory_ids: agentResult.used_memory_ids,
      verifier_status: "passed",
      tool_status: "succeeded",
    }));

// Allocate once before the first attempt and persist this ID with the host job.
const measureOperationId = "measure:task-001:run-001:attempt-1";
const measureRequest = measureInputFromGuideLoop({
  operation_id: measureOperationId,
  task: {
    task_id: "task-001",
    run_id: "run-001",
    task_signature: "checkout-continuation",
    task_family: "developer_sdk",
  },
  after_guide: guide,
  feedback_result: feedback,
});
const measure = await aionis.measure(measureRequest);

// After an unknown transport outcome, retry the exact same measureRequest.
// Never reuse measureOperationId with changed content.

// This short example has no Runtime-verified before/after verifier chain, so it
// is diagnostic only and cannot export learning or skill candidates.
console.log(measure.evidence_assessment);

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

For coding and multi-agent hosts, the Agent should receive SDK
`guideAgentContext().agent_prompt` or
`execution.guideAgentContextForRole().agent_prompt`. Low-level hosts may still
compile from a guide or pass selected `agent_context` fields directly. Keep
`memory_packet`, `guide_packet`, `memory_decision_trace`, `memory_decision_audit`,
`memory_admission_record`, and raw rows on host/operator surfaces by default.
`feedbackFromGuide()` requires the complete source guide. It validates
host-observed IDs against exact persisted `feedback_attribution_v1` items,
rejects context-only, unknown, mixed-surface, and rehydrate-only attribution,
and derives the served surface. `measureInputFromGuideLoop()` and
`snapshotInputFromGuideLoop()` hide the internal `product_trace` and operator
snapshot wiring from normal app code.
Allocate and persist one stable measure `operation_id` before the first attempt.
If the response is lost, retry the same measure request and ID; any content
change is a new logical write and requires a new ID.
The measure helper still accepts legacy client evidence claims, but the Runtime
does not use them to open the evidence gate.

`memoryAdmissionRecordFromGuide()` returns the read-only
`AionisMemoryAdmissionRecord`: one row per candidate memory with the admission
action, prompt exposure flag, and feedback attribution. It is the product path
for future admission dataset export, Memory Firewall analysis, and Agent Flight
Recorder replay. It is read-only and belongs in host or operator storage.

`memoryAdmissionDatasetJsonlFromGuide()` turns that record into JSONL rows that
can be appended to the host's own logs or data lake. The exported rows include
candidate memory IDs, admission actions, prompt exposure, feedback attribution,
outcome labels, reason codes, and evidence IDs. They intentionally exclude raw
memory payloads, raw prompt text, embeddings, and Runtime mutation authority.

`governMemory()` is the SDK method for backend-agnostic memory admission. It
accepts external memory candidates from systems such as Mem0, Zep, a vector DB,
markdown files, or a custom store, then routes them through Aionis admission
surfaces without writing them into Aionis memory first.

When the backend is Mem0, the preferred SDK path is
`governMem0SearchResults()`. It accepts plain Mem0 `search()` results, maps them
to external candidates, then calls the same `/v1/memory/govern` gateway with
`mode: "firewall"`, `context_mode: "compact_agent"`, and
`include_records: true` by default.

```ts
const mem0Results = await mem0.search("Continue checkout migration", {
  user_id: "checkout-agent",
  top_k: 10,
});

const governed = await aionis.governMem0SearchResults({
  query_text: "Continue checkout migration without repeating failed branches.",
  run_id: "run-001",
  mem0_results: mem0Results,
});

const firewallPromptForAgent = governed.agent_context.prompt_text;
const firewallForOps = governed.memory_firewall;
const receiptForLogs = governed.memory_use_receipt;
```

This is the Memory Firewall prompt surface for externally retrieved memory. For
normal task execution, prefer SDK `guideAgentContext().agent_prompt`.

The SDK also exposes `mem0SearchResultsToAionisCandidates()` for hosts that want
to inspect or enrich the mapped candidates before admission.

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

The product-loop e2e exercises `observe -> guide -> simulated Agent ->
feedback -> measure -> admission dataset JSONL export -> snapshot`, and also
verifies that product `/v1/guide mode=full_power` keeps passed branches, failed
branches, and audit surfaces separated without a lower-level execution HTTP
route.

The ordinary-memory e2e exercises the general cognitive memory path:
`observe ordinary memory -> guide -> trace/receipt -> feedback -> measure ->
snapshot`. It checks that active preferences and corrected facts can be used,
stale or contradicted facts stay inspect-first, and receipt decision summaries
make the use/suppress reason visible without becoming prompt content. Its
holdout coverage includes active project notes, candidate memory,
suppressed memory, private visibility boundaries, and a negative control that
ordinary memory writes stay on the ordinary-memory path.

The golden product loop exercises the full product path:

```text
observe -> guide -> agent action -> outcome feedback -> measure -> snapshot
```

It is the preferred product proof when validating that Aionis changes the next
Agent context, isolates failed branches, and gives operators a read-only memory
use receipt plus trace-to-procedure readiness.

The agent-suite e2e is the real LLM downstream demo. It compares `baseline`,
`long_context`, and `aionis` groups, then verifies that Aionis recovers the
verified active path, suppresses failed branch direct use, provides
evidence-backed feedback, and keeps execution context shorter than raw long
history. This validates Agent-context behavior with a real LLM.

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
7. After the Agent acts, give SDK `feedbackFromGuide()` the complete source
   guide and IDs taken from the instrumented Agent/host trace. Raw HTTP hosts
   send `actor`, `guide_trace_id`, `used_memory_ids`, `run_id`, `outcome`, and
   `used_surface`. AgentContext IDs are visibility metadata, not actual-use
   evidence or attribution authority.
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
| `observeRunStart` / `observeStep` | `run_id`, `task_signature`, `agent_id` or `default_agent_id`, `title`, `summary` | durable `operation_id`, `task_family`, `workflow_signature`, `target_files`, `workflow_steps`, `raw_ref`, `evidence_ref`, `slots`, `handoff.execution_tree_v1`, `handoff.execution_tree_operations_v1` |
| `guideNext` | `run_id`, `task_signature`, `agent_id` or `default_agent_id`, `query_text` | `context`, `execution_tree_v1`, `tool_candidates`, `limit`, `include_packets`, `mode` |
| `observeOutcome` | same as `observeStep`; `used_memory_ids` when feedback attribution is wanted | `guide_run_id`, `guide_trace_id`, `runtime_signal_refs`, `feedback_outcome`, `used_surface` |
| `measureRun` | `run_id`, `task_signature` | `before_guide`, `after_guide`, `forget_result`, `task`, `product_trace`; legacy evidence claims are reported as ignored |
| `operatorSnapshotRun` | `run_id`, `task_signature` | `agent_context`, `execution_context`, `measure_result`, `guide_trace_id`, `include_markdown` |

The adapter rejects shared writes or guides without a team boundary. Use
`default_memory_lane: "private"` for single-Agent memory that runs without a
`team_id`.

### Recommended Host Integration Templates

Hosts that want a ready-to-wire lifecycle should use the host integration
templates on top of `createExecutionMemoryAdapter`. These templates preserve
guide trace and visibility state across hooks. The host must still pass exact
trace-derived `used_memory_ids` to the outcome hook; the template never promotes
all visible `use_now` memories into actual-use feedback.

Template contract version: `aionis_host_integration_template_v1`.

| Template | Use When | Host Hooks | Persist Between Hooks |
|---|---|---|---|
| `createGenericAgentHostTemplate` | One Agent loop needs `observe -> guide -> outcome -> measure -> snapshot` without hand wiring trace state | `startRun`, `observeStep`, `beforeRun`, `afterRun`, `measure`, `snapshot` | `HostRunState` with `run_id`, `task_signature`, `guide_run_id`, `last_guide_trace_id`, `last_use_now_memory_ids` |
| `createMultiAgentHostTemplate` | Planner, worker, verifier, and reviewer share execution memory under one `team_id` | `plannerStart`, `workerStep`, `verifierStep`, `reviewerGuide`, `reviewerOutcome`, `measure`, `snapshot` | `HostRunState` plus role/team identity |
| `createCodingAgentHostTemplate` | A coding Agent needs repository and file-scope context around patch execution | `beforePatch`, `afterPatch`, `measure`, `snapshot` | `HostRunState` plus `repo_root` and `target_files` |

Pass `agent_context` to the Agent. Keep `HostRunState` in the host runtime,
database, job state, or orchestration state.

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

const reviewerResult = await runYourInstrumentedAgent(
  guide.agent_context.prompt_text,
);

await memory.observeOutcome({
  run_id: "reviewer-run-001",
  guide_run_id: "checkout-run-001",
  task_signature: "checkout-migration",
  agent_id: "reviewer-1",
  role: "reviewer",
  title: "Reviewer continued passed checkout branch",
  summary: "Reviewer used Aionis context and avoided the failed branch.",
  outcome: "succeeded",
  used_memory_ids: reviewerResult.used_memory_ids,
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
2. team-owned shared memory stays inside `consumer_team_id`
3. private Agent memory stays inside `consumer_agent_id`
4. `guide_trace_id` feedback rejects IDs absent from the exact persisted guide
   exposure, including IDs visible only in AgentContext
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

The raw observe response is write confirmation. The Agent receives guidance from
`/v1/guide`.

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
| `context_mode` | No | `full_power` for full product guide mode, or `compact_agent` for the same external path with a shorter Agent prompt. |
| `task_context_profile` | No | Agent-facing task posture for Runtime `agent_context.prompt_text`. Supported values: `general`, `coding_verifier`, `document_integrity`, `long_qa`, `multi_agent_handoff`, `loop_engineering`. |

`POST /v1/guide` uses semantic recall, so a configured embedding provider is
required for normal product use.

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `guide_trace_id` | Host / measure / audit | Stable id for the persisted guide exposure ledger. Pass it back during feedback attribution. |
| `consumer_agent_id` / `consumer_team_id` | Host / SDK helper | Consumer identity used for private/team memory visibility and feedback attribution. `consumer_team_id` is present only when supplied. |
| `agent_context` | Agent / host prompt builder | Default product output. |
| `feedback_attribution_v1` | Host / SDK helper | Exact persisted feedback items and their served surfaces. `status: unavailable` blocks `feedbackFromGuide()`; this host-only field is never Agent prompt content. |
| `memory_packet` | Host / measure / audit | Returned only with `include_packets: true`. |
| `guide_packet` | Host / measure / audit | Returned only with `include_packets: true`. |
| `source_map` | Developer | Routes and omitted internal surfaces. |

### Agent-Facing Fields

SDK hosts should pass top-level `agent_prompt`. Direct HTTP hosts may render
`agent_context.prompt_text`, or use these structured fields:

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
14. `command_posture`
15. `risk`

`command_posture` is the external instruction layer for hosts and Agents. It
uses `must_not`, `should_continue`, `inspect_first`, `rehydrate_first`, and
`optional_context` after Aionis has already applied lifecycle, authority,
premise, and rehydration gates. It gives the Agent a bounded control layer
instead of a free-form summary while preserving Runtime admission.

Keep `memory_packet`, `guide_packet`, `memory_decision_trace`,
`memory_decision_audit`, raw rows, and raw slots on host/operator surfaces by
default.
Keep the complete source guide, including `guide_trace_id`,
`feedback_attribution_v1`, and consumer identity, in the host run record. Raw
HTTP Runtime feedback uses the trace ID to reload the persisted ledger; the SDK
helper also requires the immutable attribution envelope. AgentContext memory
IDs may be retained for trace correlation, but cannot authorize feedback.

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
internally combines semantic recall with the typed execution-evidence assembly
service, so:

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
`POST /v1/guide`. This uses the same external full-power product path as the
standard SDK guide default, but renders a shorter Agent-facing prompt. The
Runtime still returns the structured context fields needed for attribution and
audit:

1. `agent_context.agent_context_mode: "compact_agent"`
2. `use_now_memory_ids`
3. `inspect_before_use_memory_ids`
4. `do_not_use_memory_ids`
5. `rehydrate_hints`
6. optional packets and receipt/trace surfaces when requested

Compact mode preserves memory authority. If a memory is stale, failed,
contested, or rehydratable, it still belongs in `inspect_before_use`,
`do_not_use`, `rehydrate_hints`, or the corresponding `command_posture`;
compact mode changes how the safe Agent prompt is rendered.

`task_context_profile` gives the Agent a task-specific execution posture without
changing recall, lifecycle, authority, storage, or admission decisions. Use it
when the same Runtime needs to serve different host loops:

- `coding_verifier`: preserve acceptance checks, verifier output, and tested
  execution boundaries.
- `document_integrity`: preserve file identity, filenames, original bytes, and
  requested output format.
- `long_qa`: prioritize covered evidence and source spans; rehydrate when the
  answer evidence is missing.
- `multi_agent_handoff`: preserve role ownership, current handoff state, and
  reviewer/verifier boundaries.
- `loop_engineering`: preserve loop plan, iteration state, validator result,
  repair attempt, and stop reason.

See [AIONIS_TASK_CONTEXT_PROFILES.md](AIONIS_TASK_CONTEXT_PROFILES.md) for the
full contract.

Example:

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "context_mode": "compact_agent",
  "task_context_profile": "coding_verifier",
  "query_text": "Continue checkout migration with verifier-backed acceptance checks.",
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

## Execution Context Through Guide

The former `/v1/execution/context/assemble` adapter is no longer registered.
Pass `execution_tree_v1`, execution scope fields, and `mode: "full_power"` to
`POST /v1/guide`; the Guide service invokes the same typed execution-evidence
assembler and returns the governed `agent_context`. Raw evidence and internal
traces remain service/operator data rather than a separate host-facing route.

## `POST /v1/memory/govern`

### Purpose

Govern candidate memories from any backend before they reach an Agent prompt.
This is the backend-agnostic admission gateway: candidates can come from an
external store first, and the route returns governed Agent context plus audit
surfaces.

Use this when a host already has memory candidates from Mem0, Zep, Pinecone,
Qdrant, pgvector, markdown, logs, or a company-specific memory store, but still
wants Aionis to decide which memories may direct the Agent.

The versioned decision table for this gateway is
[AIONIS_GOVERNANCE_POLICY_V1.md](AIONIS_GOVERNANCE_POLICY_V1.md).

### Minimal Request Fields

| Field | Required | Meaning |
|---|---:|---|
| `tenant_id` | No | Tenant identity. Defaults to the Runtime environment. |
| `scope` | No | Memory scope. Defaults to the Runtime environment. |
| `run_id` | No | Host run id for audit correlation. |
| `query_text` | Yes | What the Agent is about to do. |
| `mode` | No | `standard`, `strict`, or `firewall`. |
| `context_mode` | No | `standard` or `compact_agent`. |
| `candidates` | Yes | External memory candidates to govern. |
| `include_records` | No | Includes read-only admission records for host/operator logs. |

Each candidate uses:

```json
{
  "external_memory_id": "mem0:checkout-route",
  "source_backend": "mem0",
  "text": "The current accepted checkout migration target is packages/api/src/checkout.ts.",
  "metadata": {
    "title": "Current checkout target",
    "target_files": ["packages/api/src/checkout.ts"]
  },
  "authority": {
    "source_trust": "trusted",
    "scope": "project",
    "evidence_requirement": "none"
  },
  "lifecycle_hint": "current",
  "evidence_refs": ["mem0:trace:1"]
}
```

`authority` defaults to unknown source trust and `inspect_before_use`.
`lifecycle_hint` defaults to `unknown`. That means unlabeled external memory is
safe by default: it can be shown for inspection, while direct Agent guidance
requires stronger trust and lifecycle evidence.

### Main Response Fields

| Field | Consumer | Meaning |
|---|---|---|
| `agent_context` | Agent / host prompt builder | External context compiled from external candidates. |
| `memory_use_receipt` | Host / operator | Read-only receipt of which external candidates were exposed or suppressed. |
| `memory_admission_records` | Host / operator | Returned when `include_records: true`; entries use `memory_origin: "external"` and preserve `source_backend`. |
| `memory_firewall` | Security / operator | Returned in `mode: "firewall"`; summarizes blocked, inspect, rehydrate, direct-use, and unsafe direct-use counts. |
| `admission_summary` | Developer / operator | Counts by admission action and backend. |
| `source_map` | Developer | Shows this route used `external_candidate_admission` and omitted `memory_write`. |

### Admission Rules

The gateway uses the same four Agent-facing surfaces as normal Aionis guide
output:

1. `use_now`
2. `inspect_before_use`
3. `do_not_use`
4. `rehydrate`

External memory enters `use_now` when semantic relevance is paired with trust,
current/procedure lifecycle, and `evidence_requirement: "none"`. Failed, stale,
contested, suppressed, archived, blocked, or rehydrate-required candidates are
routed away from direct Agent guidance.

`mode: "firewall"` is stricter than the standard gateway mode:

- failed, stale, and contested external candidates are routed to `do_not_use`
- unknown or untrusted candidates remain `inspect_before_use`
- rehydrate-required candidates remain `rehydrate`
- trusted current/procedure candidates may still enter `use_now`
- the response includes `memory_firewall` with `unsafe_direct_use_count`

See [Aionis Memory Firewall](AIONIS_MEMORY_FIREWALL.md) for the product-facing
contract and SDK example.

### Mem0 SDK Adapter

Use `governMem0SearchResults()` after a Mem0 search:

```ts
const governed = await aionis.governMem0SearchResults({
  query_text: "Continue from the current route while avoiding failed memories.",
  mem0_results: await mem0.search("current route", {
    user_id: "project-a",
    top_k: 10,
  }),
});
```

The adapter accepts the JSON shape Mem0 returns and keeps the Mem0 package
outside the Runtime dependency graph. It preserves common metadata fields:

- `external_memory_id` or row `id`
- `target_files` / `target_files_json`
- `evidence_refs` / `evidence_refs_json`
- `lifecycle_hint` / `lifecycle_state`
- `authority_source_trust`, `authority_scope`, and
  `authority_evidence_requirement`

If those fields are missing, the mapped candidate defaults to unknown source
trust and `inspect_before_use`. This keeps retrieved Mem0 text out of direct
Agent action unless the host or memory metadata supplies enough trust and state
evidence.

### Example

```json
{
  "tenant_id": "default",
  "scope": "payments-service",
  "run_id": "run-123",
  "query_text": "Continue checkout migration without reusing failed legacy branches.",
  "mode": "standard",
  "context_mode": "compact_agent",
  "include_records": true,
  "candidates": [
    {
      "external_memory_id": "mem0:current",
      "source_backend": "mem0",
      "text": "The current accepted target is packages/api/src/checkout.ts.",
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
      "text": "The old fullBundleEnvironment.ts route failed verification.",
      "authority": {
        "source_trust": "trusted",
        "scope": "project",
        "evidence_requirement": "none"
      },
      "lifecycle_hint": "failed"
    }
  ]
}
```

The first candidate may enter `use_now`. The failed candidate is downgraded to
`inspect_before_use` in standard mode and is never direct-use.

## `POST /v1/audit/flight-recorder`

### Purpose

Produce a read-only incident replay report that answers:

```text
What did the Agent know at decision time?
```

The report reconstructs:

- memory IDs exposed to the Agent
- which memories were direct-use, inspect-first, blocked, or rehydrate-first
- blocked or suppressed memories visible to the operator
- feedback attribution when supplied
- source coverage for trace, receipt, admission record, and operator snapshot

It includes memory IDs and governance surfaces while excluding raw prompt text,
raw memory rows, raw slots, and embedding vectors.

### Request

You can pass an already generated trace/snapshot:

```json
{
  "tenant_id": "default",
  "scope": "checkout-agent",
  "run_id": "run-123",
  "guide_trace_id": "guide-trace-123",
  "memory_decision_trace": { "...": "..." },
  "operator_snapshot": { "...": "..." },
  "feedback_result": {
    "run_id": "run-123",
    "outcome": "positive",
    "used_memory_ids": ["mem-current"]
  }
}
```

Or pass the same `product_trace` shape used by `/v1/measure`:

```json
{
  "tenant_id": "default",
  "scope": "checkout-agent",
  "run_id": "run-123",
  "product_trace": {
    "before_guide": { "...": "..." },
    "after_guide": { "...": "..." }
  }
}
```

### Response

```json
{
  "contract_version": "aionis_agent_flight_recorder_result_v1",
  "agent_flight_recorder": {
    "contract_version": "aionis_agent_flight_recorder_report_v1",
    "intended_use": "incident_replay_audit",
    "agent_prompt_included": false,
    "runtime_mutation": false,
    "agent_view": {
      "prompt_text_included": false,
      "use_now_memory_ids": ["mem-current"],
      "do_not_use_memory_ids": ["mem-failed"]
    },
    "blocked_or_suppressed": [],
    "attribution": {
      "present": true,
      "outcome": "positive",
      "used_memory_ids": ["mem-current"]
    }
  }
}
```

Use this route for incident review, customer support debugging, compliance
evidence, and post-run memory quality analysis. Do not pass the report back to
the Agent as prompt context.

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
| `used_surface` | Yes | Raw API surface claim. Non-neutral `inspect_before_use` or `do_not_use` requires a verified `host_use_receipt_v1`; ordinary SDK helpers derive the exact persisted surface and do not accept `explicit_host_assertion`. |
| `guide_trace_id` + `used_memory_ids` | Preferred | Lets Aionis verify attribution against exact persisted exposure items and served surfaces. AgentContext-only IDs are rejected. |
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

The product lifecycle and merge contract for rehydration is
[AIONIS_REHYDRATE_CONTRACT.md](AIONIS_REHYDRATE_CONTRACT.md).

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
forgetting/lifecycle paths. Use `/v1/forget` when the host or operator needs
explicit lifecycle control.

### Minimal Request Fields

| Field | Required | Meaning |
|---|---:|---|
| `operation` | Yes | `suppress`, `unsuppress`, `rehydrate`, or `activate`. Use `/v1/forget` when explicit lifecycle control is the product action. |
| `reason` | Yes | Why this lifecycle action is being taken. |
| `target` | No | `memory`, `archive`, `payload`, or `pattern`. |
| `memory_ids` / `node_ids` / `client_ids` | Conditional | Required for memory activation and many rehydrate operations. |
| `guide_trace_id` + `used_memory_ids` | Conditional | Preferred for feedback attribution after `/v1/guide`; Aionis verifies exact persisted exposure items and served surfaces. AgentContext-only IDs are rejected. |
| `anchor_id` / `anchor_uri` | Conditional | Required for pattern suppression or payload rehydration. |
| `run_id` | Conditional | Required for `activate` so feedback can be attributed to a real run. |
| `outcome` | Conditional | Required for `activate`; `positive`, `negative`, or `neutral`. |
| `used_surface` | Conditional | Required for `activate`. Non-neutral `inspect_before_use` or `do_not_use` requires a verified host-use receipt; `explicit_host_assertion` is a raw advanced-host assertion and is not synthesized by the SDK helper. |
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

The host should consume `forget_effect` and keep internal lifecycle rows or raw
slots on host/operator surfaces.

For sparse-feedback attribution, prefer `/v1/feedback`. The explicit
`operation: "activate"` form remains available for advanced callers. In either
case, `run_id`, `outcome`, and `used_surface` are required. Non-neutral feedback
must use `used_surface: "use_now"` or `used_surface: "explicit_host_assertion"`;
this is the attribution gate that prevents Aionis from blaming every recalled
memory for a run outcome.

Prefer passing `guide_trace_id` from `/v1/guide` plus `used_memory_ids`. Aionis
loads the persisted guide exposure ledger, rejects IDs that are not exact
persisted exposure items—including context-only IDs—and records persisted but
unused items as unattributed rather than blaming them for the run outcome.
Direct `memory_ids` remain accepted when the host already has a precise
attribution source, but `guide_trace_id` is the product path for normal
guide-to-feedback loops.

A single negative outcome without aligned verifier/tool/runtime evidence is
stored as a weak counter-signal. Authority changes require repeated weak
counter-signals, or one negative outcome backed by aligned evidence such as
`verifier_status: "failed"`, `tool_status: "failed"`, or concrete
`runtime_signal_refs`.

Aionis attributes run outcomes to recalled memory when the host reports that
memory as used.

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
is stored as weak evidence, and why repeated weak or
verifier/tool/runtime-aligned negative feedback moves memory to
`inspect_before_use`.
When feedback is tied to a `guide_trace_id`, the trace also reports exposure
counts and surface-level `unattributed_*_memory_ids` so developers can audit
which shown memories were unused by that run. These fields are read-only
observability; authority, suppression, and feedback-slot writes stay on their
dedicated lifecycle paths.
`unused_exposure_observation` adds the repeated-exposure view: it identifies
memories that were shown across multiple guide traces but not host-marked as
used in the current activation, and separately lists the subset with no positive
attributed use recorded. The observation object is still read-only evidence for
product debugging. When formal guide-attributed feedback contains unused
exposure, its episode facts and deterministic durable control job commit in one
SQLite transaction. `forget_effect.guide_trace.feedback_learning_control`
reports only `learning_control_status: queued|already_completed`; it does not
claim that `feedback_learning_control_posture` changed synchronously. The
Runtime worker leases the job, recomputes repeated-unused-without-positive facts
at the source feedback cutoff for the same consumer cohort, and atomically
writes its audit commit, operation receipt, posture effect or legal no-op, and
terminal job state. Exhausted jobs remain retained. Successful safety
terminalization moves them to `dead_letter` with an independent pause for
enrolled sources; if pause/authority persistence fails, the exhausted lease is
deferred and readiness fails closed. Historical markerless feedback is not
retroactively enqueued and omits `feedback_learning_control`.
An applied posture is direct-reuse control until the Agent or host
inspects/revalidates the memory. A later positive attributed use clears it.
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
measure/debug/audit surfaces.
`effect_report.feedback_signal_summary` gives the same signal ids in product
summary form, so product dashboards can show positive attribution, weak/strong
counter-signals, and repeated unused exposure without parsing the full trace.
It also keeps `authority_mutation: false`; authority changes remain external by
the underlying feedback/forgetting mechanisms, not by this report field.
`confidence_decay_candidate_summary` is the Direction 2 shadow view: it lists
memories that may deserve lower future reliance, memories protected by positive
attribution, drift-only observations, and temporal staleness candidates. Time
decay is based on old active trusted/advisory memory still exposed to the Agent,
relative to the freshest scoped observed memory. It is still measure/debug/audit
only; lifecycle changes remain on dedicated feedback and forgetting paths.
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
4. Debug and audit outputs explain Aionis decisions for host/operator review.
5. Full packets are available for advanced integration, measurement, and audit,
   while `agent_context` stays the standard prompt payload.
6. Product API usage stays independent of any specific external Agent framework.
7. Runtime behavior changes through evidence-backed product paths.

## Related Documents

1. [AIONIS_PRODUCT_CONTRACT.md](AIONIS_PRODUCT_CONTRACT.md)
2. [AIONIS_PRODUCT_OUTPUT_CONTRACT.md](AIONIS_PRODUCT_OUTPUT_CONTRACT.md)
3. [AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md](AIONIS_AGENT_CONTEXT_AND_AUDIT_SURFACES.md)
4. [AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md](AIONIS_OBSERVE_GUIDE_AUDIT_QUICKSTART.md)
