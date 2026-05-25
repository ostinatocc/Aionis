import type { LearningControlModelClient } from "./learning-control-model-client.js";
import { resolveBuiltinFormPatternLearningControlReview } from "./learning-control-form-pattern-adjudication.js";
import { resolveBuiltinPromoteMemoryLearningControlReview } from "./learning-control-promote-memory-adjudication.js";

export function createBuiltinPromoteMemoryLearningControlModelClient(args?: {
  confidence?: number;
  reason?: string;
}): LearningControlModelClient {
  return {
    reviewPromoteMemory: ({ reviewPacket, suppliedReviewResult }) => {
      return resolveBuiltinPromoteMemoryLearningControlReview({
        reviewPacket,
        suppliedReviewResult,
        confidence: args?.confidence,
        reason: args?.reason,
      });
    },
  };
}

export function createBuiltinFormPatternLearningControlModelClient(args?: {
  confidence?: number;
  reason?: string;
}): LearningControlModelClient {
  return {
    reviewFormPattern: ({ reviewPacket, suppliedReviewResult }) => {
      return resolveBuiltinFormPatternLearningControlReview({
        reviewPacket,
        suppliedReviewResult,
        confidence: args?.confidence,
        reason: args?.reason,
      });
    },
  };
}
