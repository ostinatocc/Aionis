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
  const scope = `self-evolving-task-start-${exampleTag}`;
  const taskBrief = `Repair billing retry timeout in service code [task-start-proof-${exampleTag}]`;
  const filePath = "src/services/billing.ts";
  const payload = {
    tenant_id: "default",
    scope,
    query_text: taskBrief,
    context: {
      goal: taskBrief,
      host: "self-evolving-proof",
    },
    candidates: ["bash", "edit", "test"],
  } as const;

  printHeading("Demo 1: Better second task start");

  printStep("1. Ask for a task start before any relevant execution memory exists.");
  const cold = await aionis.memory.taskStart(payload);
  printJson("Cold task start", {
    first_action: cold.first_action,
    rationale: cold.rationale,
  });
  const coldPlan = await aionis.memory.taskStartPlan(payload);
  printJson("Cold task start plan", {
    resolution_source: coldPlan.resolution_source,
    first_action: coldPlan.first_action,
    gate_action: coldPlan.gate_action,
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

  printStep("3. Ask again and verify the first action is now grounded in learned execution memory.");
  const warm = await aionis.memory.taskStart(payload);
  printJson("Warm task start", {
    first_action: warm.first_action,
    rationale: warm.rationale,
  });
  const workflowContract = await aionis.memory.retrieveWorkflowContract({
    tenant_id: "default",
    scope,
    file_path: filePath,
    include_introspection: false,
  });
  printJson("Retrieved workflow contract", {
    selected_source: workflowContract.selected_source,
    execution_contract_v1: workflowContract.execution_contract_v1,
  });

  printJson("Proof summary", {
    cold_has_first_action: cold.first_action !== null,
    warm_has_first_action: warm.first_action !== null,
    cold_source_kind: cold.first_action?.source_kind ?? null,
    warm_source_kind: warm.first_action?.source_kind ?? null,
    learned_file_path: warm.first_action?.file_path ?? null,
    learned_next_action: warm.first_action?.next_action ?? null,
  });
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
