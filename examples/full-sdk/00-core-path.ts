import {
  createReplayRunId,
  createExampleClient,
  createScope,
  DEFAULT_TENANT_ID,
  isMain,
  printHeading,
  printJson,
  printStep,
  runExample,
} from "./shared.js";

async function main() {
  const aionis = createExampleClient();
  const scope = createScope("full-sdk-core-path");
  const runId = createReplayRunId();

  printHeading("Full SDK Core Path");
  printStep(`baseUrl=${process.env.AIONIS_BASE_URL ?? "http://127.0.0.1:3001"}`);
  printStep(`scope=${scope}`);
  printStep(`runId=${runId}`);

  const health = await aionis.system.health();
  printJson("health", health);

  const write = await aionis.memory.write({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    input_text: "Diagnosed flaky retry handling in src/worker.ts and identified the likely patch point around the retry backoff path.",
    nodes: [],
    edges: [],
  });
  printJson("memory_write", write);

  const taskStart = await aionis.memory.taskStart({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: "fix flaky retry handling in worker.ts",
    context: {
      goal: "fix flaky retry handling in worker.ts",
      task_kind: "repair_worker_retry",
    },
    candidates: ["read", "edit", "test"],
  });
  printJson("task_start", {
    first_action: taskStart.first_action,
    kickoff_recommendation: taskStart.kickoff_recommendation ?? null,
  });

  const handoff = await aionis.handoff.store({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    anchor: `task:${scope}`,
    summary: "Pause after retry diagnosis",
    handoff_text: "Resume in src/worker.ts and patch retry/backoff handling.",
    target_files: ["src/worker.ts"],
    next_action: taskStart.first_action?.next_action ?? "Patch retry/backoff handling in src/worker.ts.",
    acceptance_checks: ["npm run -s test:lite"],
  });
  printJson("handoff_store", handoff);

  const started = await aionis.memory.replay.run.start({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    run_id: runId,
    goal: "fix flaky retry handling in worker.ts",
  });
  printJson("replay_run_start", started);

  const before = await aionis.memory.replay.step.before({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    run_id: runId,
    step_index: 1,
    tool_name: taskStart.first_action?.selected_tool ?? "edit",
    tool_input: {
      file_path: "src/worker.ts",
    },
  });
  printJson("replay_step_before", before);

  const after = await aionis.memory.replay.step.after({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    run_id: runId,
    step_index: 1,
    status: "success",
    output_signature: {
      kind: "patch_result",
      summary: "patched retry/backoff handling in worker.ts",
    },
  });
  printJson("replay_step_after", after);

  const ended = await aionis.memory.replay.run.end({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    run_id: runId,
    status: "success",
    summary: "Stored a handoff and completed a replay-backed retry repair pass.",
    metrics: {
      successful_steps: 1,
    },
  });
  printJson("replay_run_end", ended);
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
