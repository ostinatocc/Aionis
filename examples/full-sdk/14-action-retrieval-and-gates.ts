import { randomUUID } from "node:crypto";
import {
  buildExecutionWritePayload,
  createExampleClient,
  isMain,
  printHeading,
  printJson,
  printStep,
  runExample,
} from "./shared.js";

async function main() {
  const aionis = createExampleClient();
  const exampleTag = randomUUID().slice(0, 8);
  const scope = `action-retrieval-${exampleTag}`;
  const taskBrief = `Repair billing retry timeout in service code [action-retrieval-${exampleTag}]`;
  const filePath = "src/services/billing.ts";
  const retrievalPayload = {
    tenant_id: "default",
    scope,
    query_text: taskBrief,
    context: {
      goal: taskBrief,
      task_kind: "repair_billing_retry",
    },
    candidates: ["bash", "edit", "test"],
  } as const;
  const planningPayload = {
    tenant_id: "default",
    scope,
    query_text: taskBrief,
    context: {
      goal: taskBrief,
      task_kind: "repair_billing_retry",
    },
    tool_candidates: ["bash", "edit", "test"],
    return_layered_context: true,
  } as const;

  printHeading("Action Retrieval And Uncertainty Gates");

  printStep("1. Ask for explicit action retrieval before relevant execution memory exists.");
  const coldRetrieval = await aionis.memory.actionRetrieval(retrievalPayload);
  const coldPlanning = await aionis.memory.planningContext(planningPayload) as Record<string, any>;
  printJson("Cold action retrieval", {
    tool_source_kind: coldRetrieval.tool_source_kind,
    selected_tool: coldRetrieval.selected_tool,
    recommended_file_path: coldRetrieval.recommended_file_path,
    recommended_next_action: coldRetrieval.recommended_next_action,
    uncertainty: coldRetrieval.uncertainty,
  });
  printJson("Cold planning gate", {
    uncertainty: coldPlanning?.planning_summary?.action_retrieval_uncertainty ?? null,
    gate: coldPlanning?.planning_summary?.action_retrieval_gate ?? null,
    operator_projection: coldPlanning?.operator_projection ?? null,
  });

  printStep("2. Write two successful execution packets for the same task family.");
  await aionis.memory.write(
    buildExecutionWritePayload({
      title: "Billing retry repair run one",
      inputText: "continue fixing billing retry timeout first run",
      taskBrief,
      filePath,
      scope,
    }),
  );
  await aionis.memory.write(
    buildExecutionWritePayload({
      title: "Billing retry repair run two",
      inputText: "continue fixing billing retry timeout second run",
      taskBrief,
      filePath,
      scope,
    }),
  );

  printStep("3. Ask again and inspect the explicit retrieval layer plus planning-side gate surfaces.");
  const warmRetrieval = await aionis.memory.actionRetrieval(retrievalPayload);
  const warmPlanning = await aionis.memory.planningContext(planningPayload) as Record<string, any>;
  const warmGate = warmPlanning?.planning_summary?.action_retrieval_gate ?? null;
  const warmHint = Array.isArray(warmPlanning?.operator_projection?.action_hints)
    ? warmPlanning.operator_projection.action_hints[0] ?? null
    : null;

  if (!warmRetrieval.uncertainty) throw new Error("actionRetrieval did not return uncertainty");
  if (!warmGate) throw new Error("planningContext did not return action_retrieval_gate");
  if (!warmPlanning?.operator_projection) {
    throw new Error("planningContext did not return operator_projection under debug/operator mode");
  }

  printJson("Warm action retrieval", {
    tool_source_kind: warmRetrieval.tool_source_kind,
    selected_tool: warmRetrieval.selected_tool,
    recommended_file_path: warmRetrieval.recommended_file_path,
    recommended_next_action: warmRetrieval.recommended_next_action,
    evidence_entries: warmRetrieval.evidence?.entries ?? [],
    uncertainty: warmRetrieval.uncertainty,
  });
  printJson("Warm planning gate", {
    uncertainty: warmPlanning?.planning_summary?.action_retrieval_uncertainty ?? null,
    gate: warmGate,
    operator_hint: warmHint,
  });

  printJson("Proof summary", {
    cold_recommended_actions: coldRetrieval.uncertainty?.recommended_actions ?? [],
    warm_source_kind: warmRetrieval.tool_source_kind,
    warm_selected_tool: warmRetrieval.selected_tool,
    warm_file_path: warmRetrieval.recommended_file_path,
    warm_gate_action: warmGate?.gate_action ?? null,
    warm_operator_hint_action: warmHint?.action ?? null,
  });
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
