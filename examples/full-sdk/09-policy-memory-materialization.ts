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
  const scope = `policy-memory-${exampleTag}`;
  const queryText = "repair export failure in node tests";
  const context = {
    goal: queryText,
    task_kind: "repair_export",
  };
  const candidates = ["bash", "edit", "test"];

  printHeading("Demo 2: Policy memory materializes from positive feedback");

  printStep("1. Record repeated successful tool-selection feedback for the same task family.");
  const first = await recordPositiveToolFeedback({
    client: aionis,
    scope,
    runId: `policy-memory-run-${randomUUID()}`,
  });
  const second = await recordPositiveToolFeedback({
    client: aionis,
    scope,
    runId: `policy-memory-run-${randomUUID()}`,
  });
  const third = await recordPositiveToolFeedback({
    client: aionis,
    scope,
    runId: `policy-memory-run-${randomUUID()}`,
  });

  printJson("Third positive feedback", {
    selected_tool: third.selection?.selection?.selected ?? null,
    pattern_anchor: third.feedback?.pattern_anchor ?? null,
    policy_memory: third.feedback?.policy_memory ?? null,
    learning_control_preview: third.feedback?.learning_control_preview ?? null,
  });

  printStep("2. Read the evolution review pack and agent inspect surface after learning.");
  const evolution = await aionis.memory.reviewPacks.evolution({
    tenant_id: "default",
    scope,
    query_text: queryText,
    context,
    candidates,
  });
  const inspect = await aionis.memory.agent.inspect({
    tenant_id: "default",
    scope,
    query_text: queryText,
    context,
    candidates,
    file_path: "src/routes/export.ts",
  });

  printJson("Evolution review", {
    policy_contract: evolution.evolution_review_pack.policy_contract,
    policy_review: evolution.evolution_review_pack.policy_review,
    policy_learning_control_contract: evolution.evolution_review_pack.policy_learning_control_contract,
  });

  printJson("Agent inspect summary", inspect.agent_memory_summary);

  printJson("Proof summary", {
    policy_memory_materialized: third.feedback?.policy_memory?.policy_contract?.materialization_state ?? null,
    policy_memory_state: third.feedback?.policy_memory?.policy_memory_state ?? null,
    derived_policy_source_kind: inspect.agent_memory_summary.derived_policy_source_kind,
    selected_policy_memory_state: inspect.agent_memory_summary.selected_policy_memory_state,
    policy_review_recommended: inspect.agent_memory_summary.policy_review_recommended,
    first_feedback_policy_memory_present: Boolean(first.feedback?.policy_memory),
    second_feedback_policy_memory_present: Boolean(second.feedback?.policy_memory),
  });
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
