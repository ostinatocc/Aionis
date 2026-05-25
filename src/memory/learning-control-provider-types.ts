import type {
  MemoryFormPatternSemanticReviewPacket,
  MemoryFormPatternSemanticReviewResult,
  MemoryPromoteSemanticReviewPacket,
  MemoryPromoteSemanticReviewResult,
} from "./schemas.js";
import type { LearningControlReviewProvider } from "./learning-control-model-provider.js";

export type PromoteMemoryLearningControlReviewProvider =
  LearningControlReviewProvider<MemoryPromoteSemanticReviewPacket, MemoryPromoteSemanticReviewResult>;

export type FormPatternLearningControlReviewProvider =
  LearningControlReviewProvider<MemoryFormPatternSemanticReviewPacket, MemoryFormPatternSemanticReviewResult>;
