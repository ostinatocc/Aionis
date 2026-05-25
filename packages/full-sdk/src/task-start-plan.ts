import type {
  AionisActionRetrievalUncertainty,
  AionisKickoffRecommendation,
  AionisKickoffRecommendationResponse,
  AionisPlanningContextRequest,
  AionisPlanningContextResponse,
  AionisTaskStartGateAction,
  AionisTaskStartPlanRequest,
  AionisTaskStartPlanResponse,
} from "./contracts.js";
import { AIONIS_SHARED_ROUTE_PATHS } from "./routes.js";
import {
  buildTaskStartAction,
  resolveKickoffGateAction,
  shouldEscalateKickoffAction,
} from "./task-start.js";
import type { AionisHttpClient } from "./types.js";

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readPlanningSummary(response: AionisPlanningContextResponse): Record<string, unknown> {
  return asRecord(response.planning_summary) ?? {};
}

function readPlanningSummaryUncertainty(
  response: AionisPlanningContextResponse,
): AionisActionRetrievalUncertainty | null {
  return (readPlanningSummary(response).action_retrieval_uncertainty ?? null) as AionisActionRetrievalUncertainty | null;
}

function readPlanningSummaryGateAction(
  response: AionisPlanningContextResponse,
): AionisTaskStartGateAction | null {
  const gate = asRecord(readPlanningSummary(response).action_retrieval_gate);
  const gateAction = gate?.gate_action;
  return gateAction === "inspect_context"
    || gateAction === "widen_recall"
    || gateAction === "rehydrate_payload"
    || gateAction === "request_operator_review"
    ? gateAction
    : null;
}

function readPlanningSummaryFirstStep(
  response: AionisPlanningContextResponse,
): AionisKickoffRecommendation | null {
  return (readPlanningSummary(response).first_step_recommendation ?? null) as AionisKickoffRecommendation | null;
}

function readPlanningSummaryExplanation(response: AionisPlanningContextResponse): string | null {
  const explanation = readPlanningSummary(response).planner_explanation;
  return typeof explanation === "string" ? explanation : null;
}

export function createTaskStartPlanMethod(client: AionisHttpClient) {
  return async function taskStartPlan(
    payload: AionisTaskStartPlanRequest,
  ): Promise<AionisTaskStartPlanResponse> {
    const kickoffResponse = await client.post<AionisTaskStartPlanRequest, AionisKickoffRecommendationResponse>({
      path: AIONIS_SHARED_ROUTE_PATHS.kickoffRecommendation,
      payload,
    });
    const kickoffEscalated = shouldEscalateKickoffAction({
      kickoff: kickoffResponse.kickoff_recommendation,
      uncertainty: kickoffResponse.action_retrieval_uncertainty ?? null,
    });
    const kickoffGateAction = resolveKickoffGateAction({
      kickoff: kickoffResponse.kickoff_recommendation,
      uncertainty: kickoffResponse.action_retrieval_uncertainty ?? null,
    });
    const kickoffAction = buildTaskStartAction(
      kickoffResponse.kickoff_recommendation,
      kickoffResponse.action_retrieval_uncertainty ?? null,
    );
    if (kickoffAction) {
      return {
        summary_version: "task_start_plan_v1",
        resolution_source: "kickoff",
        tenant_id: kickoffResponse.tenant_id,
        scope: kickoffResponse.scope,
        query_text: kickoffResponse.query_text,
        kickoff_recommendation: kickoffResponse.kickoff_recommendation,
        gate_action: null,
        action_retrieval_uncertainty: kickoffResponse.action_retrieval_uncertainty ?? null,
        first_action: kickoffAction,
        planner_explanation: null,
        planner_packet: null,
        rationale: kickoffResponse.rationale,
      };
    }

    const planningResponse = await client.post<AionisPlanningContextRequest, AionisPlanningContextResponse>({
      path: AIONIS_SHARED_ROUTE_PATHS.planningContext,
      payload: {
        tenant_id: payload.tenant_id,
        scope: payload.scope,
        query_text: payload.query_text,
        recall_strategy: payload.recall_strategy,
        recall_mode: payload.recall_mode,
        recall_class_aware: payload.recall_class_aware,
        consumer_agent_id: payload.consumer_agent_id,
        consumer_team_id: payload.consumer_team_id,
        include_shadow: payload.include_shadow,
        rules_limit: payload.rules_limit,
        run_id: payload.run_id,
        context: payload.context,
        tool_candidates: payload.candidates,
        tool_strict: payload.tool_strict ?? payload.strict,
        limit: payload.limit,
        neighborhood_hops: payload.neighborhood_hops,
        return_debug: payload.return_debug,
        include_embeddings: payload.include_embeddings,
        include_meta: payload.include_meta,
        include_slots: payload.include_slots,
        include_slots_preview: payload.include_slots_preview,
        slots_preview_keys: payload.slots_preview_keys,
        max_nodes: payload.max_nodes,
        max_edges: payload.max_edges,
        ranked_limit: payload.ranked_limit,
        min_edge_weight: payload.min_edge_weight,
        min_edge_confidence: payload.min_edge_confidence,
        context_token_budget: payload.context_token_budget,
        context_char_budget: payload.context_char_budget,
        context_compaction_profile: payload.context_compaction_profile,
        context_optimization_profile: payload.context_optimization_profile,
        memory_layer_preference: payload.memory_layer_preference,
        return_layered_context: payload.return_layered_context,
        context_layers: payload.context_layers,
        static_context_blocks: payload.static_context_blocks,
        static_injection: payload.static_injection,
        execution_result_summary: payload.execution_result_summary,
        execution_artifacts: payload.execution_artifacts,
        execution_evidence: payload.execution_evidence,
        execution_state_v1: payload.execution_state_v1,
        execution_packet_v1: payload.execution_packet_v1,
        workflow_limit: payload.workflow_limit,
      },
    });
    const fallbackKickoff =
      planningResponse.kickoff_recommendation
      ?? readPlanningSummaryFirstStep(planningResponse)
      ?? null;
    const planningUncertainty = readPlanningSummaryUncertainty(planningResponse);
    const gateAction =
      kickoffGateAction
      ?? readPlanningSummaryGateAction(planningResponse)
      ?? resolveKickoffGateAction({
        kickoff: fallbackKickoff,
        uncertainty: planningUncertainty,
      });
    const plannerExplanation = readPlanningSummaryExplanation(planningResponse);

    return {
      summary_version: "task_start_plan_v1",
      resolution_source: "planning_context",
      tenant_id: payload.tenant_id ?? kickoffResponse.tenant_id ?? "default",
      scope: payload.scope ?? kickoffResponse.scope ?? "default",
      query_text: payload.query_text,
      kickoff_recommendation: fallbackKickoff,
      gate_action: gateAction,
      action_retrieval_uncertainty: kickoffResponse.action_retrieval_uncertainty ?? planningUncertainty,
      first_action: buildTaskStartAction(fallbackKickoff, planningUncertainty),
      planner_explanation: plannerExplanation,
      planner_packet: asRecord(planningResponse.planner_packet),
      rationale: {
        summary:
          kickoffEscalated
            ? `Escalated kickoff to planning_context because action retrieval uncertainty required deeper planning${gateAction ? ` (${gateAction})` : ""}. ${plannerExplanation ?? ""}`.trim()
            : (
              plannerExplanation
              ?? "Used planning context to derive the first action after kickoff fallback."
            ),
      },
    };
  };
}
