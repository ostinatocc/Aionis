// Runtime v0.3.10 development / SDK v0.3.18
import {
  compileExecutionAgentContext,
  createAionisClient,
  feedbackAttributionFromGuide,
  type AionisGuideFeedbackAttributionV1,
} from "@aionis/sdk";

type MinimalGuide = {
  tenant_id: string;
  scope: string;
  guide_trace_id: string;
  feedback_attribution_v1: AionisGuideFeedbackAttributionV1;
  agent_context: {
    prompt_text: string;
    use_now_memory_ids?: string[];
  };
};

type InstrumentedAgentResult = {
  status: "succeeded";
  used_memory_ids: string[];
};

async function runInstrumentedAgent(agentPrompt: string): Promise<InstrumentedAgentResult> {
  // Replace this stub with the host's Agent runner. Populate used_memory_ids
  // only from instrumented Agent/tool events. Empty means no use was verified.
  void agentPrompt;
  return { status: "succeeded", used_memory_ids: [] };
}

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

// AgentContext IDs describe visibility/correlation only. They are not proof of
// actual use and do not authorize feedback.
const feedbackAttribution = feedbackAttributionFromGuide(guide);
const agentResult = await runInstrumentedAgent(context.agent_prompt);

let feedback: unknown = null;
if (agentResult.used_memory_ids.length > 0) {
  if (feedbackAttribution.status !== "available") {
    throw new Error(
      `Feedback attribution is unavailable (${feedbackAttribution.reason_code}); `
      + "request a new guide instead of falling back to agent_context IDs.",
    );
  }

  feedback = await aionis.execution.feedbackFromOutcome({
    agent_id: "agent-1",
    run_id: runId,
    task_signature: taskSignature,
    title: "Agent completed the next step",
    summary: "Host instrumentation verified use of Aionis memory.",
    outcome: agentResult.status,
    guide,
    used_memory_ids: agentResult.used_memory_ids,
  });
}

const measure = await aionis.execution.measureRun({
  run_id: runId,
  task_signature: taskSignature,
  after_guide: guide,
  feedback_result: feedback,
  sufficient_evidence: agentResult.used_memory_ids.length > 0,
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
  feedback_attribution_status: feedbackAttribution.status,
  memory_use_receipt_visible: context.memory_use_receipt.contract_version === "aionis_memory_use_receipt_v1",
  used_memory_ids: agentResult.used_memory_ids,
  snapshot_visible: !!snapshot,
}, null, 2));
