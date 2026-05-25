import { createReplayRunId, createExampleClient, createScope, DEFAULT_TENANT_ID, isMain, printHeading, printJson, printStep, runExample } from "./shared.js";

async function main() {
  const aionis = createExampleClient();
  const scope = createScope("full-sdk-replay");
  const runId = createReplayRunId();

  printHeading("Full SDK Replay Run Lifecycle");
  printStep(`scope=${scope}`);
  printStep(`runId=${runId}`);

  const started = await aionis.memory.replay.run.start({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    run_id: runId,
    goal: "Repair the failing replay workflow and validate the recovery path",
  });
  printJson("replay_run_start", started);

  const before = await aionis.memory.replay.step.before({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    run_id: runId,
    step_index: 1,
    tool_name: "bash",
    tool_input: {
      argv: ["npm", "run", "-s", "test:lite"],
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
      kind: "command_result",
      summary: "lite test suite passed",
    },
  });
  printJson("replay_step_after", after);

  const ended = await aionis.memory.replay.run.end({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "full-sdk-example",
    run_id: runId,
    status: "success",
    summary: "Replay recovery sequence completed successfully",
    metrics: {
      successful_steps: 1,
    },
  });
  printJson("replay_run_end", ended);

  const fetched = await aionis.memory.replay.run.get({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    run_id: runId,
  });
  printJson("replay_run_get", fetched);
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
