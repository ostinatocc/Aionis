# @aionis/sdk

TypeScript SDK facade for Aionis Runtime.

```bash
npm install @aionis/sdk
```

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
  scope: "my-agent",
});

const guide = await aionis.guide({
  query_text: "Continue the task.",
  consumer_agent_id: "agent-1",
  limit: 8,
  include_packets: true,
});

const agentPrompt = agentPromptFromGuide(guide);

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
