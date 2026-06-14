# @aionis/sdk

TypeScript SDK facade for Aionis Runtime.

```bash
npm install @aionis/sdk
```

```ts
import {
  compileExecutionAgentContext,
  commandPostureFromGuide,
  createAionisClient,
  feedbackFromGuide,
  memoryAdmissionDatasetJsonlFromGuide,
  memoryAdmissionRecordFromGuide,
  measureInputFromGuideLoop,
  mustNotMemoryIdsFromGuide,
  shouldContinueMemoryIdsFromGuide,
  snapshotInputFromGuideLoop,
} from "@aionis/sdk";

const aionis = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  apiKey: process.env.AIONIS_API_KEY,
  tenant_id: "default",
  scope: "my-agent",
});

const guide = await aionis.guide({
  query_text: "Continue the task.",
  consumer_agent_id: "agent-1",
  limit: 8,
  include_packets: true,
});

const context = compileExecutionAgentContext({
  guide,
  task: "Continue the task.",
  budget_profile: "balanced",
});
const agentPrompt = context.agent_prompt;
const commandPosture = commandPostureFromGuide(guide);
const mustNotMemoryIds = mustNotMemoryIdsFromGuide(guide);
const shouldContinueMemoryIds = shouldContinueMemoryIdsFromGuide(guide);
const admissionRecord = memoryAdmissionRecordFromGuide(guide);
const admissionDatasetJsonl = memoryAdmissionDatasetJsonlFromGuide(guide, {
  run_id: "run-001",
  task_signature: "first-integration",
});

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
    task_signature: "first-integration",
  },
  after_guide: guide,
  feedback_result: feedback,
  sufficient_evidence: true,
}));

await aionis.snapshot(snapshotInputFromGuideLoop({
  run_id: "run-001",
  task_signature: "first-integration",
  guide,
  measure_result: measure,
}));
```

Only pass `agentPrompt` or selected `agent_context` fields to your Agent. Keep
packets, traces, receipts, admission records, raw slots, and operator snapshots
in host logs.
Use `commandPostureFromGuide()` when the host wants structured execution
instructions: `must_not` blocks failed or stale branches, `should_continue`
biases the Agent toward active state or accepted procedure, `inspect_first`
keeps candidate history out of direct action, and `rehydrate_first` asks the
host to recover raw payload before exact use.

For token-sensitive Agent calls, request compact prompt rendering:

```ts
const compactGuide = await aionis.guide({
  query_text: "Continue the task without repeating failed work.",
  consumer_agent_id: "agent-1",
  context_mode: "compact_agent",
});

const compactPrompt = compileExecutionAgentContext({
  guide: compactGuide,
  budget_profile: "compact",
}).agent_prompt;
```

`context_mode: "compact_agent"` keeps SDK guide defaults on the governed
full-power path while shortening only `agent_context.prompt_text`.

## Execution Memory Helpers

Use `aionis.execution` when the host wants branch-aware execution memory without
hand-writing low-level payloads.

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
  context_mode: "compact_agent",
});

const context = compileExecutionAgentContext({
  guide,
  task: {
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

`compileExecutionAgentContext` is the recommended product path for coding and
multi-agent hosts. It converts the governed Runtime `guide` into a contract
prompt plus structured adapter state:

- active route targets and pending artifacts
- reference-only and blocked direction targets
- `use_now`, `inspect_before_use`, `do_not_use`, and `rehydrate` memory IDs
- a compact Memory Use Receipt for audit and feedback attribution
- a Memory Admission Record for per-memory admission dataset rows
- warnings when a host-observed active target is missing

This helper does not mutate Runtime state and does not expose raw packets to the
Agent. If an active target is missing, the rendered contract tells the Agent to
treat the target as pending work instead of falling back to a blocked or
reference-only path that happens to exist.

For a host loop, the most common posture helpers are:

```ts
const mustNot = mustNotMemoryIdsFromGuide(guide);
const shouldContinue = shouldContinueMemoryIdsFromGuide(guide);
const posture = commandPostureFromGuide(guide);
const route = routeContractFromGuide(guide);
const evidence = evidenceSourcesFromGuide(guide);
const blocked = blockedRoutesFromGuide(guide);
```

These helpers read only `agent_context`. They do not expose `memory_packet`,
`guide_packet`, traces, or operator-only evidence to the Agent.
`routeContractFromGuide` exposes the structured execution contract:
`active_targets` are the continuation route, `pending_artifacts` describe
missing-active-target handling, `evidence_sources` are reference-only evidence,
and `blocked_routes` are counter-evidence only.

`memoryAdmissionRecordFromGuide(guide)` is the host/operator surface for the
read-only admission ledger. It records candidate memory IDs, admission actions,
prompt exposure, and feedback attribution without changing Runtime authority or
adding content to the Agent prompt.

`memoryAdmissionDatasetJsonlFromGuide(guide)` exports that ledger as JSONL rows
for host logs or a data lake. It keeps raw prompt text, raw memory payloads, and
embeddings out of the export while preserving enough admission/outcome fields to
audit decisions or train a future admission policy offline.

## Govern External Memory

Use `governMemory()` when your host already has candidates from Mem0, Zep,
Pinecone, pgvector, markdown, logs, or another memory backend, but still wants
Aionis to decide which memory may direct the Agent.

```ts
const result = await aionis.governMemory({
  query_text: "Continue the checkout migration without reusing failed branches.",
  mode: "firewall",
  include_records: true,
  candidates: [
    {
      external_memory_id: "mem0:current-route",
      source_backend: "mem0",
      text: "Current accepted target is packages/api/src/checkout.ts.",
      authority: {
        source_trust: "trusted",
        scope: "project",
        evidence_requirement: "none",
      },
      lifecycle_hint: "current",
    },
    {
      external_memory_id: "zep:failed-route",
      source_backend: "zep",
      text: "The legacy route failed verifier checks.",
      authority: {
        source_trust: "trusted",
        scope: "project",
        evidence_requirement: "none",
      },
      lifecycle_hint: "failed",
    },
  ],
});

const prompt = result.agent_context.prompt_text;
const firewall = result.memory_firewall;
```

`mode: "firewall"` blocks failed, stale, contested, suppressed, archived, or
policy-blocked external memory from direct action. Unknown or untrusted memory
stays `inspect_before_use`; raw evidence pointers stay `rehydrate`.

## Replay Agent Decisions

Use `flightRecorder()` after a run to inspect what memory the Agent was allowed
to see at decision time.

```ts
const replay = await aionis.flightRecorder({
  run_id: "run-001",
  guide_trace_id: guide.guide_trace_id,
  product_trace: {
    before_guide: previousGuide,
    after_guide: guide,
  },
  feedback_result: {
    run_id: "run-001",
    outcome: "positive",
    used_memory_ids: guide.agent_context.use_now_memory_ids.slice(0, 1),
  },
});

console.log(replay.agent_flight_recorder.agent_view.use_now_memory_ids);
```

The report excludes `agent_context.prompt_text` and raw memory payloads. Keep it
in host/operator logs for incident replay, support debugging, and memory-quality
review.
