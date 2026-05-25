import type {
  MemoryAdmissibilityResult,
  MemoryFormPatternInput,
  MemoryFormPatternSemanticReviewPacket,
  MemoryFormPatternSemanticReviewResult,
} from "./schemas.js";
import type { LearningControlReviewProvider } from "./learning-control-model-provider.js";
import {
  buildFormPatternSemanticReviewPacket,
  evaluateFormPatternSemanticReview,
  type FormPatternSourceExample,
} from "./learning-control-form-pattern.js";
import { runLearningControlSemanticPreview } from "./learning-control-operation-runner.js";

export async function runFormPatternLearningControlPreview<
  TPolicyEffect extends { applies: boolean; reason_code?: string | null },
  TDecisionTrace,
>(args: {
  input: MemoryFormPatternInput;
  sourceExamples: FormPatternSourceExample[];
  reviewResult?: MemoryFormPatternSemanticReviewResult | null;
  reviewProvider?: LearningControlReviewProvider<MemoryFormPatternSemanticReviewPacket, MemoryFormPatternSemanticReviewResult>;
  derivePolicyEffect: (args: {
    review: MemoryFormPatternSemanticReviewResult | null;
    admissibility: MemoryAdmissibilityResult | null;
  }) => TPolicyEffect;
  buildDecisionTrace: (args: {
    reviewPacket: MemoryFormPatternSemanticReviewPacket;
    reviewResult: MemoryFormPatternSemanticReviewResult | null;
    admissibility: MemoryAdmissibilityResult | null;
    policyEffect: TPolicyEffect;
  }) => TDecisionTrace;
}): Promise<{
  review_packet: MemoryFormPatternSemanticReviewPacket;
  review_result: MemoryFormPatternSemanticReviewResult | null;
  admissibility: MemoryAdmissibilityResult | null;
  policy_effect: TPolicyEffect;
  decision_trace: TDecisionTrace;
}> {
  return await runLearningControlSemanticPreview({
    buildPacket: () =>
      buildFormPatternSemanticReviewPacket({
        input: args.input,
        sourceExamples: args.sourceExamples,
      }),
    reviewResult: args.reviewResult ?? null,
    resolveReviewResult: args.reviewProvider?.resolveReviewResult,
    evaluateAdmissibility: ({ packet, review }) =>
      evaluateFormPatternSemanticReview({
        packet,
        review,
      }),
    derivePolicyEffect: args.derivePolicyEffect,
    buildDecisionTrace: args.buildDecisionTrace,
  });
}
