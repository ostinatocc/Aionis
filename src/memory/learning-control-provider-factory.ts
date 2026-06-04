import { buildLiteLearningControlModelClient } from "./learning-control-model-client-factory.js";
import type {
  LearningControlHttpModelClientConfig,
  LearningControlModelClientFactory,
  LearningControlModelClientMode,
} from "./learning-control-model-client.js";
import {
  createModelBackedFormPatternLearningControlReviewProvider,
  createModelBackedPromoteMemoryLearningControlReviewProvider,
} from "./learning-control-provider-model.js";
import {
  createEvidenceFormPatternLearningControlReviewProvider,
  createEvidencePromoteMemoryLearningControlReviewProvider,
} from "./learning-control-provider-evidence.js";
import type {
  FormPatternLearningControlReviewProvider,
  PromoteMemoryLearningControlReviewProvider,
} from "./learning-control-provider-types.js";

export function buildPromoteMemoryLearningControlReviewProvider(args: {
  modelClientMode?: LearningControlModelClientMode;
  evidenceEnabled?: boolean;
  modelClientFactory?: LearningControlModelClientFactory;
  httpClientConfig?: LearningControlHttpModelClientConfig;
  builtin?: {
    confidence?: number;
    reason?: string;
  };
  evidence?: {
    confidence?: number;
    reason?: string;
  };
}): PromoteMemoryLearningControlReviewProvider | undefined {
  return (
    (args.modelClientMode && args.modelClientMode !== "off"
      ? createModelBackedPromoteMemoryLearningControlReviewProvider({
          modelClient: buildLiteLearningControlModelClient({
            promoteMemory: {
              mode: args.modelClientMode,
              confidence: args.builtin?.confidence,
              reason: args.builtin?.reason,
            },
          }, {
            modelClientFactory: args.modelClientFactory,
            httpClientConfig: args.httpClientConfig,
          }),
        })
      : undefined)
    ?? (args.evidenceEnabled
      ? createEvidencePromoteMemoryLearningControlReviewProvider({
          confidence: args.evidence?.confidence,
          reason: args.evidence?.reason,
        })
      : undefined)
  );
}

export function buildFormPatternLearningControlReviewProvider(args: {
  modelClientMode?: LearningControlModelClientMode;
  evidenceEnabled?: boolean;
  modelClientFactory?: LearningControlModelClientFactory;
  httpClientConfig?: LearningControlHttpModelClientConfig;
  builtin?: {
    confidence?: number;
    reason?: string;
  };
  evidence?: {
    confidence?: number;
    reason?: string;
  };
}): FormPatternLearningControlReviewProvider | undefined {
  return (
    (args.modelClientMode && args.modelClientMode !== "off"
      ? createModelBackedFormPatternLearningControlReviewProvider({
          modelClient: buildLiteLearningControlModelClient({
            formPattern: {
              mode: args.modelClientMode,
              confidence: args.builtin?.confidence,
              reason: args.builtin?.reason,
            },
          }, {
            modelClientFactory: args.modelClientFactory,
            httpClientConfig: args.httpClientConfig,
          }),
        })
      : undefined)
    ?? (args.evidenceEnabled
      ? createEvidenceFormPatternLearningControlReviewProvider({
          confidence: args.evidence?.confidence,
          reason: args.evidence?.reason,
        })
      : undefined)
  );
}
