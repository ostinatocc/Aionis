import { randomUUID } from "node:crypto";
import {
  createExampleClient,
  isMain,
  printHeading,
  printJson,
  printStep,
  recordPositiveToolFeedback,
  runExample,
} from "./shared.js";

async function main() {
  const aionis = createExampleClient();
  const exampleTag = randomUUID().slice(0, 8);
  const scope = `policy-learning-control-${exampleTag}`;
  const queryText = "repair export failure in node tests";
  const context = {
    goal: queryText,
    task_kind: "repair_export",
    error: {
      signature: "node-export-mismatch",
    },
  };
  const candidates = ["bash", "edit", "test"];

  printHeading("Demo 3: Contested / retire / reactivate learning-control loop");

  printStep("1. Materialize a persisted policy memory through repeated positive feedback.");
  let policyMemoryId: string | null = null;
  let latestFeedback: Record<string, any> | null = null;
  for (let index = 0; index < 4; index += 1) {
    const result = await recordPositiveToolFeedback({
      client: aionis,
      scope,
      runId: `policy-learning-control-run-${randomUUID()}`,
      goal: queryText,
      taskKind: "repair_export",
      errorSignature: "node-export-mismatch",
      candidates,
    });
    latestFeedback = result.feedback;
    policyMemoryId = result.feedback?.policy_memory?.node_id ?? policyMemoryId;
    if (policyMemoryId) break;
  }

  if (!policyMemoryId) {
    throw new Error("policy memory did not materialize after repeated positive feedback");
  }

  printJson("Materialized policy memory", latestFeedback?.policy_memory ?? null);

  printStep("2. Retire the persisted policy memory through the public learning-control route.");
  const retired = await aionis.memory.policies.learningControlApply({
    tenant_id: "default",
    scope,
    actor: "sdk-example",
    policy_memory_id: policyMemoryId,
    action: "retire",
    reason: "manual review retired this persisted policy memory",
  });

  printJson("Retire result", retired);

  printStep("3. Reactivate the same policy memory with fresh live evidence.");
  const reactivated = await aionis.memory.policies.learningControlApply({
    tenant_id: "default",
    scope,
    actor: "sdk-example",
    policy_memory_id: policyMemoryId,
    action: "reactivate",
    reason: "fresh live evidence supports reactivating the retired policy memory",
    query_text: queryText,
    context,
    candidates,
  });

  printJson("Reactivate result", reactivated);

  const inspect = await aionis.memory.agent.inspect({
    tenant_id: "default",
    scope,
    query_text: queryText,
    context,
    candidates,
    file_path: "src/routes/export.ts",
  });

  printJson("Post-reactivation inspect summary", inspect.agent_memory_summary);
  printJson("Proof summary", {
    retired_previous_state: retired.previous_state,
    retired_next_state: retired.next_state,
    reactivated_previous_state: reactivated.previous_state,
    reactivated_next_state: reactivated.next_state,
    live_policy_selected_tool: reactivated.live_policy_contract?.selected_tool ?? null,
    selected_policy_memory_state: inspect.agent_memory_summary.selected_policy_memory_state,
    learning_control_action: inspect.agent_memory_summary.policy_learning_control_action,
  });
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
