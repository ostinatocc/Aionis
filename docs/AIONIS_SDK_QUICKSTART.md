# Aionis SDK Quickstart

Status: developer-facing quickstart for the Runtime v0.3.11 development train
and SDK v0.3.19 (Local Runtime Public Beta maturity)

This quickstart shows the smallest SDK product loop:

```text
remember/observe -> guideAgentContext -> agent_prompt -> feedback -> measure -> snapshot
```

It uses the existing product facade through `src/sdk.ts` and the published
`@aionis/sdk` package.

SDK source: [ostinatocc/aionis-sdk](https://github.com/ostinatocc/aionis-sdk).
The Runtime source in [ostinatocc/Aionis](https://github.com/ostinatocc/Aionis)
owns the product HTTP APIs that the SDK calls.

## AgentContext Prompt Boundary

The SDK default final Agent prompt is:

```text
AIONIS_EXECUTION_AGENT_CONTEXT v1
```

Runtime `POST /v1/guide -> agent_context.prompt_text` has its own renderings:

| Runtime mode | Header | Use |
|---|---|---|
| standard | `AIONIS_AGENT_CONTEXT v1` | Raw HTTP hosts that pass Runtime guide text directly. |
| compact | `AIONIS_CTX v2` | Explicit low-token Runtime prompt mode. |

Do not append Runtime `agent_context.prompt_text` to SDK `agent_prompt`.
`guideAgentContext()` and `execution.guideAgentContextForRole()` compile the
Runtime fields into one SDK prompt by default. `context_mode: "compact_agent"`
asks Runtime for compact base guide text; it does not change the SDK final
prompt format. Set `prompt_format: "runtime_compact"` only when the host
intentionally wants Runtime `agent_context.prompt_text` as the final prompt.

## Start Runtime

`guide()` uses semantic recall, so configure an embedding provider before
starting the Runtime or before running the quickstart script.

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

Then run:

```bash
npm install
npm run -s runtime:quickstart:sdk
```

If `AIONIS_PRODUCT_E2E_BASE_URL`, `AIONIS_BASE_URL`, or `AIONIS_URL` is set,
the quickstart uses that Runtime. Otherwise it starts an isolated local Runtime
on a random port.

## Minimal SDK Loop

```ts
import {
  createAionisClient,
  feedbackAttributionFromGuide,
  feedbackFromGuide,
  memoryAdmissionDatasetJsonlFromRows,
  memoryAdmissionDatasetRowsFromRecord,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop,
  traceDerivedSkillCandidatesFromMeasure,
  traceDerivedSkillReviewItemsFromMeasure,
  type AionisGuideFeedbackAttributionV1,
  type AionisMemoryAdmissionRecord,
} from "@aionis/sdk";

const aionis = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  apiKey: process.env.AIONIS_API_KEY,
  tenant_id: "default",
  scope: "my-agent-scope",
});

await aionis.remember({
  kind: "preference",
  text: "Prefer concise product updates with concrete next steps.",
  memory_lane: "private",
  owner_agent_id: "agent-1",
});

const context = await aionis.execution.guideAgentContextForRole<{
  tenant_id: string;
  scope: string;
  guide_trace_id: string;
  feedback_attribution_v1: AionisGuideFeedbackAttributionV1;
  agent_context: {
    prompt_text: string;
    use_now_memory_ids: string[];
  };
}>({
  agent_id: "agent-1",
  run_id: "run-001",
  task_signature: "product-update",
  query_text: "Continue the product update.",
  limit: 8,
  include_packets: true,
}, undefined, {
  budget_profile: "balanced",
});

const guide = context.guide;

// Your host runs the Agent with context.agent_prompt. Instrument the Agent/tool
// execution so this result contains only memory IDs that were actually used.
const agentResult = await runInstrumentedAgent(context.agent_prompt);

let feedback: unknown = null;
if (agentResult.used_memory_ids.length > 0) {
  const attribution = feedbackAttributionFromGuide(guide);
  if (attribution.status !== "available") {
    throw new Error(
      `Feedback attribution is unavailable (${attribution.reason_code}); `
      + "request a new guide instead of falling back to agent_context IDs.",
    );
  }

  feedback = await aionis.feedback(feedbackFromGuide({
    guide,
    reason: "Host instrumentation verified successful memory use.",
    run_id: "run-001",
    outcome: "positive",
    used_memory_ids: agentResult.used_memory_ids,
  }));
}

// Allocate this once for the logical measure write and persist it with the
// host job before the first request.
const measureOperationId = "measure:task-001:run-001:attempt-1";
const measureRequest = measureInputFromGuideLoop({
  operation_id: measureOperationId,
  task: {
    task_id: "task-001",
    run_id: "run-001",
    task_signature: "product-update",
    task_family: "developer_sdk",
  },
  after_guide: guide,
  feedback_result: feedback,
});
const measure = await aionis.measure(measureRequest);

// If the transport outcome is unknown, retry aionis.measure(measureRequest)
// unchanged. Do not allocate another operation_id or mutate the request.

// Client evidence claims do not open the export gate. Inspect the Runtime-owned
// assessment before treating any training candidate as exportable.
console.log(measure.evidence_assessment);

if (measure.evidence_assessment.eligible_for_skill_export) {
  const traceSkillCandidates = traceDerivedSkillCandidatesFromMeasure(measure);
  for (const candidate of traceSkillCandidates) {
    // Review/export only. This payload is not Agent prompt context.
    console.log(candidate.trace_derived_skill.skill_name);
  }

  const traceSkillReviewItems = traceDerivedSkillReviewItemsFromMeasure(measure);
  for (const item of traceSkillReviewItems) {
    // Compact review queue item. Still read-only and candidate-only.
    console.log(item.skill_name, item.review_action, item.safety.required_gate);
  }
}

const admissionRows = memoryAdmissionDatasetRowsFromRecord(
  measure.memory_decision_trace.admission_record as AionisMemoryAdmissionRecord,
  {
    run_id: "run-001",
    task_id: "task-001",
    task_signature: "product-update",
  },
);
const admissionDatasetJsonl = memoryAdmissionDatasetJsonlFromRows(admissionRows);
// Keep admissionDatasetJsonl in host/operator logs, not in the Agent prompt.

await aionis.snapshot(snapshotInputFromGuideLoop({
  run_id: "run-001",
  task_signature: "product-update",
  task_family: "developer_sdk",
  guide,
  measure_result: measure,
  include_markdown: true,
}));
```

For coding and multi-agent hosts, give `context.agent_prompt` from
`guideAgentContext()` or `execution.guideAgentContextForRole()` to the Agent.
Keep the complete guide response, including top-level
`feedback_attribution_v1`, plus `guide_trace_id`, AgentContext ID lists, and
`context.compiled_context.memory_use_receipt` in host state for correlation and
audit. AgentContext IDs describe visibility only; they are neither actual-use
evidence nor feedback authorization. Packets, traces, admission records, raw
rows, and raw slots are host/operator surfaces.
For a focused JSONL export path, see
[AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md](AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md).
`feedbackFromGuide()` requires the complete source guide and the memory IDs
reported as actually used by an instrumented host Agent/tool trace. It inherits
the guide consumer identity when available, validates the IDs against the
persisted `feedback_attribution_v1`, and derives their served surface. If the
host reports zero used IDs, do not submit feedback. If attribution is
unavailable, request a new guide; never fall back to AgentContext IDs.
`measureInputFromGuideLoop()` and `snapshotInputFromGuideLoop()` keep the
normal product trace and operator snapshot payloads out of handwritten app code.
For measure, allocate and persist one stable `operation_id` before the first
attempt. An exact retry must reuse the same request object and ID; a changed
request needs a new ID. The protected response carries the same `operation_id`,
an immutable `measurement_id` and `measurement_digest`, and
`measurement_persisted: true`. This evidence persistence does not itself mutate
memory posture or authorize candidate promotion.
`traceDerivedSkillCandidatesFromMeasure()` exposes Runtime-verified positive
execution traces as raw controlled skill candidates only after the evidence
assessment opens the export gate. `traceDerivedSkillReviewItemsFromMeasure()`
projects the same eligible data into compact review queue items. Both remain
`agent_prompt_included: false` and `runtime_mutation: false`; later use must
pass the normal admission and promotion gates.

## Memory Firewall For Mem0

If your app already uses Mem0, keep Mem0 as retrieval and let Aionis govern
admission:

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

// This is the Memory Firewall prompt for external candidates only.
// For normal task execution, prefer guideAgentContext().agent_prompt.
await agent.run(governed.agent_context.prompt_text);

// Keep these in host/operator logs.
log.write({
  memory_firewall: governed.memory_firewall,
  memory_use_receipt: governed.memory_use_receipt,
  memory_admission_records: governed.memory_admission_records,
});
```

`governMem0SearchResults()` defaults to firewall mode, compact Agent context,
and admission records. It accepts plain Mem0 JSON and keeps Mem0 as the
retrieval backend. Unlabeled Mem0 rows are inspect-first by default; direct use
requires trusted authority metadata plus `lifecycle_hint: "current"` or
`"procedure"`.

## Execution Helper Loop

For execution memory, use `aionis.execution` so the host gets typed helpers for
execution payloads, guide calls, feedback, measure, and snapshot:

```ts
await aionis.execution.observeStep({
  agent_id: "worker-1",
  run_id: "run-001",
  task_signature: "checkout-migration",
  title: "Implement checkout adapter",
  summary: "Worker implemented the adapter and needs review.",
  outcome: "succeeded",
  target_files: ["src/checkout.ts"],
});

const context = await aionis.execution.guideAgentContextForRole({
  agent_id: "reviewer-1",
  team_id: "checkout-team",
  role: "reviewer",
  run_id: "run-001",
  task_signature: "checkout-migration",
  query_text: "Continue from the current verified execution path.",
}, undefined, {
  task: {
    run_id: "run-001",
    task_signature: "checkout-migration",
    query_text: "Continue from the current verified execution path.",
  },
  repo_state: {
    existing_files: ["src/checkout.ts"],
  },
  budget_profile: "balanced",
});

// Your host runs the Agent with context.agent_prompt. The result comes from
// instrumented Agent/tool execution, never from agent_context ID lists.
const agentResult = await runInstrumentedAgent(context.agent_prompt);
const guide = context.guide;

if (agentResult.used_memory_ids.length > 0) {
  const attribution = feedbackAttributionFromGuide(guide);
  if (attribution.status !== "available") {
    throw new Error(
      `Feedback attribution is unavailable (${attribution.reason_code}); `
      + "request a new guide instead of falling back to agent_context IDs.",
    );
  }

  await aionis.execution.feedbackFromOutcome({
    agent_id: "reviewer-1",
    run_id: "run-001",
    task_signature: "checkout-migration",
    title: "Reviewer continued branch",
    summary: "Host instrumentation verified use of current execution memory.",
    outcome: agentResult.status,
    guide,
    used_memory_ids: agentResult.used_memory_ids,
  });
}
```

For a complete minimal loop, see
[docs/examples/minimal-agent.ts](examples/minimal-agent.ts).

## What The Script Proves

`npm run -s runtime:quickstart:sdk` runs a real Runtime loop and prints bounded
JSON showing:

1. a fresh guide starts without actionable history
2. `remember(kind: "preference")` creates ordinary preference memory
3. `remember(kind: "project_context")` creates ordinary project memory
4. `guideAgentContext()` returns SDK `agent_prompt` plus the underlying guide
5. `compiled_context` exposes route and receipt metadata for host/operator logic
6. `feedback()` attributes outcome only to host-instrumented actual-use IDs
   authorized by the guide's persisted `feedback_attribution_v1`
7. the Runtime-governed `read` selection is executed against this quickstart
   document before protected positive tool feedback is recorded
8. the Runtime executes `npm run -s typecheck` itself; caller-supplied
   `sufficient_evidence: false` remains ignored while exact episode-ledger
   feedback authority can still verify the product trace
9. `measure()` replays a protected operation identity, persists the immutable
   measurement, and binds the verified effect to distinct baseline/after episodes
10. admission dataset JSONL export is produced without prompt payload
11. `snapshot()` exposes read-only memory use receipt, admission record, and effect state

For multi-agent execution memory, use:

```bash
npm run -s runtime:quickstart:multi-agent
```

The multi-agent quickstart uses the same SDK client, plus
`createExecutionMemoryAdapter` and `createMultiAgentHostTemplate`.
