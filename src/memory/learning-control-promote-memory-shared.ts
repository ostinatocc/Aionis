import type {
  MemoryAdmissibilityResult,
  MemoryPromoteInput,
  MemoryPromoteSemanticReviewPacket,
  MemoryPromoteSemanticReviewResult,
} from "./schemas.js";
import type { LearningControlReviewProvider } from "./learning-control-model-provider.js";
import {
  buildPromoteMemorySemanticReviewPacket,
  type PromoteMemoryLearningControlCandidateExample,
  evaluatePromoteMemorySemanticReview,
} from "./learning-control-promote-memory.js";
import { runLearningControlSemanticPreview } from "./learning-control-operation-runner.js";

export async function runPromoteMemoryLearningControlPreview<
  TPolicyEffect extends { applies: boolean; reason_code?: string | null },
  TDecisionTrace,
>(args: {
  input: MemoryPromoteInput;
  candidateExamples: PromoteMemoryLearningControlCandidateExample[];
  reviewResult?: MemoryPromoteSemanticReviewResult | null;
  reviewProvider?: LearningControlReviewProvider<MemoryPromoteSemanticReviewPacket, MemoryPromoteSemanticReviewResult>;
  derivePolicyEffect: (args: {
    review: MemoryPromoteSemanticReviewResult | null;
    admissibility: MemoryAdmissibilityResult | null;
  }) => TPolicyEffect;
  buildDecisionTrace: (args: {
    reviewPacket: MemoryPromoteSemanticReviewPacket;
    reviewResult: MemoryPromoteSemanticReviewResult | null;
    admissibility: MemoryAdmissibilityResult | null;
    policyEffect: TPolicyEffect;
  }) => TDecisionTrace;
}): Promise<{
  review_packet: MemoryPromoteSemanticReviewPacket;
  review_result: MemoryPromoteSemanticReviewResult | null;
  admissibility: MemoryAdmissibilityResult | null;
  policy_effect: TPolicyEffect;
  decision_trace: TDecisionTrace;
}> {
  return await runLearningControlSemanticPreview({
    buildPacket: () =>
      buildPromoteMemorySemanticReviewPacket({
        input: args.input,
        candidateExamples: args.candidateExamples,
      }),
    reviewResult: args.reviewResult ?? null,
    resolveReviewResult: args.reviewProvider?.resolveReviewResult,
    evaluateAdmissibility: ({ packet, review }) =>
      evaluatePromoteMemorySemanticReview({
        packet,
        review,
      }),
    derivePolicyEffect: args.derivePolicyEffect,
    buildDecisionTrace: args.buildDecisionTrace,
  });
}
