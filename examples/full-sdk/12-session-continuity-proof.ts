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
  const workflowSummary = planning?.workflow_signals?.[0] ?? null;
  return {
    candidate_workflow_count: candidateWorkflows.length,
    recommended_workflow_count: recommendedWorkflows.length,
    origin_count: planning?.planning_summary?.distillation_signal_summary?.origin_counts?.[origin] ?? 0,
    continuity_carrier_summary: planning?.planning_summary?.continuity_carrier_summary ?? null,
    workflow_summary: workflowSummary,
    observed_count: workflowSummary?.observed_count ?? null,
    required_observations: workflowSummary?.required_observations ?? null,
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
    observed_count: introspect?.recommended_workflows?.[0]?.observed_count ?? null,
    workflow_line: pickWorkflowLine(workflowLines, `distillation=${origin}`),
  };
}

function assertStablePromotion(summary: { recommended_workflow_count: number }, origin: string) {
  if (summary.recommended_workflow_count > 0) return;
  throw new Error(
    `No stable workflow was promoted for ${origin}. Restart Lite with WORKFLOW_LEARNING_CONTROL_STATIC_PROMOTE_MEMORY_PROVIDER_ENABLED=true npm run lite:start and rerun this proof.`,
  );
}

function assertPlanningSupport(summary: { observed_count: number | null; required_observations: number | null }, origin: string) {
  if (summary.observed_count === 2 && summary.required_observations === 2) return;
  throw new Error(
    `Planning workflow summary did not preserve stable support counts for ${origin}. Expected observed_count=2 and required_observations=2, got ${summary.observed_count}/${summary.required_observations}.`,
  );
}

async function main() {
  const aionis = createExampleClient();
  const scope = createScope("session-continuity-proof");
  const sessionId = `session-${randomUUID()}`;
  const origin = "session_continuity_carrier";

  printHeading("Demo 5: Session continuity carriers promote stable workflows");

  printStep("1. Create the first session continuity carrier and inspect the initial projected candidate workflow.");
  await aionis.memory.sessions.create({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "local-user",
    session_id: sessionId,
    title: "Export repair working session",
    text_summary: QUERY_TEXT,
    input_text: `continue ${QUERY_TEXT}`,
    memory_lane: "private",
    ...buildContinuityState({ taskBrief: QUERY_TEXT, filePath: FILE_PATH }),
  });
  const firstPlanning = await aionis.memory.planningContext(buildPlanningPayload(scope)) as Record<string, any>;
  const firstSummary = summarizePlanning(firstPlanning, origin);
  printJson("Session carrier after first write", firstSummary);

  printStep("2. Create a second session continuity carrier for the same task family and verify stable workflow promotion.");
  await aionis.memory.sessions.create({
    tenant_id: DEFAULT_TENANT_ID,
    scope,
    actor: "local-user",
    session_id: sessionId,
    title: "Export repair working session update",
    text_summary: QUERY_TEXT,
    input_text: `continue ${QUERY_TEXT} after the next repair pass`,
    memory_lane: "private",
    ...buildContinuityState({ taskBrief: QUERY_TEXT, filePath: FILE_PATH }),
  });
  const secondPlanning = await aionis.memory.planningContext(buildPlanningPayload(scope)) as Record<string, any>;
  const secondSummary = summarizePlanning(secondPlanning, origin);
  assertStablePromotion(secondSummary, origin);
  assertPlanningSupport(secondSummary, origin);
  printJson("Session carrier after stable promotion", secondSummary);

  printStep("3. Inspect the promoted workflow and verify provenance is still visible.");
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
  printJson("Session continuity introspection", introspectionSummary);

  printJson("Proof summary", {
    scope,
    session_id: sessionId,
    candidate_workflow_line: firstSummary.candidate_workflow_line,
    stable_workflow_line: secondSummary.recommended_workflow_line,
    planning_observed_count: secondSummary.observed_count,
    planning_required_observations: secondSummary.required_observations,
    introspection_workflow_line: introspectionSummary.workflow_line,
    session_count: introspectionSummary.continuity_carrier_summary?.session_count ?? 0,
    origin_count: introspectionSummary.distillation_signal_summary?.origin_counts?.session_continuity_carrier ?? 0,
    observed_count: introspectionSummary.observed_count,
  });
}

if (isMain(import.meta.url)) {
  await runExample(main);
}
