import {
  DEFAULT_SCOPE,
  DEFAULT_TENANT_ID,
  createExampleClient,
  createScope,
  isMain,
  printHeading,
  printJson,
  printStep,
  runExample,
} from "./shared.js";

async function main() {
  const aionis = createExampleClient();
  const scope = createScope("agent-memory");
  const anchor = `agent-memory:${scope}`;

  printHeading("Agent memory inspect surfaces");
  printStep(`tenant=${DEFAULT_TENANT_ID}`);
  printStep(`scope=${scope}`);

  await aionis.memory.write({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "sdk-example",
    input_text: "Observed repeated export mismatch failures and narrowed the repair path to src/routes/export.ts.",
    nodes: [
      {
        client_id: "export-mismatch-repair",
        type: "event",
        tier: "archive",
        title: "Export mismatch repair context",
        text_summary: "The runtime observed repeated export mismatch failures in the export route.",
        slots: {
          task_kind: "repair_export_mismatch",
          next_action: "inspect src/routes/export.ts and rerun the export tests",
        },
      },
    ],
  });

  await aionis.memory.archive.rehydrate({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "sdk-example",
    client_ids: ["export-mismatch-repair"],
    target_tier: "warm",
    reason: "bring the archived export repair context back into the working set",
    input_text: "reuse the prior export mismatch repair context",
  });

  await aionis.memory.nodes.activate({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "sdk-example",
    client_ids: ["export-mismatch-repair"],
    outcome: "positive",
    activate: true,
    reason: "the rehydrated node pointed to the correct repair path",
    input_text: "repair export mismatch in src/routes/export.ts",
  });

  await aionis.handoff.store({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "sdk-example",
    handoff_kind: "repair",
    anchor,
    summary: "Pause after narrowing the export mismatch to one route file.",
    handoff_text: "Resume in src/routes/export.ts and rerun the export route tests.",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch export route shape handling and rerun export tests.",
    acceptance_checks: ["npm run -s test -- export-route"],
  });

  const queryText = "repair export mismatch in src/routes/export.ts";
  const context = {
    goal: queryText,
    task_kind: "repair_export_mismatch",
  };
  const candidates = ["bash", "edit", "test"];

  const inspect = await aionis.memory.agent.inspect({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: queryText,
    context,
    candidates,
    anchor,
    file_path: "src/routes/export.ts",
    include_meta: true,
  });

  const reviewPack = await aionis.memory.agent.reviewPack({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: queryText,
    context,
    candidates,
    anchor,
    file_path: "src/routes/export.ts",
  });

  const resumePack = await aionis.memory.agent.resumePack({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: queryText,
    context,
    candidates,
    anchor,
    file_path: "src/routes/export.ts",
  });

  const handoffPack = await aionis.memory.agent.handoffPack({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: queryText,
    context,
    candidates,
    anchor,
    file_path: "src/routes/export.ts",
  });

  printJson("agent.inspect summary", inspect.agent_memory_summary);
  printJson("agent.reviewPack", reviewPack.agent_memory_review_pack);
  printJson("agent.resumePack", resumePack.agent_memory_resume_pack);
  printJson("agent.handoffPack", handoffPack.agent_memory_handoff_pack);
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
