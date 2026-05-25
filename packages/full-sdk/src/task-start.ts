import type {
  AionisActionRetrievalUncertainty,
  AionisKickoffRecommendation,
  AionisKickoffRecommendationResponse,
  AionisTaskStartAction,
  AionisTaskStartResponse,
} from "./contracts.js";

export type AionisTaskStartGateAction = Exclude<
  AionisActionRetrievalUncertainty["recommended_actions"][number],
  "proceed"
>;

export function resolveKickoffGateAction(args: {
  kickoff: AionisKickoffRecommendation | null | undefined;
  uncertainty?: AionisActionRetrievalUncertainty | null;
}): AionisTaskStartGateAction | null {
  if (!args.kickoff?.selected_tool) return null;
  if (!shouldEscalateKickoffAction(args)) return null;
  const uncertainty = args.uncertainty;
  if (!uncertainty) return "inspect_context";
  if (uncertainty.recommended_actions.includes("request_operator_review")) return "request_operator_review";
  if (uncertainty.recommended_actions.includes("rehydrate_payload")) return "rehydrate_payload";
  if (uncertainty.recommended_actions.includes("widen_recall")) return "widen_recall";
  if (uncertainty.recommended_actions.includes("inspect_context")) return "inspect_context";
  return "inspect_context";
}

export function shouldEscalateKickoffAction(args: {
  kickoff: AionisKickoffRecommendation | null | undefined;
  uncertainty?: AionisActionRetrievalUncertainty | null;
}): boolean {
  const uncertainty = args.uncertainty;
  if (!args.kickoff?.selected_tool) return true;
  if (!uncertainty) return false;
  if (uncertainty.level === "high") return true;
  if (
    uncertainty.recommended_actions.includes("widen_recall")
    || uncertainty.recommended_actions.includes("rehydrate_payload")
    || uncertainty.recommended_actions.includes("request_operator_review")
  ) {
    return true;
  }
  if (
    uncertainty.recommended_actions.includes("inspect_context")
    && !args.kickoff.file_path
    && args.kickoff.source_kind === "experience_intelligence"
  ) {
    return true;
  }
  return false;
}

export function buildTaskStartAction(
  kickoff: AionisKickoffRecommendation | null | undefined,
  uncertainty?: AionisActionRetrievalUncertainty | null,
): AionisTaskStartAction | null {
  if (!kickoff?.selected_tool) return null;
  if (resolveKickoffGateAction({ kickoff, uncertainty })) return null;
  return {
    action_kind: kickoff.file_path ? "file_step" : "tool_step",
    source_kind: kickoff.source_kind,
    history_applied: kickoff.history_applied,
    selected_tool: kickoff.selected_tool,
    file_path: kickoff.file_path,
    next_action: kickoff.next_action,
  };
}

export function toTaskStartResponse(
  response: AionisKickoffRecommendationResponse,
): AionisTaskStartResponse {
  return {
    ...response,
    summary_version: "task_start_v1",
    first_action: buildTaskStartAction(
      response.kickoff_recommendation,
      response.action_retrieval_uncertainty ?? null,
    ),
  };
}
