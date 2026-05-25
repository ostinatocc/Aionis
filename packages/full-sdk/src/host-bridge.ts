import { randomUUID } from "node:crypto";

import type {
  AionisActionRetrievalUncertainty,
  AionisContextOperatorProjection,
  AionisDelegationLearningProjection,
  AionisHandoffRecoverRequest,
  AionisHandoffStoreRequest,
  AionisKickoffRecommendation,
  AionisKickoffRecommendationRequest,
  AionisPlanningContextRequest,
  AionisPlanningContextResponse,
  AionisReplayPlaybookCompileFromRunRequest,
  AionisReplayPlaybookRunRequest,
  AionisReplayRunEndRequest,
  AionisReplayRunStartRequest,
  AionisReplayStepAfterRequest,
  AionisReplayStepBeforeRequest,
  AionisSessionCreateRequest,
  AionisSessionEventsQuery,
  AionisSessionEventWriteRequest,
  AionisTaskStartResponse,
} from "./contracts.js";
import { createAionisRuntimeClient, type AionisRuntimeClient } from "./client.js";
import { resolveContextOperatorProjection } from "./projections.js";
import { resolveKickoffGateAction, type AionisTaskStartGateAction } from "./task-start.js";
import type { AionisClientOptions } from "./types.js";

const DEFAULT_TOOL_CANDIDATES = ["read", "glob", "grep", "bash", "edit", "write", "ls"];
const DEFAULT_EXECUTION_STAGE = "resume";
const DEFAULT_EXECUTION_ROLE = "resume";

export type AionisHostBridgeTask = {
  task_id: string;
  text: string;
  tenant_id?: string;
  scope?: string;
  actor?: string;
  context?: Record<string, unknown>;
  candidates?: string[];
};

export type AionisHostBridgeFirstAction = NonNullable<AionisTaskStartResponse["first_action"]>;
type AionisHostBridgeOperatorActionHint = NonNullable<AionisContextOperatorProjection["action_hints"]>[number];

export type AionisHostBridgeTaskStartResponse = {
  summary_version: "host_bridge_task_start_v1";
  task_id: string;
  first_action: AionisHostBridgeFirstAction | null;
  task_start: AionisTaskStartResponse;
};

export type AionisHostBridgeInspectTaskContextRequest = AionisHostBridgeTask & Pick<
  AionisPlanningContextRequest,
  | "run_id"
  | "include_shadow"
  | "rules_limit"
  | "tool_strict"
  | "context_layers"
  | "static_context_blocks"
  | "static_injection"
  | "memory_layer_preference"
  | "execution_result_summary"
  | "execution_artifacts"
  | "execution_evidence"
  | "execution_state_v1"
  | "execution_packet_v1"
>;

export type AionisHostBridgeTaskContextResponse = {
  summary_version: "host_bridge_task_context_v1";
  task_id: string;
  planning_context: AionisPlanningContextResponse;
  operator_projection: AionisContextOperatorProjection | null;
  delegation_learning: AionisDelegationLearningProjection | null;
};

export type AionisHostBridgeTaskStartPlanRequest = AionisHostBridgeInspectTaskContextRequest;

export type AionisHostBridgeStartupDecision = {
  summary_version: "host_bridge_startup_decision_v1";
  startup_mode:
    | "learned_kickoff"
    | "planner_fallback"
    | "inspect_context"
    | "widen_recall"
    | "rehydrate_payload"
    | "request_operator_review"
    | "manual_triage";
  gate_action: AionisTaskStartGateAction | null;
  tool: string | null;
  file_path: string | null;
  instruction: string | null;
  planner_explanation: string | null;
  task_family: string | null;
  matched_records: number;
  recommendation_count: number;
};

export type AionisHostBridgeTaskStartPlanResponse = {
  summary_version: "host_bridge_task_start_plan_v1";
  task_id: string;
  decision: AionisHostBridgeStartupDecision;
  first_action: AionisHostBridgeFirstAction | null;
  task_start: AionisTaskStartResponse;
  task_context: AionisHostBridgeTaskContextResponse;
};

export type AionisHostBridgeOpenTaskSessionRequest = AionisHostBridgeTask & Pick<
  AionisSessionCreateRequest,
  "session_id" | "title" | "summary" | "metadata"
>;

export type AionisHostBridgeTaskSessionRecordEventRequest = Omit<
  AionisSessionEventWriteRequest,
  "tenant_id" | "scope" | "actor" | "session_id"
>;

export type AionisHostBridgeTaskSessionEventsQuery = Omit<
  AionisSessionEventsQuery,
  "tenant_id" | "scope" | "session_id"
>;

export type AionisHostBridgeTaskSessionInspectRequest = Omit<
  AionisHostBridgeInspectTaskContextRequest,
  "task_id" | "text" | "tenant_id" | "scope" | "actor"
> & {
  text?: string;
};

export type AionisHostBridgeTaskSessionPauseRequest = Omit<
  AionisHostBridgePauseRequest,
  "task_id" | "text" | "tenant_id" | "scope" | "actor"
> & {
  text?: string;
};

export type AionisHostBridgeTaskSessionCompleteRequest = Omit<
  AionisHostBridgeCompleteRequest,
  "task_id" | "text" | "tenant_id" | "scope" | "actor"
> & {
  text?: string;
};

export type AionisHostBridgeTaskSessionStatus = "active" | "paused" | "resumed" | "completed";

export type AionisHostBridgeTaskSessionAction =
  | "list_events"
  | "inspect_context"
  | "record_event"
  | "plan_start"
  | "pause"
  | "resume"
  | "complete";

export type AionisHostBridgeTaskSessionTransition = {
  summary_version: "host_bridge_task_session_transition_v1";
  transition_kind: "session_opened" | "event_recorded" | "startup_planned" | "paused" | "resumed" | "completed";
  status: AionisHostBridgeTaskSessionStatus;
  at: string;
  detail: string | null;
};

export type AionisHostBridgeTaskSessionTransitionGuard = {
  summary_version: "host_bridge_task_session_transition_guard_v1";
  action: AionisHostBridgeTaskSessionAction;
  allowed: boolean;
  reason: string | null;
};

export type AionisHostBridgeTaskSessionState = {
  summary_version: "host_bridge_task_session_state_v1";
  task_id: string;
  session_id: string;
  status: AionisHostBridgeTaskSessionStatus;
  transition_count: number;
  last_transition: AionisHostBridgeTaskSessionTransition | null;
  transitions: AionisHostBridgeTaskSessionTransition[];
  last_startup_mode: AionisHostBridgeStartupDecision["startup_mode"] | null;
  last_handoff_anchor: string | null;
  last_event_text: string | null;
  allowed_actions: AionisHostBridgeTaskSessionAction[];
  transition_guards: AionisHostBridgeTaskSessionTransitionGuard[];
};

export type AionisHostBridgeTaskSession = {
  summary_version: "host_bridge_task_session_v1";
  task_id: string;
  task_text: string;
  session_id: string;
  session: Awaited<ReturnType<AionisRuntimeClient["memory"]["sessions"]["create"]>>;
  state: AionisHostBridgeTaskSessionState;
  snapshotState(): AionisHostBridgeTaskSessionState;
  recordEvent(
    input: AionisHostBridgeTaskSessionRecordEventRequest,
  ): Promise<Awaited<ReturnType<AionisRuntimeClient["memory"]["sessions"]["writeEvent"]>>>;
  listEvents(
    input?: AionisHostBridgeTaskSessionEventsQuery,
  ): Promise<Awaited<ReturnType<AionisRuntimeClient["memory"]["sessions"]["events"]>>>;
  inspectTaskContext(input?: AionisHostBridgeTaskSessionInspectRequest): Promise<AionisHostBridgeTaskContextResponse>;
  planTaskStart(input?: AionisHostBridgeTaskSessionInspectRequest): Promise<AionisHostBridgeTaskStartPlanResponse>;
  pauseTask(input: AionisHostBridgeTaskSessionPauseRequest): Promise<AionisHostBridgePauseResponse>;
  resumeTask(input?: Omit<AionisHostBridgeResumeRequest, "task_id" | "tenant_id" | "scope" | "actor">): Promise<AionisHostBridgeResumeResponse>;
  completeTask(input: AionisHostBridgeTaskSessionCompleteRequest): Promise<AionisHostBridgeCompleteResponse>;
};

export type AionisHostBridgePauseRequest = AionisHostBridgeTask & {
  summary: string;
  handoff_text: string;
  handoff_kind?: string;
  memory_lane?: "private" | "shared";
  file_path?: string;
  repo_root?: string;
  symbol?: string;
  risk?: string;
  acceptance_checks?: string[];
  tags?: string[];
  target_files?: string[];
  next_action?: string;
  must_change?: string[];
  must_remove?: string[];
  must_keep?: string[];
  execution_result_summary?: Record<string, unknown>;
  execution_artifacts?: Array<Record<string, unknown>>;
  execution_evidence?: Array<Record<string, unknown>>;
  execution_state_v1?: Record<string, unknown>;
  execution_packet_v1?: Record<string, unknown>;
  control_profile_v1?: Record<string, unknown>;
  execution_transitions_v1?: Array<Record<string, unknown>>;
};

export type AionisHostBridgePauseResponse = {
  summary_version: "host_bridge_task_pause_v1";
  task_id: string;
  handoff: Awaited<ReturnType<AionisRuntimeClient["handoff"]["store"]>>;
};

export type AionisHostBridgeResumeRequest = {
  task_id: string;
  tenant_id?: string;
  scope?: string;
  actor?: string;
  handoff_id?: string;
  handoff_uri?: string;
  handoff_kind?: string;
  repo_root?: string;
  file_path?: string;
  symbol?: string;
  include_payload?: boolean;
};

export type AionisHostBridgeResumeResponse = {
  summary_version: "host_bridge_task_resume_v1";
  task_id: string;
  handoff: Awaited<ReturnType<AionisRuntimeClient["handoff"]["recover"]>>;
};

export type AionisHostBridgeReplayStep = {
  step_id?: string;
  decision_id?: string;
  tool_name: string;
  tool_input: unknown;
  expected_output_signature?: unknown;
  preconditions?: Array<Record<string, unknown>>;
  retry_policy?: Record<string, unknown>;
  safety_level?: "auto_ok" | "needs_confirm" | "manual_only";
  status: "success" | "failed" | "skipped" | "partial";
  output_signature?: unknown;
  postconditions?: Array<Record<string, unknown>>;
  artifact_refs?: string[];
  repair_applied?: boolean;
  repair_note?: string;
  error?: string;
  metadata?: Record<string, unknown>;
};

export type AionisHostBridgeCompleteRequest = AionisHostBridgeTask & {
  run_id?: string;
  memory_lane?: "private" | "shared";
  goal?: string;
  summary?: string;
  success_criteria?: Record<string, unknown>;
  metrics?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  steps: AionisHostBridgeReplayStep[];
  compile_playbook?: boolean;
  compile?: Pick<AionisReplayPlaybookCompileFromRunRequest, "playbook_id" | "name" | "version" | "matchers" | "success_criteria" | "risk_profile" | "allow_partial" | "metadata">;
  simulate_playbook?: boolean;
  simulate?: Pick<AionisReplayPlaybookRunRequest, "version" | "deterministic_gate" | "params" | "max_steps">;
};

export type AionisHostBridgeCompleteResponse = {
  summary_version: "host_bridge_task_complete_v1";
  task_id: string;
  replay_run_id: string;
  run_start: Awaited<ReturnType<AionisRuntimeClient["memory"]["replay"]["run"]["start"]>>;
  run_end: Awaited<ReturnType<AionisRuntimeClient["memory"]["replay"]["run"]["end"]>>;
  playbook_compile: Awaited<ReturnType<AionisRuntimeClient["memory"]["replay"]["playbooks"]["compileFromRun"]>> | null;
  playbook_simulation: Awaited<ReturnType<AionisRuntimeClient["memory"]["replay"]["playbooks"]["run"]>> | null;
};

export type AionisHostBridge = {
  startTask(input: AionisHostBridgeTask): Promise<AionisHostBridgeTaskStartResponse>;
  inspectTaskContext(input: AionisHostBridgeInspectTaskContextRequest): Promise<AionisHostBridgeTaskContextResponse>;
  planTaskStart(input: AionisHostBridgeTaskStartPlanRequest): Promise<AionisHostBridgeTaskStartPlanResponse>;
  openTaskSession(input: AionisHostBridgeOpenTaskSessionRequest): Promise<AionisHostBridgeTaskSession>;
  pauseTask(input: AionisHostBridgePauseRequest): Promise<AionisHostBridgePauseResponse>;
  resumeTask(input: AionisHostBridgeResumeRequest): Promise<AionisHostBridgeResumeResponse>;
  completeTask(input: AionisHostBridgeCompleteRequest): Promise<AionisHostBridgeCompleteResponse>;
};

function withDefaults<T extends { tenant_id?: string; scope?: string; actor?: string }>(
  base: Pick<AionisHostBridgeTask, "tenant_id" | "scope" | "actor">,
  value: T,
): T {
  return {
    ...value,
    tenant_id: value.tenant_id ?? base.tenant_id,
    scope: value.scope ?? base.scope,
    actor: value.actor ?? base.actor,
  };
}

function buildHostBridgeExecutionIdentity(taskId: string) {
  const normalizedTaskId = String(taskId ?? "").trim();
  return {
    state_id: `handoff-anchor:${normalizedTaskId}`,
    scope: `aionis://handoff/${normalizedTaskId}`,
  };
}

function buildHostBridgeInspectContext(taskText: string, context: Record<string, unknown> | undefined) {
  const mergedContext: Record<string, unknown> = {
    goal: taskText,
    ...(context ?? {}),
  };
  if (!Object.prototype.hasOwnProperty.call(mergedContext, "operator_mode")) {
    mergedContext.operator_mode = "debug";
  }
  return mergedContext;
}

function resolveSessionIdFromResponse(
  response: Awaited<ReturnType<AionisRuntimeClient["memory"]["sessions"]["create"]>>,
  fallbackSessionId: string | undefined,
): string | null {
  if (typeof (response as Record<string, unknown>).session_id === "string") {
    return (response as Record<string, unknown>).session_id as string;
  }
  const nestedSession =
    (response as Record<string, unknown>).session
    && typeof (response as Record<string, unknown>).session === "object"
    && !Array.isArray((response as Record<string, unknown>).session)
      ? ((response as Record<string, unknown>).session as Record<string, unknown>)
      : null;
  if (typeof nestedSession?.session_id === "string") return nestedSession.session_id;
  return typeof fallbackSessionId === "string" && fallbackSessionId.trim().length > 0 ? fallbackSessionId : null;
}

function cloneTaskSessionState(state: AionisHostBridgeTaskSessionState): AionisHostBridgeTaskSessionState {
  return {
    ...state,
    last_transition: state.last_transition ? { ...state.last_transition } : null,
    transitions: state.transitions.map((entry) => ({ ...entry })),
    allowed_actions: [...state.allowed_actions],
    transition_guards: state.transition_guards.map((entry) => ({ ...entry })),
  };
}

function buildTaskSessionTransitionGuards(
  status: AionisHostBridgeTaskSessionStatus,
): AionisHostBridgeTaskSessionTransitionGuard[] {
  const guards: Record<AionisHostBridgeTaskSessionAction, Omit<AionisHostBridgeTaskSessionTransitionGuard, "summary_version" | "action">> = {
    list_events: {
      allowed: true,
      reason: null,
    },
    inspect_context: {
      allowed: true,
      reason: null,
    },
    record_event: {
      allowed: status === "active" || status === "resumed",
      reason:
        status === "paused"
          ? "task session is paused; resume before recording more events"
          : status === "completed"
            ? "task session is completed and is now read-only"
            : null,
    },
    plan_start: {
      allowed: status === "active" || status === "resumed",
      reason:
        status === "paused"
          ? "task session is paused; resume before planning the next start"
          : status === "completed"
            ? "task session is completed and cannot plan a new start"
            : null,
    },
    pause: {
      allowed: status === "active" || status === "resumed",
      reason:
        status === "paused"
          ? "task session is already paused"
          : status === "completed"
            ? "task session is completed and cannot pause again"
            : null,
    },
    resume: {
      allowed: status === "paused",
      reason:
        status === "completed"
          ? "task session is completed and cannot resume"
          : "task session must be paused before it can resume",
    },
    complete: {
      allowed: status === "active" || status === "resumed",
      reason:
        status === "paused"
          ? "task session is paused; resume before marking it complete"
          : status === "completed"
            ? "task session is already completed"
            : null,
    },
  };

  return ([
    "list_events",
    "inspect_context",
    "record_event",
    "plan_start",
    "pause",
    "resume",
    "complete",
  ] as const).map((action) => ({
    summary_version: "host_bridge_task_session_transition_guard_v1",
    action,
    allowed: guards[action].allowed,
    reason: guards[action].reason,
  }));
}

function withTaskSessionControls(state: Omit<AionisHostBridgeTaskSessionState, "allowed_actions" | "transition_guards">): AionisHostBridgeTaskSessionState {
  const transitionGuards = buildTaskSessionTransitionGuards(state.status);
  return {
    ...state,
    allowed_actions: transitionGuards.filter((entry) => entry.allowed).map((entry) => entry.action),
    transition_guards: transitionGuards,
  };
}

function buildTaskSessionTransition(args: {
  transition_kind: AionisHostBridgeTaskSessionTransition["transition_kind"];
  status: AionisHostBridgeTaskSessionStatus;
  detail?: string | null;
}): AionisHostBridgeTaskSessionTransition {
  return {
    summary_version: "host_bridge_task_session_transition_v1",
    transition_kind: args.transition_kind,
    status: args.status,
    at: new Date().toISOString(),
    detail: args.detail ?? null,
  };
}

function buildInitialTaskSessionState(taskId: string, sessionId: string): AionisHostBridgeTaskSessionState {
  const transition = buildTaskSessionTransition({
    transition_kind: "session_opened",
    status: "active",
    detail: "host task session opened",
  });
  return withTaskSessionControls({
    summary_version: "host_bridge_task_session_state_v1",
    task_id: taskId,
    session_id: sessionId,
    status: "active",
    transition_count: 1,
    last_transition: transition,
    transitions: [transition],
    last_startup_mode: null,
    last_handoff_anchor: null,
    last_event_text: null,
  });
}

function advanceTaskSessionState(args: {
  state: AionisHostBridgeTaskSessionState;
  transition_kind: AionisHostBridgeTaskSessionTransition["transition_kind"];
  status: AionisHostBridgeTaskSessionStatus;
  detail?: string | null;
  startup_mode?: AionisHostBridgeStartupDecision["startup_mode"] | null;
  handoff_anchor?: string | null;
  event_text?: string | null;
}): AionisHostBridgeTaskSessionState {
  const transition = buildTaskSessionTransition({
    transition_kind: args.transition_kind,
    status: args.status,
    detail: args.detail,
  });
  return withTaskSessionControls({
    ...args.state,
    status: args.status,
    transition_count: args.state.transition_count + 1,
    last_transition: transition,
    transitions: [...args.state.transitions, transition],
    last_startup_mode: args.startup_mode ?? args.state.last_startup_mode,
    last_handoff_anchor: args.handoff_anchor ?? args.state.last_handoff_anchor,
    last_event_text: args.event_text ?? args.state.last_event_text,
  });
}

function getTaskSessionTransitionGuard(
  state: AionisHostBridgeTaskSessionState,
  action: AionisHostBridgeTaskSessionAction,
): AionisHostBridgeTaskSessionTransitionGuard {
  return state.transition_guards.find((entry) => entry.action === action) ?? {
    summary_version: "host_bridge_task_session_transition_guard_v1",
    action,
    allowed: false,
    reason: "task session action is not available in the current state",
  };
}

function assertTaskSessionActionAllowed(args: {
  state: AionisHostBridgeTaskSessionState;
  action: AionisHostBridgeTaskSessionAction;
}) {
  const guard = getTaskSessionTransitionGuard(args.state, args.action);
  if (!guard.allowed) {
    const actionLabel = args.action.replaceAll("_", " ");
    throw new Error(`host bridge task session cannot ${actionLabel}: ${guard.reason ?? "action is not allowed"}`);
  }
}

function getPlannerExplanation(planningContext: AionisPlanningContextResponse): string | null {
  const planningSummary =
    planningContext.planning_summary && typeof planningContext.planning_summary === "object" && !Array.isArray(planningContext.planning_summary)
      ? (planningContext.planning_summary as Record<string, unknown>)
      : null;
  return typeof planningSummary?.planner_explanation === "string" ? planningSummary.planner_explanation : null;
}

function getTaskStartRationaleSummary(taskStart: AionisTaskStartResponse): string | null {
  const rationale =
    taskStart.rationale && typeof taskStart.rationale === "object" && !Array.isArray(taskStart.rationale)
      ? (taskStart.rationale as Record<string, unknown>)
      : null;
  return typeof rationale?.summary === "string" ? rationale.summary : null;
}

function getPlanningSummaryRecord(
  planningContext: AionisPlanningContextResponse,
): Record<string, unknown> | null {
  return (
    planningContext.planning_summary && typeof planningContext.planning_summary === "object" && !Array.isArray(planningContext.planning_summary)
      ? (planningContext.planning_summary as Record<string, unknown>)
      : null
  );
}

function getPlanningSummaryFirstStep(
  planningContext: AionisPlanningContextResponse,
): Record<string, unknown> | null {
  const planningSummary = getPlanningSummaryRecord(planningContext);
  const firstStep = planningSummary?.first_step_recommendation;
  return firstStep && typeof firstStep === "object" && !Array.isArray(firstStep)
    ? (firstStep as Record<string, unknown>)
    : null;
}

function getPlanningSummaryUncertainty(
  planningContext: AionisPlanningContextResponse,
): AionisActionRetrievalUncertainty | null {
  const planningSummary = getPlanningSummaryRecord(planningContext);
  const uncertainty = planningSummary?.action_retrieval_uncertainty;
  return uncertainty && typeof uncertainty === "object" && !Array.isArray(uncertainty)
    ? (uncertainty as AionisActionRetrievalUncertainty)
    : null;
}

function getPlanningSummaryGateRecord(
  planningContext: AionisPlanningContextResponse,
): Record<string, unknown> | null {
  const planningSummary = getPlanningSummaryRecord(planningContext);
  const gate = planningSummary?.action_retrieval_gate;
  return gate && typeof gate === "object" && !Array.isArray(gate)
    ? (gate as Record<string, unknown>)
    : null;
}

function normalizeTaskStartGateAction(value: unknown): AionisTaskStartGateAction | null {
  return typeof value === "string"
    && (
      value === "inspect_context"
      || value === "widen_recall"
      || value === "rehydrate_payload"
      || value === "request_operator_review"
    )
    ? value
    : null;
}

function getOperatorProjectionGateRecord(
  taskContext: AionisHostBridgeTaskContextResponse,
): Record<string, unknown> | null {
  const gate = taskContext.operator_projection?.action_retrieval_gate;
  return gate && typeof gate === "object" && !Array.isArray(gate)
    ? (gate as Record<string, unknown>)
    : null;
}

function getOperatorProjectionPrimaryHint(
  taskContext: AionisHostBridgeTaskContextResponse,
): AionisHostBridgeOperatorActionHint | null {
  const hints = taskContext.operator_projection?.action_hints;
  if (!Array.isArray(hints) || hints.length === 0) {
    return null;
  }
  const requiredHint = hints.find((hint) => hint?.priority === "required");
  return requiredHint ?? hints[0] ?? null;
}

function buildHostBridgeStartupDecision(args: {
  taskStart: AionisHostBridgeTaskStartResponse;
  taskContext: AionisHostBridgeTaskContextResponse;
}): AionisHostBridgeStartupDecision {
  const firstAction = args.taskStart.first_action;
  const learningSummary = args.taskContext.delegation_learning?.learning_summary;
  const plannerExplanation = getPlannerExplanation(args.taskContext.planning_context) ?? getTaskStartRationaleSummary(args.taskStart.task_start);
  const planningFirstStep = getPlanningSummaryFirstStep(args.taskContext.planning_context);
  const planningUncertainty = getPlanningSummaryUncertainty(args.taskContext.planning_context);
  const planningGate = getPlanningSummaryGateRecord(args.taskContext.planning_context);
  const operatorPrimaryHint = getOperatorProjectionPrimaryHint(args.taskContext);
  const operatorGate = getOperatorProjectionGateRecord(args.taskContext);
  const taskStartKickoff = args.taskStart.task_start.kickoff_recommendation as AionisKickoffRecommendation | null;
  const taskStartUncertainty = (args.taskStart.task_start.action_retrieval_uncertainty ?? null) as AionisActionRetrievalUncertainty | null;
  const operatorGateAction = normalizeTaskStartGateAction(operatorPrimaryHint?.action)
    ?? normalizeTaskStartGateAction(operatorGate?.gate_action);
  const kickoffGateAction = resolveKickoffGateAction({
    kickoff: taskStartKickoff,
    uncertainty: taskStartUncertainty ?? planningUncertainty,
  });
  const planningGateAction = normalizeTaskStartGateAction(planningGate?.gate_action);
  const gateAction = operatorGateAction ?? kickoffGateAction ?? planningGateAction;
  if (firstAction && !gateAction) {
    return {
      summary_version: "host_bridge_startup_decision_v1",
      startup_mode: firstAction.history_applied ? "learned_kickoff" : "planner_fallback",
      gate_action: null,
      tool: firstAction.selected_tool,
      file_path: firstAction.file_path,
      instruction: firstAction.next_action,
      planner_explanation: plannerExplanation,
      task_family: learningSummary?.task_family ?? null,
      matched_records: learningSummary?.matched_records ?? 0,
      recommendation_count: learningSummary?.recommendation_count ?? 0,
    };
  }

  if (gateAction) {
    return {
      summary_version: "host_bridge_startup_decision_v1",
      startup_mode: gateAction,
      gate_action: gateAction,
      tool:
        typeof operatorPrimaryHint?.selected_tool === "string"
          ? operatorPrimaryHint.selected_tool
          : typeof planningFirstStep?.selected_tool === "string"
          ? planningFirstStep.selected_tool
          : null,
      file_path:
        typeof operatorPrimaryHint?.file_path === "string"
          ? operatorPrimaryHint.file_path
          : typeof planningFirstStep?.file_path === "string"
          ? planningFirstStep.file_path
          : null,
      instruction:
        typeof operatorPrimaryHint?.instruction === "string"
          ? operatorPrimaryHint.instruction
          : typeof operatorGate?.instruction === "string"
          ? operatorGate.instruction
          : typeof planningGate?.instruction === "string"
          ? planningGate.instruction
          : typeof planningFirstStep?.next_action === "string"
          ? planningFirstStep.next_action
          : plannerExplanation,
      planner_explanation: plannerExplanation,
      task_family: learningSummary?.task_family ?? null,
      matched_records: learningSummary?.matched_records ?? 0,
      recommendation_count: learningSummary?.recommendation_count ?? 0,
    };
  }

  return {
    summary_version: "host_bridge_startup_decision_v1",
    startup_mode: "manual_triage",
    gate_action: null,
    tool: null,
    file_path: null,
    instruction: null,
    planner_explanation: plannerExplanation,
    task_family: learningSummary?.task_family ?? null,
    matched_records: learningSummary?.matched_records ?? 0,
    recommendation_count: learningSummary?.recommendation_count ?? 0,
  };
}

function buildDefaultExecutionState(input: AionisHostBridgePauseRequest) {
  const existing = input.execution_state_v1 ?? {};
  const identity = buildHostBridgeExecutionIdentity(input.task_id);
  const targetFiles = input.target_files ?? (input.file_path ? [input.file_path] : []);
  const acceptanceChecks = input.acceptance_checks ?? [];
  const updatedAt = typeof existing.updated_at === "string" && existing.updated_at.trim().length > 0
    ? existing.updated_at
    : new Date().toISOString();

  return {
    ...existing,
    state_id: typeof existing.state_id === "string" && existing.state_id.trim().length > 0 ? existing.state_id : identity.state_id,
    scope: typeof existing.scope === "string" && existing.scope.trim().length > 0 ? existing.scope : identity.scope,
    task_brief: typeof existing.task_brief === "string" && existing.task_brief.trim().length > 0 ? existing.task_brief : input.summary,
    current_stage:
      typeof existing.current_stage === "string" && existing.current_stage.trim().length > 0
        ? existing.current_stage
        : DEFAULT_EXECUTION_STAGE,
    active_role:
      typeof existing.active_role === "string" && existing.active_role.trim().length > 0
        ? existing.active_role
        : DEFAULT_EXECUTION_ROLE,
    owned_files: Array.isArray(existing.owned_files) ? existing.owned_files : targetFiles,
    modified_files: Array.isArray(existing.modified_files) ? existing.modified_files : [],
    pending_validations: Array.isArray(existing.pending_validations) ? existing.pending_validations : acceptanceChecks,
    completed_validations: Array.isArray(existing.completed_validations) ? existing.completed_validations : [],
    last_accepted_hypothesis: existing.last_accepted_hypothesis ?? null,
    rejected_paths: Array.isArray(existing.rejected_paths) ? existing.rejected_paths : [],
    unresolved_blockers: Array.isArray(existing.unresolved_blockers) ? existing.unresolved_blockers : [],
    rollback_notes: Array.isArray(existing.rollback_notes) ? existing.rollback_notes : [],
    reviewer_contract: existing.reviewer_contract ?? null,
    resume_anchor: existing.resume_anchor ?? {
      anchor: input.task_id,
      file_path: input.file_path ?? null,
      symbol: input.symbol ?? null,
      repo_root: input.repo_root ?? null,
    },
    updated_at: updatedAt,
    version: 1,
  };
}

function buildDefaultExecutionPacket(input: AionisHostBridgePauseRequest, state: Record<string, unknown>) {
  const existing = input.execution_packet_v1 ?? {};
  const targetFiles = input.target_files ?? (input.file_path ? [input.file_path] : []);
  const acceptanceChecks = input.acceptance_checks ?? [];

  return {
    ...existing,
    version: 1,
    state_id: typeof existing.state_id === "string" && existing.state_id.trim().length > 0
      ? existing.state_id
      : state.state_id,
    current_stage:
      typeof existing.current_stage === "string" && existing.current_stage.trim().length > 0
        ? existing.current_stage
        : state.current_stage,
    active_role:
      typeof existing.active_role === "string" && existing.active_role.trim().length > 0
        ? existing.active_role
        : state.active_role,
    task_brief: typeof existing.task_brief === "string" && existing.task_brief.trim().length > 0 ? existing.task_brief : input.summary,
    target_files: Array.isArray(existing.target_files) ? existing.target_files : targetFiles,
    next_action:
      typeof existing.next_action === "string" && existing.next_action.trim().length > 0
        ? existing.next_action
        : (input.next_action ?? null),
    hard_constraints: Array.isArray(existing.hard_constraints) ? existing.hard_constraints : [],
    accepted_facts: Array.isArray(existing.accepted_facts) ? existing.accepted_facts : [],
    rejected_paths: Array.isArray(existing.rejected_paths) ? existing.rejected_paths : [],
    pending_validations: Array.isArray(existing.pending_validations) ? existing.pending_validations : acceptanceChecks,
    unresolved_blockers: Array.isArray(existing.unresolved_blockers) ? existing.unresolved_blockers : [],
    rollback_notes: Array.isArray(existing.rollback_notes) ? existing.rollback_notes : [],
    review_contract: existing.review_contract ?? null,
    resume_anchor: existing.resume_anchor ?? state.resume_anchor ?? {
      anchor: input.task_id,
      file_path: input.file_path ?? null,
      symbol: input.symbol ?? null,
      repo_root: input.repo_root ?? null,
    },
    artifact_refs: Array.isArray(existing.artifact_refs) ? existing.artifact_refs : [],
    evidence_refs: Array.isArray(existing.evidence_refs) ? existing.evidence_refs : [],
  };
}

export function createAionisHostBridge(
  options: AionisClientOptions,
  defaults: Pick<AionisHostBridgeTask, "tenant_id" | "scope" | "actor"> = {},
): AionisHostBridge {
  const client = createAionisRuntimeClient(options);

  const bridge: AionisHostBridge = {
    async startTask(input) {
      const payload: AionisKickoffRecommendationRequest = withDefaults(defaults, {
        tenant_id: input.tenant_id,
        scope: input.scope,
        actor: input.actor,
        query_text: input.text,
        context: {
          goal: input.text,
          ...(input.context ?? {}),
        },
        candidates: input.candidates ?? DEFAULT_TOOL_CANDIDATES,
      });

      const taskStart = await client.memory.taskStart(payload);
      return {
        summary_version: "host_bridge_task_start_v1",
        task_id: input.task_id,
        first_action: taskStart.first_action,
        task_start: taskStart,
      };
    },

    async inspectTaskContext(input) {
      const payload: AionisPlanningContextRequest = withDefaults(defaults, {
        tenant_id: input.tenant_id,
        scope: input.scope,
        actor: input.actor,
        query_text: input.text,
        run_id: input.run_id,
        context: buildHostBridgeInspectContext(input.text, input.context),
        tool_candidates: input.candidates ?? DEFAULT_TOOL_CANDIDATES,
        tool_strict: input.tool_strict ?? true,
        include_shadow: input.include_shadow ?? false,
        rules_limit: input.rules_limit ?? 50,
        return_layered_context: true,
        context_layers: input.context_layers,
        static_context_blocks: input.static_context_blocks,
        static_injection: input.static_injection,
        memory_layer_preference: input.memory_layer_preference,
        execution_result_summary: input.execution_result_summary,
        execution_artifacts: input.execution_artifacts,
        execution_evidence: input.execution_evidence,
        execution_state_v1: input.execution_state_v1,
        execution_packet_v1: input.execution_packet_v1,
      });
      const planning_context = await client.memory.planningContext(payload);
      const operator_projection = resolveContextOperatorProjection(planning_context);
      return {
        summary_version: "host_bridge_task_context_v1",
        task_id: input.task_id,
        planning_context,
        operator_projection,
        delegation_learning: operator_projection?.delegation_learning ?? null,
      };
    },

    async planTaskStart(input) {
      const [task_context, task_start] = await Promise.all([
        bridge.inspectTaskContext(input),
        bridge.startTask(input),
      ]);
      return {
        summary_version: "host_bridge_task_start_plan_v1",
        task_id: input.task_id,
        decision: buildHostBridgeStartupDecision({
          taskStart: task_start,
          taskContext: task_context,
        }),
        first_action: task_start.first_action,
        task_start: task_start.task_start,
        task_context,
      };
    },

    async openTaskSession(input) {
      const session = await client.memory.sessions.create(withDefaults(defaults, {
        tenant_id: input.tenant_id,
        scope: input.scope,
        actor: input.actor,
        session_id: input.session_id,
        title: input.title ?? input.text,
        summary: input.summary ?? input.text,
        metadata: input.metadata,
      }));
      const session_id = resolveSessionIdFromResponse(session, input.session_id);
      if (!session_id) {
        throw new Error("host bridge task session create did not return session_id");
      }
      let sessionState = buildInitialTaskSessionState(input.task_id, session_id);
      const sessionBridge: AionisHostBridgeTaskSession = {
        summary_version: "host_bridge_task_session_v1",
        task_id: input.task_id,
        task_text: input.text,
        session_id,
        session,
        state: cloneTaskSessionState(sessionState),
        snapshotState() {
          return cloneTaskSessionState(sessionState);
        },
        async recordEvent(eventInput) {
          assertTaskSessionActionAllowed({
            state: sessionState,
            action: "record_event",
          });
          const eventText = typeof eventInput.event_text === "string"
            ? eventInput.event_text
            : typeof eventInput.input_text === "string"
              ? eventInput.input_text
              : null;
          const event = await client.memory.sessions.writeEvent(withDefaults(defaults, {
            tenant_id: input.tenant_id,
            scope: input.scope,
            actor: input.actor,
            session_id,
            ...eventInput,
          }));
          sessionState = advanceTaskSessionState({
            state: sessionState,
            transition_kind: "event_recorded",
            status: sessionState.status,
            detail: eventText,
            event_text: eventText,
          });
          sessionBridge.state = cloneTaskSessionState(sessionState);
          return event;
        },
        async listEvents(eventsQuery) {
          assertTaskSessionActionAllowed({
            state: sessionState,
            action: "list_events",
          });
          return await client.memory.sessions.events({
            tenant_id: input.tenant_id ?? defaults.tenant_id,
            scope: input.scope ?? defaults.scope,
            session_id,
            ...eventsQuery,
          });
        },
        async inspectTaskContext(inspectInput = {}) {
          assertTaskSessionActionAllowed({
            state: sessionState,
            action: "inspect_context",
          });
          return await bridge.inspectTaskContext({
            ...inspectInput,
            task_id: input.task_id,
            tenant_id: input.tenant_id,
            scope: input.scope,
            actor: input.actor,
            text: inspectInput.text ?? input.text,
          });
        },
        async planTaskStart(planInput = {}) {
          assertTaskSessionActionAllowed({
            state: sessionState,
            action: "plan_start",
          });
          const plan = await bridge.planTaskStart({
            ...planInput,
            task_id: input.task_id,
            tenant_id: input.tenant_id,
            scope: input.scope,
            actor: input.actor,
            text: planInput.text ?? input.text,
          });
          sessionState = advanceTaskSessionState({
            state: sessionState,
            transition_kind: "startup_planned",
            status: sessionState.status,
            detail: plan.decision.startup_mode,
            startup_mode: plan.decision.startup_mode,
          });
          sessionBridge.state = cloneTaskSessionState(sessionState);
          return plan;
        },
        async pauseTask(pauseInput) {
          assertTaskSessionActionAllowed({
            state: sessionState,
            action: "pause",
          });
          const pause = await bridge.pauseTask({
            ...pauseInput,
            task_id: input.task_id,
            tenant_id: input.tenant_id,
            scope: input.scope,
            actor: input.actor,
            text: pauseInput.text ?? input.text,
          });
          const handoff =
            pause.handoff && typeof pause.handoff === "object" && !Array.isArray(pause.handoff)
              ? (pause.handoff as Record<string, unknown>)
              : null;
          sessionState = advanceTaskSessionState({
            state: sessionState,
            transition_kind: "paused",
            status: "paused",
            detail: typeof pauseInput.summary === "string" ? pauseInput.summary : null,
            handoff_anchor: typeof handoff?.anchor === "string" ? handoff.anchor : input.task_id,
          });
          sessionBridge.state = cloneTaskSessionState(sessionState);
          return pause;
        },
        async resumeTask(resumeInput = {}) {
          assertTaskSessionActionAllowed({
            state: sessionState,
            action: "resume",
          });
          const resume = await bridge.resumeTask({
            ...resumeInput,
            task_id: input.task_id,
            tenant_id: input.tenant_id,
            scope: input.scope,
            actor: input.actor,
          });
          const handoff =
            resume.handoff && typeof resume.handoff === "object" && !Array.isArray(resume.handoff)
              ? (resume.handoff as Record<string, unknown>)
              : null;
          sessionState = advanceTaskSessionState({
            state: sessionState,
            transition_kind: "resumed",
            status: "resumed",
            detail: "task resumed from handoff",
            handoff_anchor: typeof handoff?.anchor === "string" ? handoff.anchor : input.task_id,
          });
          sessionBridge.state = cloneTaskSessionState(sessionState);
          return resume;
        },
        async completeTask(completeInput) {
          assertTaskSessionActionAllowed({
            state: sessionState,
            action: "complete",
          });
          const complete = await bridge.completeTask({
            ...completeInput,
            task_id: input.task_id,
            tenant_id: input.tenant_id,
            scope: input.scope,
            actor: input.actor,
            text: completeInput.text ?? input.text,
          });
          sessionState = advanceTaskSessionState({
            state: sessionState,
            transition_kind: "completed",
            status: "completed",
            detail: completeInput.summary ?? completeInput.text ?? input.text,
          });
          sessionBridge.state = cloneTaskSessionState(sessionState);
          return complete;
        },
      };
      return sessionBridge;
    },

    async pauseTask(input) {
      const executionState = buildDefaultExecutionState(input);
      const executionPacket = buildDefaultExecutionPacket(input, executionState);
      const payload: AionisHandoffStoreRequest = withDefaults(defaults, {
        tenant_id: input.tenant_id,
        scope: input.scope,
        actor: input.actor,
        handoff_kind: input.handoff_kind ?? "task_handoff",
        anchor: input.task_id,
        summary: input.summary,
        handoff_text: input.handoff_text,
        memory_lane: input.memory_lane ?? "shared",
        file_path: input.file_path,
        repo_root: input.repo_root,
        symbol: input.symbol,
        risk: input.risk,
        acceptance_checks: input.acceptance_checks,
        tags: input.tags,
        target_files: input.target_files,
        next_action: input.next_action,
        must_change: input.must_change,
        must_remove: input.must_remove,
        must_keep: input.must_keep,
        execution_result_summary: input.execution_result_summary,
        execution_artifacts: input.execution_artifacts,
        execution_evidence: input.execution_evidence,
        execution_state_v1: executionState,
        execution_packet_v1: executionPacket,
        control_profile_v1: input.control_profile_v1,
        execution_transitions_v1: input.execution_transitions_v1,
      });
      const handoff = await client.handoff.store(payload);
      return {
        summary_version: "host_bridge_task_pause_v1",
        task_id: input.task_id,
        handoff,
      };
    },

    async resumeTask(input) {
      const payload: AionisHandoffRecoverRequest = withDefaults(defaults, {
        tenant_id: input.tenant_id,
        scope: input.scope,
        actor: input.actor,
        handoff_id: input.handoff_id,
        handoff_uri: input.handoff_uri,
        anchor: input.task_id,
        handoff_kind: input.handoff_kind ?? "task_handoff",
        repo_root: input.repo_root,
        file_path: input.file_path,
        symbol: input.symbol,
        include_payload: input.include_payload,
      });
      const handoff = await client.handoff.recover(payload);
      return {
        summary_version: "host_bridge_task_resume_v1",
        task_id: input.task_id,
        handoff,
      };
    },

    async completeTask(input) {
      const run_id = input.run_id ?? randomUUID();
      const runStartPayload: AionisReplayRunStartRequest = withDefaults(defaults, {
        tenant_id: input.tenant_id,
        scope: input.scope,
        actor: input.actor,
        run_id,
        memory_lane: input.memory_lane ?? "shared",
        goal: input.goal ?? input.text,
        metadata: input.metadata,
      });
      const run_start = await client.memory.replay.run.start(runStartPayload);

      for (let index = 0; index < input.steps.length; index += 1) {
        const step = input.steps[index];
        const beforePayload: AionisReplayStepBeforeRequest = withDefaults(defaults, {
          tenant_id: input.tenant_id,
          scope: input.scope,
          actor: input.actor,
          run_id,
          step_id: step.step_id,
          decision_id: step.decision_id,
          step_index: index + 1,
          tool_name: step.tool_name,
          tool_input: step.tool_input,
          expected_output_signature: step.expected_output_signature,
          preconditions: step.preconditions,
          retry_policy: step.retry_policy,
          safety_level: step.safety_level,
          metadata: step.metadata,
          memory_lane: input.memory_lane ?? "private",
        });
        const before = await client.memory.replay.step.before(beforePayload) as { step_id?: string };

        const afterPayload: AionisReplayStepAfterRequest = withDefaults(defaults, {
          tenant_id: input.tenant_id,
          scope: input.scope,
          actor: input.actor,
          run_id,
          step_id: before.step_id ?? step.step_id,
          step_index: index + 1,
          status: step.status,
          output_signature: step.output_signature,
          postconditions: step.postconditions,
          artifact_refs: step.artifact_refs,
          repair_applied: step.repair_applied,
          repair_note: step.repair_note,
          error: step.error,
          metadata: step.metadata,
          memory_lane: input.memory_lane ?? "private",
        });
        await client.memory.replay.step.after(afterPayload);
      }

      const runEndPayload: AionisReplayRunEndRequest = withDefaults(defaults, {
        tenant_id: input.tenant_id,
        scope: input.scope,
        actor: input.actor,
        run_id,
        status: "success",
        summary: input.summary,
        success_criteria: input.success_criteria,
        metrics: input.metrics,
        metadata: input.metadata,
        memory_lane: input.memory_lane ?? "private",
      });
      const run_end = await client.memory.replay.run.end(runEndPayload);

      let playbook_compile: AionisHostBridgeCompleteResponse["playbook_compile"] = null;
      let playbook_simulation: AionisHostBridgeCompleteResponse["playbook_simulation"] = null;
      const shouldCompile = input.compile_playbook ?? true;

      if (shouldCompile) {
        playbook_compile = await client.memory.replay.playbooks.compileFromRun(withDefaults(defaults, {
          tenant_id: input.tenant_id,
          scope: input.scope,
          actor: input.actor,
          run_id,
          memory_lane: input.memory_lane ?? "private",
          ...(input.compile ?? {}),
        }));

        const playbook_id = (playbook_compile as { playbook_id?: string | null }).playbook_id;
        const shouldSimulate = input.simulate_playbook ?? true;
        if (playbook_id && shouldSimulate) {
          playbook_simulation = await client.memory.replay.playbooks.run(withDefaults(defaults, {
            tenant_id: input.tenant_id,
            scope: input.scope,
            actor: input.actor,
            playbook_id,
            mode: "simulate",
            memory_lane: input.memory_lane ?? "private",
            ...(input.simulate ?? {}),
          }));
        }
      }

      return {
        summary_version: "host_bridge_task_complete_v1",
        task_id: input.task_id,
        replay_run_id: run_id,
        run_start,
        run_end,
        playbook_compile,
        playbook_simulation,
      };
    },
  };

  return bridge;
}
