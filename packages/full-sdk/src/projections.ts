import type {
  AionisContextAssembleResponse,
  AionisContextOperatorProjection,
  AionisDelegationLearningProjection,
  AionisPlanningContextResponse,
} from "./contracts.js";

type AionisContextProjectionCarrier =
  | Pick<AionisPlanningContextResponse, "operator_projection" | "layered_context">
  | Pick<AionisContextAssembleResponse, "operator_projection" | "layered_context">;

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function readDelegationLearningProjection(value: unknown): AionisDelegationLearningProjection | null {
  const projection = asObject(value);
  if (!projection) return null;
  if (projection.summary_version !== "delegation_learning_projection_v1") return null;
  return projection as AionisDelegationLearningProjection;
}

export function resolveContextOperatorProjection(
  response: AionisContextProjectionCarrier,
): AionisContextOperatorProjection | null {
  const operatorProjection = asObject(response.operator_projection);
  const directDelegationLearning = readDelegationLearningProjection(operatorProjection?.delegation_learning);
  const directActionHints = Array.isArray(operatorProjection?.action_hints)
    ? operatorProjection.action_hints
    : null;
  const directActionGate = asObject(operatorProjection?.action_retrieval_gate);
  if (directDelegationLearning) {
    return {
      ...operatorProjection,
      delegation_learning: directDelegationLearning,
    } as AionisContextOperatorProjection;
  }
  if (directActionHints || directActionGate) {
    return operatorProjection as AionisContextOperatorProjection;
  }

  const layeredContext = asObject(response.layered_context);
  const mirroredDelegationLearning = readDelegationLearningProjection(layeredContext?.delegation_learning);
  if (!mirroredDelegationLearning) return null;

  return {
    delegation_learning: mirroredDelegationLearning,
  };
}

export function resolveDelegationLearningProjection(
  response: AionisContextProjectionCarrier,
): AionisDelegationLearningProjection | null {
  return resolveContextOperatorProjection(response)?.delegation_learning ?? null;
}
