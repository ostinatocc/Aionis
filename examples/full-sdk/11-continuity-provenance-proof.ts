import { randomUUID } from "node:crypto";
import {
  createExampleClient,
  createScope,
  DEFAULT_TENANT_ID,
  isMain,
  printHeading,
  printJson,
  printStep,
  runExample,
} from "./shared.js";

const QUERY_TEXT = "fix export failure in node tests";
const FILE_PATH = "src/routes/export.ts";
const TOOL_CANDIDATES = ["bash", "edit", "test"] as const;

function buildContinuityState(args: { taskBrief: string; filePath: string }) {
  const stateId = `state:${randomUUID()}`;
  const updatedAt = "2026-03-21T12:00:00.000Z";
  return {
    execution_state_v1: {
      version: 1,
      state_id: stateId,
      scope: `aionis://execution/${stateId}`,
      task_brief: args.taskBrief,
      current_stage: "patch",
      active_role: "patch",
      owned_files: [],
      modified_files: [args.filePath],
      pending_validations: ["npm run -s test:lite -- export"],
      completed_validations: [],
      last_accepted_hypothesis: null,
      rejected_paths: [],
      unresolved_blockers: [],
      rollback_notes: [],
      reviewer_contract: null,
      resume_anchor: {
        anchor: `resume:${args.filePath}`,
        file_path: args.filePath,
        symbol: null,
        repo_root: process.cwd(),
      },
      updated_at: updatedAt,
    },
    execution_packet_v1: {
      version: 1,
      state_id: stateId,
      current_stage: "patch",
      active_role: "patch",
      task_brief: args.taskBrief,
      target_files: [args.filePath],
      next_action: `Patch ${args.filePath} and rerun export tests`,
      hard_constraints: [],
      accepted_facts: [],
      rejected_paths: [],
      pending_validations: ["npm run -s test:lite -- export"],
      unresolved_blockers: [],
      rollback_notes: [],
      review_contract: null,
      resume_anchor: {
        anchor: `resume:${args.filePath}`,
        file_path: args.filePath,
        symbol: null,
        repo_root: process.cwd(),
      },
      artifact_refs: [],
      evidence_refs: [],
    },
  };
}

function buildPlanningPayload(scope: string) {
  return {
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: QUERY_TEXT,
    context: {
      goal: QUERY_TEXT,
    },
    tool_candidates: [...TOOL_CANDIDATES],
  };
}

function pickWorkflowLine(lines: unknown, token: string): string | null {
  if (!Array.isArray(lines)) return null;
  const normalized = lines.filter((line): line is string => typeof line === "string");
  return normalized.find((line) => line.includes(token)) ?? normalized[0] ?? null;
}

function summarizePlanning(planning: Record<string, any>, origin: string) {
  const sections = planning?.planner_packet?.sections ?? {};
  const candidateWorkflows = Array.isArray(sections?.candidate_workflows) ? sections.candidate_workflows : [];
  const recommendedWorkflows = Array.isArray(sections?.recommended_workflows) ? sections.recommended_workflows : [];
  return {
    candidate_workflow_count: candidateWorkflows.length,
    recommended_workflow_count: recommendedWorkflows.length,
    origin_count: planning?.planning_summary?.distillation_signal_summary?.origin_counts?.[origin] ?? 0,
    continuity_carrier_summary: planning?.planning_summary?.continuity_carrier_summary ?? null,
    candidate_workflow_line: pickWorkflowLine(candidateWorkflows, `distillation=${origin}`),
    recommended_workflow_line: pickWorkflowLine(recommendedWorkflows, `distillation=${origin}`),
  };
}

function summarizeIntrospection(introspect: Record<string, any>, origin: string) {
  const workflowLines = introspect?.demo_surface?.sections?.workflows ?? [];
  return {
    continuity_carrier_summary: introspect?.continuity_carrier_summary ?? null,
    distillation_signal_summary: introspect?.distillation_signal_summary ?? null,
    recommended_workflow_count: Array.isArray(introspect?.recommended_workflows) ? introspect.recommended_workflows.length : 0,
    candidate_workflow_count: Array.isArray(introspect?.candidate_workflows) ? introspect.candidate_workflows.length : 0,
    workflow_line: pickWorkflowLine(workflowLines, `distillation=${origin}`),
  };
}

function assertStablePromotion(summary: { recommended_workflow_count: number }, origin: string) {
  if (summary.recommended_workflow_count > 0) return;
  throw new Error(
    `No stable workflow was promoted for ${origin}. Restart Lite with WORKFLOW_LEARNING_CONTROL_STATIC_PROMOTE_MEMORY_PROVIDER_ENABLED=true npm run lite:start and rerun this proof.`,
  );
}

async function runHandoffProof(aionis: ReturnType<typeof createExampleClient>) {
  const scope = createScope("continuity-proof-handoff");
  const origin = "handoff_continuity_carrier";

  printStep("1. Store a first structured handoff and inspect the initial projected candidate workflow.");
  await aionis.handoff.store({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "local-user",
    memory_lane: "private",
    handoff_kind: "patch_handoff",
    anchor: `handoff:${scope}:1`,
    title: "Export repair handoff",
    file_path: FILE_PATH,
    repo_root: process.cwd(),
    summary: QUERY_TEXT,
    handoff_text: `Continue ${QUERY_TEXT}`,
    target_files: [FILE_PATH],
    next_action: `Patch ${FILE_PATH} and rerun export tests`,
    acceptance_checks: ["npm run -s test:lite -- export"],
    ...buildContinuityState({ taskBrief: QUERY_TEXT, filePath: FILE_PATH }),
  });
  const firstPlanning = await aionis.memory.planningContext(buildPlanningPayload(scope)) as Record<string, any>;
  const firstSummary = summarizePlanning(firstPlanning, origin);
  printJson("Handoff after first carrier", firstSummary);

  printStep("2. Store a second handoff for the same task family and verify stable workflow promotion preserves provenance.");
  await aionis.handoff.store({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "local-user",
    memory_lane: "private",
    handoff_kind: "patch_handoff",
    anchor: `handoff:${scope}:2`,
    title: "Export repair handoff second run",
    file_path: FILE_PATH,
    repo_root: process.cwd(),
    summary: QUERY_TEXT,
    handoff_text: `Continue ${QUERY_TEXT} after the next repair pass`,
    target_files: [FILE_PATH],
    next_action: `Patch ${FILE_PATH} and rerun export tests`,
    acceptance_checks: ["npm run -s test:lite -- export"],
    ...buildContinuityState({ taskBrief: QUERY_TEXT, filePath: FILE_PATH }),
  });
  const secondPlanning = await aionis.memory.planningContext(buildPlanningPayload(scope)) as Record<string, any>;
  const secondSummary = summarizePlanning(secondPlanning, origin);
  assertStablePromotion(secondSummary, origin);
  printJson("Handoff after stable promotion", secondSummary);

  const introspect = await aionis.memory.executionIntrospect({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: QUERY_TEXT,
    context: {
      goal: QUERY_TEXT,
    },
    limit: 8,
  }) as Record<string, any>;
  const introspectionSummary = summarizeIntrospection(introspect, origin);
  printJson("Handoff introspection", introspectionSummary);

  return {
    scope,
    firstSummary,
    secondSummary,
    introspectionSummary,
  };
}

async function runSessionEventProof(aionis: ReturnType<typeof createExampleClient>) {
  const scope = createScope("continuity-proof-session");
  const sessionId = `session-${randomUUID()}`;
  const origin = "session_event_continuity_carrier";

  await aionis.memory.sessions.create({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "local-user",
    session_id: sessionId,
    title: "Export repair working session",
    input_text: "Create a session for repeated export repair continuity proof.",
    memory_lane: "private",
  });

  printStep("3. Write the first session event and inspect the initial projected candidate workflow.");
  await aionis.memory.sessions.writeEvent({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "local-user",
    session_id: sessionId,
    event_id: randomUUID(),
    title: "Export repair session event one",
    text_summary: QUERY_TEXT,
    input_text: `continue ${QUERY_TEXT}`,
    memory_lane: "private",
    ...buildContinuityState({ taskBrief: QUERY_TEXT, filePath: FILE_PATH }),
  });
  const firstPlanning = await aionis.memory.planningContext(buildPlanningPayload(scope)) as Record<string, any>;
  const firstSummary = summarizePlanning(firstPlanning, origin);
  printJson("Session event after first carrier", firstSummary);

  printStep("4. Write the second session event and verify stable workflow promotion preserves provenance.");
  await aionis.memory.sessions.writeEvent({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "local-user",
    session_id: sessionId,
    event_id: randomUUID(),
    title: "Export repair session event two",
    text_summary: QUERY_TEXT,
    input_text: `continue ${QUERY_TEXT} after the next repair pass`,
    memory_lane: "private",
    ...buildContinuityState({ taskBrief: QUERY_TEXT, filePath: FILE_PATH }),
  });
  const secondPlanning = await aionis.memory.planningContext(buildPlanningPayload(scope)) as Record<string, any>;
  const secondSummary = summarizePlanning(secondPlanning, origin);
  assertStablePromotion(secondSummary, origin);
  printJson("Session event after stable promotion", secondSummary);

  const introspect = await aionis.memory.executionIntrospect({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    query_text: QUERY_TEXT,
    context: {
      goal: QUERY_TEXT,
    },
    limit: 8,
  }) as Record<string, any>;
  const introspectionSummary = summarizeIntrospection(introspect, origin);
  printJson("Session event introspection", introspectionSummary);

  return {
    scope,
    sessionId,
    firstSummary,
    secondSummary,
    introspectionSummary,
  };
}

async function main() {
  const aionis = createExampleClient();

  printHeading("Demo 4: Continuity provenance survives promotion");

  const handoffProof = await runHandoffProof(aionis);
  const sessionProof = await runSessionEventProof(aionis);

  printJson("Proof summary", {
    handoff_scope: handoffProof.scope,
    handoff_candidate_line: handoffProof.firstSummary.candidate_workflow_line,
    handoff_stable_line: handoffProof.secondSummary.recommended_workflow_line,
    handoff_demo_line: handoffProof.introspectionSummary.workflow_line,
    handoff_count: handoffProof.introspectionSummary.continuity_carrier_summary?.handoff_count ?? 0,
    session_scope: sessionProof.scope,
    session_id: sessionProof.sessionId,
    session_candidate_line: sessionProof.firstSummary.candidate_workflow_line,
    session_stable_line: sessionProof.secondSummary.recommended_workflow_line,
    session_demo_line: sessionProof.introspectionSummary.workflow_line,
    session_event_count: sessionProof.introspectionSummary.continuity_carrier_summary?.session_event_count ?? 0,
  });
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
