import { randomUUID } from "node:crypto";
import {
  createExampleClient,
  createExampleHostBridge,
  DEFAULT_TENANT_ID,
  isMain,
  printHeading,
  printJson,
  printStep,
  runExample,
} from "./shared.js";

async function main() {
  const aionis = createExampleClient();
  const bridge = createExampleHostBridge();
  const exampleTag = randomUUID().slice(0, 8);
  const scope = `full-sdk-host-bridge-${exampleTag}`;
  const taskBrief = `Repair export response serialization mismatch [full-sdk-host-${exampleTag}]`;
  const taskId = `host-bridge-task-${exampleTag}`;

  printHeading("Full SDK Host Bridge Context Inspect");
  printStep(`scope=${scope}`);
  printStep(`task_id=${taskId}`);

  printStep("Seeding standalone delegation records so the host bridge has continuity learning to inspect.");
  await aionis.memory.delegationRecords.write({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    run_id: `run-${exampleTag}-1`,
    handoff_anchor: taskId,
    delegation_records_v1: {
      summary_version: "execution_delegation_records_v1",
      record_mode: "packet_backed",
      route_role: "patch",
      packet_count: 1,
      return_count: 1,
      artifact_routing_count: 2,
      missing_record_types: [],
      delegation_packets: [{
        version: 1,
        role: "patch",
        mission: "Patch the export route and rerun the serializer checks.",
        working_set: ["src/routes/export.ts"],
        acceptance_checks: ["npm run -s test:lite -- export"],
        output_contract: "Return the patch summary and final serializer test status.",
        preferred_artifact_refs: ["artifact://export/patch"],
        inherited_evidence: ["evidence://export/failure"],
        routing_reason: "packet-backed export patch route",
        task_family: "task:repair_export",
        family_scope: "aionis://examples/full-sdk/repair-export",
        source_mode: "packet_backed",
      }],
      delegation_returns: [{
        version: 1,
        role: "patch",
        status: "passed",
        summary: "Patch applied and export serializer checks passed.",
        evidence: ["evidence://export/test"],
        working_set: ["src/routes/export.ts"],
        acceptance_checks: ["npm run -s test:lite -- export"],
        source_mode: "packet_backed",
      }],
      artifact_routing_records: [{
        version: 1,
        ref: "artifact://export/patch",
        ref_kind: "artifact",
        route_role: "patch",
        route_intent: "patch",
        route_mode: "packet_backed",
        task_family: "task:repair_export",
        family_scope: "aionis://examples/full-sdk/repair-export",
        routing_reason: "patch artifact route",
        source: "execution_packet",
      }, {
        version: 1,
        ref: "evidence://export/test",
        ref_kind: "evidence",
        route_role: "patch",
        route_intent: "patch",
        route_mode: "packet_backed",
        task_family: "task:repair_export",
        family_scope: "aionis://examples/full-sdk/repair-export",
        routing_reason: "patch evidence route",
        source: "execution_packet",
      }],
    },
  });

  await aionis.memory.delegationRecords.write({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    memory_lane: "private",
    run_id: `run-${exampleTag}-2`,
    handoff_anchor: taskId,
    delegation_records_v1: {
      summary_version: "execution_delegation_records_v1",
      record_mode: "memory_only",
      route_role: "patch",
      packet_count: 1,
      return_count: 0,
      artifact_routing_count: 1,
      missing_record_types: ["delegation_returns"],
      delegation_packets: [{
        version: 1,
        role: "patch",
        mission: "Retry the export repair with a fallback patch route.",
        working_set: ["src/routes/export.ts"],
        acceptance_checks: ["npm run -s test:lite -- export"],
        output_contract: "Return the fallback patch metadata.",
        preferred_artifact_refs: ["artifact://export/fallback-patch"],
        inherited_evidence: [],
        routing_reason: "memory-guided fallback patch route",
        task_family: "task:repair_export",
        family_scope: "aionis://examples/full-sdk/repair-export",
        source_mode: "memory_only",
      }],
      delegation_returns: [],
      artifact_routing_records: [{
        version: 1,
        ref: "artifact://export/fallback-patch",
        ref_kind: "artifact",
        route_role: "patch",
        route_intent: "memory_guided",
        route_mode: "memory_only",
        task_family: "task:repair_export",
        family_scope: "aionis://examples/full-sdk/repair-export",
        routing_reason: "fallback patch artifact route",
        source: "strategy_summary",
      }],
    },
  });

  printStep("Host bridge requests debug/operator task context and receives normalized delegation learning.");
  const taskSession = await bridge.openTaskSession({
    task_id: taskId,
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    text: taskBrief,
    title: "Host bridge export repair task",
  });
  const initialState = taskSession.snapshotState();
  printJson("Host bridge initial session state", initialState);
  printJson("Host bridge controller actions", {
    allowed_actions: initialState.allowed_actions,
    transition_guards: initialState.transition_guards,
  });
  await taskSession.recordEvent({
    event_text: "observed serializer failure and prepared patch route inspection",
    metadata: {
      stage: "inspect",
    },
  });
  const taskContext = await taskSession.inspectTaskContext({
    context: {
      task_kind: "repair_export",
      host: "full-sdk-host-bridge-example",
    },
    candidates: ["bash", "edit", "test"],
  });

  printJson("Host bridge context inspect", {
    session_id: taskSession.session_id,
    kickoff_recommendation: taskContext.planning_context.kickoff_recommendation,
    delegation_learning_summary: taskContext.delegation_learning?.learning_summary ?? null,
    delegation_learning_recommendations: taskContext.delegation_learning?.learning_recommendations ?? [],
    operator_projection: taskContext.operator_projection,
  });

  printStep("Host bridge combines inspectTaskContext and startTask into a startup decision.");
  const taskStartPlan = await taskSession.planTaskStart({
    context: {
      task_kind: "repair_export",
      host: "full-sdk-host-bridge-example",
    },
    candidates: ["bash", "edit", "test"],
  });

  printJson("Host bridge startup decision", {
    decision: taskStartPlan.decision,
    first_action: taskStartPlan.first_action,
    kickoff_recommendation: taskStartPlan.task_start.kickoff_recommendation,
  });

  printStep("The same task session adapter can also pause and resume the host task.");
  const pause = await taskSession.pauseTask({
    summary: "pause export repair for review handoff",
    handoff_text: "Resume export route repair after reviewing serializer diff.",
    target_files: ["src/routes/export.ts"],
    next_action: "Patch src/routes/export.ts and rerun serializer checks.",
  });
  const pausedState = taskSession.snapshotState();
  const resume = await taskSession.resumeTask();
  const resumedState = taskSession.snapshotState();
  const complete = await taskSession.completeTask({
    steps: [{
      tool_name: "edit",
      tool_input: {
        file_path: "src/routes/export.ts",
      },
      status: "success",
    }],
    compile_playbook: false,
    summary: "completed export serializer repair task",
  });
  printJson("Host bridge session pause/resume", {
    pause,
    resume,
    paused_state: pausedState,
    resumed_state: resumedState,
    complete,
    completed_state: taskSession.snapshotState(),
  });
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
