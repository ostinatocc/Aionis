import {
  isMain,
  createExampleClient,
  createScope,
  DEFAULT_TENANT_ID,
  printHeading,
  printJson,
  printStep,
  resolveDelegationLearningProjection,
  runExample,
} from "./shared.js";

async function main() {
  const aionis = createExampleClient();
  const scope = createScope("full-sdk-recall");

  printHeading("Full SDK Recall And Context");
  printStep(`baseUrl=${process.env.AIONIS_BASE_URL ?? "http://127.0.0.1:3001"}`);
  printStep(`scope=${scope}`);

  const health = await aionis.system.health();
  printJson("health", health);

  const write = await aionis.memory.write({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    input_text: "Documented replay failure analysis and recovery sequence for Aionis Core triage.",
    nodes: [],
    edges: [],
  });
  printJson("write", write);

  const recallText = await aionis.memory.recallText({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: "What recovery sequence was documented for replay failure?",
    include_meta: true,
  });
  printJson("recall_text", recallText);

  const planning = await aionis.memory.planningContext({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: "What should I do next to recover the replay run?",
    context: {
      goal: "recover a failed replay run in Aionis Core",
      operator_mode: "debug",
    },
    tool_candidates: ["bash", "edit", "test"],
    return_layered_context: true,
  });
  const delegationLearning = resolveDelegationLearningProjection(planning);
  printJson("planning_context", {
    kickoff_recommendation: planning.kickoff_recommendation,
    operator_projection: planning.operator_projection ?? null,
    delegation_learning_summary: delegationLearning?.learning_summary ?? null,
  });
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
