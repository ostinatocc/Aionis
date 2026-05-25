import type {
  LearningControlHttpModelClientConfig,
  LearningControlModelClient,
  LearningControlModelClientFactory,
  LearningControlModelClientMode,
} from "./learning-control-model-client.js";
import {
  createBuiltinFormPatternLearningControlModelClient,
  createBuiltinPromoteMemoryLearningControlModelClient,
} from "./learning-control-model-client-builtin.js";
import {
  createHttpFormPatternLearningControlModelClient,
  createHttpPromoteMemoryLearningControlModelClient,
} from "./learning-control-model-client-http.js";

export type LiteLearningControlModelClientSelection = {
  mode?: LearningControlModelClientMode;
  confidence?: number;
  reason?: string;
};

export function buildLiteLearningControlModelClient(args: {
  promoteMemory?: LiteLearningControlModelClientSelection;
  formPattern?: LiteLearningControlModelClientSelection;
}, options?: {
  modelClientFactory?: LearningControlModelClientFactory;
  httpClientConfig?: LearningControlHttpModelClientConfig;
}): LearningControlModelClient {
  const client: LearningControlModelClient = {};

  if (args.promoteMemory?.mode === "custom") {
    const customClient = options?.modelClientFactory?.({
      operation: "promote_memory",
      mode: "custom",
      confidence: args.promoteMemory.confidence,
      reason: args.promoteMemory.reason,
    });
    client.reviewPromoteMemory = customClient?.reviewPromoteMemory;
  } else if (args.promoteMemory?.mode === "builtin") {
    const builtinClient = createBuiltinPromoteMemoryLearningControlModelClient({
      confidence: args.promoteMemory.confidence,
      reason: args.promoteMemory.reason,
    });
    client.reviewPromoteMemory = builtinClient.reviewPromoteMemory;
  } else if (args.promoteMemory?.mode === "http" && options?.httpClientConfig) {
    const httpClient = createHttpPromoteMemoryLearningControlModelClient(options.httpClientConfig);
    client.reviewPromoteMemory = httpClient.reviewPromoteMemory;
  }

  if (args.formPattern?.mode === "custom") {
    const customClient = options?.modelClientFactory?.({
      operation: "form_pattern",
      mode: "custom",
      confidence: args.formPattern.confidence,
      reason: args.formPattern.reason,
    });
    client.reviewFormPattern = customClient?.reviewFormPattern;
  } else if (args.formPattern?.mode === "builtin") {
    const builtinClient = createBuiltinFormPatternLearningControlModelClient({
      confidence: args.formPattern.confidence,
      reason: args.formPattern.reason,
    });
    client.reviewFormPattern = builtinClient.reviewFormPattern;
  } else if (args.formPattern?.mode === "http" && options?.httpClientConfig) {
    const httpClient = createHttpFormPatternLearningControlModelClient(options.httpClientConfig);
    client.reviewFormPattern = httpClient.reviewFormPattern;
  }

  return client;
}
