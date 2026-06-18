# Aionis SDK Quickstart

Status: developer-facing SDK quickstart for the focused local Runtime

This quickstart shows the smallest SDK product loop:

```text
remember -> guide -> compileExecutionAgentContext -> agent prompt -> feedback -> measure -> snapshot
```

It does not add a new Runtime mechanism, external Agent framework, UI, or
benchmark runner. It uses the existing product facade through `src/sdk.ts`.

## Start Runtime

`guide()` uses semantic recall, so configure an embedding provider before
starting the Runtime or before running the quickstart script.

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
  compileExecutionAgentContext,
  createAionisClient,
  feedbackFromGuide,
  memoryAdmissionDatasetJsonlFromRows,
  memoryAdmissionDatasetRowsFromRecord,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop,
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

const guide = await aionis.execution.guideForRole<{
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
  context_mode: "compact_agent",
});

const agentContext = compileExecutionAgentContext({
  guide,
  task: {
    run_id: "run-001",
    task_signature: "product-update",
    query_text: "Continue the product update.",
  },
  budget_profile: "balanced",
});

// Your host runs the Agent with agentContext.agent_prompt.

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

For coding and multi-agent hosts, give only `agentContext.agent_prompt` from
`compileExecutionAgentContext()` to the Agent. Keep `guide_trace_id`,
`use_now_memory_ids`, and `agentContext.memory_use_receipt` in host state for
attribution and audit. Do not pass `memory_packet`, `guide_packet`,
`memory_decision_trace`, `memory_decision_audit`, raw rows, or raw slots to the
Agent by default.
For a focused JSONL export path, see
[AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md](AIONIS_ADMISSION_DATASET_EXPORT_QUICKSTART.md).
`feedbackFromGuide()` still requires the host to provide the memory IDs the
Agent actually used; it inherits the guide consumer identity when available and
validates that those IDs were exposed by the guide.
`measureInputFromGuideLoop()` and `snapshotInputFromGuideLoop()` keep the
normal product trace and operator snapshot payloads out of handwritten app code.

## Memory Firewall For Mem0

If your app already uses Mem0, do not write Mem0 results into Aionis first. Keep
Mem0 as retrieval, then let Aionis govern admission:

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

// Give the Agent only the governed prompt/context.
await agent.run(governed.agent_context.prompt_text);

// Keep these in host/operator logs.
log.write({
  memory_firewall: governed.memory_firewall,
  memory_use_receipt: governed.memory_use_receipt,
  memory_admission_records: governed.memory_admission_records,
});
```

`governMem0SearchResults()` defaults to firewall mode, compact Agent context,
and admission records. It accepts plain Mem0 JSON, so `@aionis/sdk` does not add
Mem0 as a dependency. Unlabeled Mem0 rows are inspect-first by default; direct
use requires trusted authority metadata plus `lifecycle_hint: "current"` or
`"procedure"`.

## Execution Helper Loop

For execution memory, use `aionis.execution` so the host does not need to build
execution payloads by hand:

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

const guide = await aionis.execution.guideForRole({
  agent_id: "reviewer-1",
  team_id: "checkout-team",
  role: "reviewer",
  run_id: "run-001",
  task_signature: "checkout-migration",
  query_text: "Continue from the current verified execution path.",
});

const context = aionis.execution.compileAgentContext({
  guide,
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

`npm run -s runtime:quickstart:sdk` runs a real Runtime loop and prints compact
JSON showing:

1. a fresh guide starts without actionable history
2. `remember(kind: "preference")` creates ordinary preference memory, not an
   executable policy rule
3. `remember(kind: "project_context")` creates ordinary project memory
4. `guide()` returns compact `agent_context` with direct-use memory IDs
5. `compileExecutionAgentContext()` renders the SDK execution contract prompt
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
