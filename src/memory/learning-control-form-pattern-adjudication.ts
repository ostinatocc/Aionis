import type {
  MemoryFormPatternSemanticReviewPacket,
  MemoryFormPatternSemanticReviewResult,
} from "./schemas.js";

export function resolveBuiltinFormPatternLearningControlReview(args: {
  reviewPacket: MemoryFormPatternSemanticReviewPacket;
  suppliedReviewResult: MemoryFormPatternSemanticReviewResult | null;
  confidence?: number;
  reason?: string;
}): MemoryFormPatternSemanticReviewResult | null {
  if (args.suppliedReviewResult) {
    return args.suppliedReviewResult;
  }
  if (!args.reviewPacket.deterministic_gate.gate_satisfied) {
    return null;
  }

  return {
    review_version: "form_pattern_semantic_review_v1",
    adjudication: {
      operation: "form_pattern",
      disposition: "recommend",
      target_kind: "pattern",
      target_level: "L3",
      reason: args.reason ?? "builtin adjudicator found grouped signature evidence",
      confidence: args.confidence ?? 0.85,
    },
  };
}
