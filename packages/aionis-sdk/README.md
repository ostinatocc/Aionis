# @aionis/sdk

TypeScript SDK facade for Aionis Runtime.

```bash
npm install @aionis/sdk
```

```ts
import {
  agentPromptFromGuide,
  commandPostureFromGuide,
  createAionisClient,
  feedbackFromGuide,
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

const agentPrompt = agentPromptFromGuide(guide);
const commandPosture = commandPostureFromGuide(guide);
const mustNotMemoryIds = mustNotMemoryIdsFromGuide(guide);
const shouldContinueMemoryIds = shouldContinueMemoryIdsFromGuide(guide);

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
packets, traces, receipts, raw slots, and operator snapshots in host logs.
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

const compactPrompt = agentPromptFromGuide(compactGuide);
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
