import {
  compileExecutionAgentContext,
  createAionisClient,
} from "@aionis/sdk";

type MinimalGuide = {
  guide_trace_id: string;
  agent_context: {
    prompt_text: string;
    use_now_memory_ids?: string[];
  };
};

const runId = `minimal-agent-${Date.now()}`;
const taskSignature = "minimal-agent-demo";

const aionis = createAionisClient({
  baseUrl: process.env.AIONIS_URL ?? "http://127.0.0.1:3001",
  apiKey: process.env.AIONIS_API_KEY,
  tenant_id: "default",
  scope: `demo:${runId}`,
});

await aionis.remember({
  kind: "preference",
  text: "Prefer short answers with concrete next steps.",
  memory_lane: "private",
  owner_agent_id: "agent-1",
});

await aionis.execution.observeStep({
  agent_id: "agent-1",
  run_id: runId,
  task_signature: taskSignature,
  title: "Initial implementation attempt",
  summary: "The Agent created the first implementation path and needs review.",
  outcome: "unknown",
  target_files: ["src/example.ts"],
});

const guide = await aionis.execution.guideForRole<MinimalGuide>({
  agent_id: "agent-1",
  role: "reviewer",
  run_id: runId,
  task_signature: taskSignature,
  query_text: "Continue the implementation from the current state.",
  context_mode: "compact_agent",
});

const context = compileExecutionAgentContext({
  guide,
  task: {
    run_id: runId,
    task_signature: taskSignature,
    query_text: "Continue the implementation from the current state.",
  },
  repo_state: {
    existing_files: ["src/example.ts"],
  },
  budget_profile: "balanced",
});

// Your host runs the Agent here with context.agent_prompt.
const agentResult = {
  status: "succeeded" as const,
  used_memory_ids: guide.agent_context.use_now_memory_ids?.slice(0, 1) ?? [],
};

const feedback = await aionis.execution.feedbackFromOutcome({
  agent_id: "agent-1",
  run_id: runId,
  task_signature: taskSignature,
  title: "Agent completed the next step",
  summary: "The Agent used Aionis context to continue the current path.",
  outcome: agentResult.status,
  guide,
  used_memory_ids: agentResult.used_memory_ids,
});

const measure = await aionis.execution.measureRun({
  run_id: runId,
  task_signature: taskSignature,
  after_guide: guide,
  feedback_result: feedback,
  sufficient_evidence: true,
});

const snapshot = await aionis.execution.snapshotRun({
  run_id: runId,
  task_signature: taskSignature,
  guide,
  measure_result: measure,
  include_markdown: false,
});

console.log(JSON.stringify({
  prompt_preview: context.agent_prompt.slice(0, 500),
  execution_context_contract: context.contract_version,
  memory_use_receipt_visible: context.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1",
  used_memory_ids: agentResult.used_memory_ids,
  snapshot_visible: !!snapshot,
}, null, 2));
