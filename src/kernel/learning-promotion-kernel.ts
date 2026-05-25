import { buildOutcomeContractGate } from "../memory/contract-trust.js";
import {
  appendLearningControlRuntimePolicyAppliedStage,
  buildControlledStateDecisionTrace,
  deriveControlledStateRaisePreview,
  deriveControlledStateRaiseRuntimeApply,
} from "../memory/learning-control-shared.js";
import type { PromoteMemoryLearningControlReviewProvider } from "../memory/learning-control-provider-types.js";
import type { PromoteMemoryLearningControlCandidateExample } from "../memory/learning-control-promote-memory.js";
import { runPromoteMemoryLearningControlPreview } from "../memory/learning-control-promote-memory-shared.js";
import {
  MemoryPromoteRequest,
  WorkflowWriteProjectionLearningControlDecisionTraceSchema,
  WorkflowWriteProjectionLearningControlPolicyEffectSchema,
  type ContractTrust,
  type MemoryAdmissibilityResult,
  type MemoryPromoteSemanticReviewPacket,
  type MemoryPromoteSemanticReviewResult,
  type WorkflowWriteProjectionLearningControlDecisionTrace,
  type WorkflowWriteProjectionLearningControlPolicyEffect,
} from "../memory/schemas.js";

type WorkflowPromotionCandidateExample = PromoteMemoryLearningControlCandidateExample;

export function deriveWorkflowPromotionSemanticPolicyEffect(args: {
  basePromotionState: "candidate" | "stable";
  contractTrust?: ContractTrust | null;
  executionContract?: unknown;
  executionEvidenceAssessment?: {
    allows_stable_promotion?: boolean;
  } | null;
  review: MemoryPromoteSemanticReviewResult | null;
  admissibility: MemoryAdmissibilityResult | null;
  minPromotionConfidence?: number;
}): WorkflowWriteProjectionLearningControlPolicyEffect {
  const minPromotionConfidence = args.minPromotionConfidence ?? 0.85;
  const outcomeContractGate = buildOutcomeContractGate({
    executionContract: args.executionContract,
    requestedTrust: args.contractTrust ?? null,
  });
  const derived = deriveControlledStateRaisePreview({
    baseState: args.basePromotionState,
    review: args.review,
    admissibility: args.admissibility,
    defaultSource: "default_workflow_promotion_state",
    reviewSource: "workflow_promotion_learning_control_review",
    noReviewReason: "review_not_supplied",
    notAdmissibleReason: "review_not_admissible",
    noRaiseReason: "review_did_not_raise_promotion_state",
    applyReason: "high_confidence_workflow_promotion",
    noRaiseSuggestedState: args.basePromotionState,
    appliedState: "stable",
    extraNoApplyGuards: [
      {
        when: args.contractTrust !== "authoritative",
        reason: "contract_trust_below_authoritative",
        reviewSuggestedState: "stable",
      },
      {
        when: args.contractTrust === "authoritative" && !outcomeContractGate.allows_authoritative,
        reason: "outcome_contract_insufficient",
        reviewSuggestedState: "stable",
      },
      {
        when: args.executionEvidenceAssessment?.allows_stable_promotion === false,
        reason: "execution_evidence_insufficient",
        reviewSuggestedState: "stable",
      },
      {
        when: args.basePromotionState === "stable",
        reason: "already_stable",
        reviewSuggestedState: "stable",
      },
    ],
    shouldApply: (review) =>
      review.adjudication.disposition === "recommend"
      && review.adjudication.target_kind === "workflow"
      && review.adjudication.target_level === "L2"
      && review.adjudication.strategic_value === "high"
      && review.adjudication.confidence >= minPromotionConfidence,
  });

  return WorkflowWriteProjectionLearningControlPolicyEffectSchema.parse({
    source: derived.source,
    applies: derived.applies,
    base_promotion_state: derived.baseState,
    review_suggested_promotion_state: derived.reviewSuggestedState,
    effective_promotion_state: derived.effectiveState,
    reason_code: derived.reasonCode,
    outcome_contract_gate: outcomeContractGate,
  });
}

export async function buildWorkflowPromotionLearningControlPreview(args: {
  candidateNodeIds: string[];
  inputText: string;
  inputSha256: string;
  candidateExamples: WorkflowPromotionCandidateExample[];
  contractTrust?: ContractTrust | null;
  executionContract?: unknown;
  executionEvidenceAssessment?: {
    allows_stable_promotion?: boolean;
    reasons?: string[];
  } | null;
  reviewResult?: MemoryPromoteSemanticReviewResult | null;
  reviewProvider?: PromoteMemoryLearningControlReviewProvider | null;
}): Promise<{
  promote_memory: {
    review_packet: MemoryPromoteSemanticReviewPacket;
    review_result: MemoryPromoteSemanticReviewResult | null;
    admissibility: MemoryAdmissibilityResult | null;
    policy_effect: WorkflowWriteProjectionLearningControlPolicyEffect;
    decision_trace: WorkflowWriteProjectionLearningControlDecisionTrace;
  };
  runtime_apply: {
    promotion_state_override: "stable" | null;
    changed_promotion_state: boolean;
  };
}> {
  const input = MemoryPromoteRequest.parse({
    candidate_node_ids: args.candidateNodeIds,
    target_kind: "workflow",
    target_level: "L2",
    write_anchor: true,
    input_text: args.inputText,
    input_sha256: args.inputSha256,
  });

  const promotePreview = await runPromoteMemoryLearningControlPreview({
    input,
    candidateExamples: args.candidateExamples,
    reviewResult: args.reviewResult ?? null,
    reviewProvider: args.reviewProvider ?? undefined,
    derivePolicyEffect: ({ review, admissibility }) =>
      deriveWorkflowPromotionSemanticPolicyEffect({
        basePromotionState: "candidate",
        contractTrust: args.contractTrust ?? null,
        executionContract: args.executionContract,
        executionEvidenceAssessment: args.executionEvidenceAssessment ?? null,
        review,
        admissibility,
      }),
    buildDecisionTrace: ({ reviewResult, admissibility, policyEffect }) => {
      const trace = buildControlledStateDecisionTrace({
        reviewResult,
        admissibility,
        policyEffect,
        includePolicyEffectReasonCode: !policyEffect.applies,
        baseState: "candidate",
        effectiveState: policyEffect.effective_promotion_state,
      });
      return WorkflowWriteProjectionLearningControlDecisionTraceSchema.parse({
        trace_version: "workflow_promotion_learning_control_trace_v1",
        review_supplied: trace.review_supplied,
        admissibility_evaluated: trace.admissibility_evaluated,
        admissible: trace.admissible,
        policy_effect_applies: trace.policy_effect_applies,
        base_promotion_state: trace.baseState,
        effective_promotion_state: trace.effectiveState,
        runtime_apply_changed_promotion_state: false,
        stage_order: trace.stage_order as WorkflowWriteProjectionLearningControlDecisionTrace["stage_order"],
        reason_codes: Array.from(new Set([
          ...trace.reason_codes,
          ...(policyEffect.reason_code === "outcome_contract_insufficient"
            ? (policyEffect.outcome_contract_gate?.reasons ?? []).map((reason) => `outcome_contract:${reason}`)
            : []),
          ...(policyEffect.reason_code === "execution_evidence_insufficient"
            ? (args.executionEvidenceAssessment?.reasons ?? []).map((reason) => `execution_evidence:${reason}`)
            : []),
        ])).slice(0, 8),
        outcome_contract_gate: policyEffect.outcome_contract_gate,
      });
    },
  });
  const applyGate = deriveControlledStateRaiseRuntimeApply({
    policyEffect: promotePreview.policy_effect,
    effectiveState: promotePreview.policy_effect?.effective_promotion_state,
    appliedState: "stable",
  });
  if (applyGate.runtimeApplyRequested) {
    promotePreview.decision_trace.runtime_apply_changed_promotion_state =
      applyGate.controlledOverrideState === "stable";
    promotePreview.decision_trace.stage_order =
      appendLearningControlRuntimePolicyAppliedStage(
        promotePreview.decision_trace.stage_order,
      ) as WorkflowWriteProjectionLearningControlDecisionTrace["stage_order"];
  }

  return {
    promote_memory: promotePreview,
    runtime_apply: {
      promotion_state_override: applyGate.controlledOverrideState === "stable" ? "stable" : null,
      changed_promotion_state: applyGate.controlledOverrideState === "stable",
    },
  };
}
