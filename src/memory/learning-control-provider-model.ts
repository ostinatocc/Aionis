import type { LearningControlModelClient } from "./learning-control-model-client.js";
import type {
  FormPatternLearningControlReviewProvider,
  PromoteMemoryLearningControlReviewProvider,
} from "./learning-control-provider-types.js";

export function createModelBackedPromoteMemoryLearningControlReviewProvider(args: {
  modelClient: LearningControlModelClient;
}): PromoteMemoryLearningControlReviewProvider | undefined {
  const resolver = args.modelClient.reviewPromoteMemory;
  if (!resolver) {
    return undefined;
  }
  return {
    resolveReviewResult: ({ reviewPacket, suppliedReviewResult }) =>
      suppliedReviewResult
      ?? resolver({
        reviewPacket,
        suppliedReviewResult,
      })
      ?? null,
  };
}

export function createModelBackedFormPatternLearningControlReviewProvider(args: {
  modelClient: LearningControlModelClient;
}): FormPatternLearningControlReviewProvider | undefined {
  const resolver = args.modelClient.reviewFormPattern;
  if (!resolver) {
    return undefined;
  }
  return {
    resolveReviewResult: ({ reviewPacket, suppliedReviewResult }) =>
      suppliedReviewResult
      ?? resolver({
        reviewPacket,
        suppliedReviewResult,
      })
      ?? null,
  };
}
