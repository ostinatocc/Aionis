# Aionis SDK Quickstart

Status: developer-facing SDK quickstart for the focused local Runtime

This quickstart shows the smallest SDK product loop:

```text
remember -> guide -> agent prompt -> feedback -> measure -> snapshot
```

It does not add a new Runtime mechanism, external Agent framework, UI, or
benchmark runner. It uses the existing product facade through `src/sdk.ts`.

## Start Runtime

`guide()` uses semantic recall, so configure an embedding provider before
starting the Runtime or before running the quickstart script.

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
  agentPromptFromGuide,
  createAionisClient,
  feedbackFromGuide,
  measureInputFromGuideLoop,
  snapshotInputFromGuideLoop,
} from "./src/sdk.ts";

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

const guide = await aionis.guide<{
  guide_trace_id: string;
  agent_context: {
    prompt_text: string;
    use_now_memory_ids: string[];
  };
}>({
  query_text: "Continue the product update.",
  consumer_agent_id: "agent-1",
  limit: 8,
  include_packets: true,
});

const agentPromptContext = agentPromptFromGuide(guide);

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

await aionis.snapshot(snapshotInputFromGuideLoop({
  run_id: "run-001",
  task_signature: "product-update",
  task_family: "developer_sdk",
  guide,
  measure_result: measure,
  include_markdown: true,
}));
```

Give only `agentPromptContext` or selected `agent_context` fields to the Agent.
Keep `guide_trace_id` and `use_now_memory_ids` in host state for attribution.
Do not pass `memory_packet`, `guide_packet`, `memory_decision_trace`,
`memory_decision_audit`, raw rows, or raw slots to the Agent by default.
`feedbackFromGuide()` still requires the host to provide the memory IDs the
Agent actually used; it only validates that those IDs were exposed by the guide.
`measureInputFromGuideLoop()` and `snapshotInputFromGuideLoop()` keep the
normal product trace and operator snapshot payloads out of handwritten app code.

## What The Script Proves

`npm run -s runtime:quickstart:sdk` runs a real Runtime loop and prints compact
JSON showing:

1. a fresh guide starts without actionable history
2. `remember(kind: "preference")` creates ordinary preference memory, not an
   executable policy rule
3. `remember(kind: "project_context")` creates ordinary project memory
4. `guide()` returns compact `agent_context` with direct-use memory IDs
5. `feedback()` attributes outcome only to memory exposed by that guide trace
6. `measure()` reports whether history changed the future context
7. `snapshot()` exposes read-only memory use receipt and effect state

For multi-agent execution memory, use:

```bash
npm run -s runtime:quickstart:multi-agent
```

The multi-agent quickstart uses the same SDK client, plus
`createExecutionMemoryAdapter` and `createMultiAgentHostTemplate`.
