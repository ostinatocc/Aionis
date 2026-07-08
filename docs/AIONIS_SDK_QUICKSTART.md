# Aionis SDK Quickstart

Status: developer-facing SDK quickstart for the focused local Runtime

This quickstart shows the smallest SDK product loop:

```text
remember/observe -> guideAgentContext -> agent_prompt -> feedback -> measure -> snapshot
```

It uses the existing product facade through `src/sdk.ts` and the published
`@aionis/sdk` package.

SDK source: [ostinatocc/aionis-sdk](https://github.com/ostinatocc/aionis-sdk).
The Runtime source in [ostinatocc/Aionis](https://github.com/ostinatocc/Aionis)
owns the product HTTP APIs that the SDK calls.

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
  feedbackFromGuide,
  memoryAdmissionDatasetJsonlFromRows,
  memoryAdmissionDatasetRowsFromRecord,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop,
  traceDerivedSkillCandidatesFromMeasure,
  traceDerivedSkillReviewItemsFromMeasure,
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
  guide_trace_id: string;
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

// Your host runs the Agent with context.agent_prompt.

const feedback = await aionis.feedback(feedbackFromGuide({
  guide,
  reason: "Agent used the exposed memory successfully.",
  run_id: "run-001",
  outcome: "positive",
  used_memory_ids: guide.agent_context.use_now_memory_ids.slice(0, 1),
}));

const measure = await aionis.measure(measureInputFromGuideLoop({
  task: {
    task_id: "task-001",
    run_id: "run-001",
    task_signature: "product-update",
    task_family: "developer_sdk",
  },
  after_guide: guide,
  feedback_result: feedback,
  sufficient_evidence: true,
  evidence_ids: ["feedback:run-001"],
}));

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

// After the host queues and promotes a candidate through the review API, the
// SDK can materialize it into a draft and explicitly commit the recommended
// observe payload. Materialize itself does not write memory.
const materialized = await aionis.materializeSkillCandidate("skillcand_...");
console.log(materialized.draft.contract_version);
await aionis.observeMaterializedSkillCandidate(materialized);

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
Keep `guide_trace_id`, `use_now_memory_ids`, and
`context.compiled_context.memory_use_receipt` in host state for
attribution and audit. Packets, traces, admission records, raw rows, and raw
slots are host/operator surfaces.
For a focused JSONL export path, see
[AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md](AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md).
`feedbackFromGuide()` still requires the host to provide the memory IDs the
Agent actually used; it inherits the guide consumer identity when available and
validates that those IDs were exposed by the guide.
`measureInputFromGuideLoop()` and `snapshotInputFromGuideLoop()` keep the
normal product trace and operator snapshot payloads out of handwritten app code.
`traceDerivedSkillCandidatesFromMeasure()` exposes positive execution traces as
raw controlled skill candidates. `traceDerivedSkillReviewItemsFromMeasure()`
projects the same data into compact review queue items. Both remain
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

// Your host runs the Agent with context.agent_prompt.
const guide = context.guide;

const feedback = await aionis.execution.feedbackFromOutcome({
  agent_id: "reviewer-1",
  run_id: "run-001",
  task_signature: "checkout-migration",
  title: "Reviewer continued branch",
  summary: "Reviewer used the current execution memory.",
  outcome: "succeeded",
  guide,
  used_memory_ids: guide.agent_context.use_now_memory_ids.slice(0, 1),
});
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
6. `feedback()` attributes outcome only to memory exposed by that guide trace
7. `measure()` reports whether history changed the future context
8. admission dataset JSONL export is produced without prompt payload
9. `snapshot()` exposes read-only memory use receipt, admission record, and effect state

For multi-agent execution memory, use:

```bash
npm run -s runtime:quickstart:multi-agent
```

The multi-agent quickstart uses the same SDK client, plus
`createExecutionMemoryAdapter` and `createMultiAgentHostTemplate`.
