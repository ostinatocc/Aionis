import type { Env } from "../config.js";
import type {
  LearningControlHttpModelClientConfig,
  LearningControlHttpModelClientTransport,
  LearningControlModelClientFactory,
  LearningControlModelClientMode,
} from "../memory/learning-control-model-client.js";
import {
  buildFormPatternLearningControlReviewProvider,
  buildPromoteMemoryLearningControlReviewProvider,
} from "../memory/learning-control-provider-factory.js";
import type {
  FormPatternLearningControlReviewProvider,
  PromoteMemoryLearningControlReviewProvider,
} from "../memory/learning-control-provider-types.js";

export type LiteLearningControlRuntimeProviders = {
  replayRepairReview?: {
    promote_memory?: PromoteMemoryLearningControlReviewProvider;
  };
  workflowProjection?: {
    promote_memory?: PromoteMemoryLearningControlReviewProvider;
  };
  toolsFeedback?: {
    form_pattern?: FormPatternLearningControlReviewProvider;
  };
};

export type LiteLearningControlRuntimeProviderBuilderOptions = {
  modelClientFactory?: LearningControlModelClientFactory;
  httpClientConfig?: LearningControlHttpModelClientConfig;
  modelClientModes?: {
    replayRepairReview?: {
      promote_memory?: LearningControlModelClientMode;
    };
    workflowProjection?: {
      promote_memory?: LearningControlModelClientMode;
    };
    toolsFeedback?: {
      form_pattern?: LearningControlModelClientMode;
    };
  };
};

function buildLearningControlHttpClientConfig(
  env: Env,
  options?: LiteLearningControlRuntimeProviderBuilderOptions,
): LearningControlHttpModelClientConfig | undefined {
  if (options?.httpClientConfig) return options.httpClientConfig;
  const baseUrl = typeof env.LEARNING_CONTROL_MODEL_CLIENT_BASE_URL === "string"
    ? env.LEARNING_CONTROL_MODEL_CLIENT_BASE_URL.trim()
    : "";
  const apiKey = typeof env.LEARNING_CONTROL_MODEL_CLIENT_API_KEY === "string"
    ? env.LEARNING_CONTROL_MODEL_CLIENT_API_KEY.trim()
    : "";
  const model = typeof env.LEARNING_CONTROL_MODEL_CLIENT_MODEL === "string"
    ? env.LEARNING_CONTROL_MODEL_CLIENT_MODEL.trim()
    : "";
  if (
    !baseUrl
    || !apiKey
    || !model
  ) {
    return undefined;
  }
  const transport: LearningControlHttpModelClientTransport | undefined =
    env.LEARNING_CONTROL_MODEL_CLIENT_TRANSPORT === "auto"
      ? undefined
      : env.LEARNING_CONTROL_MODEL_CLIENT_TRANSPORT;
  let openAiExtraBody: Record<string, unknown> | undefined;
  const rawExtraBody = env.LEARNING_CONTROL_MODEL_CLIENT_OPENAI_EXTRA_BODY_JSON.trim();
  if (rawExtraBody) {
    const parsed: unknown = JSON.parse(rawExtraBody);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("LEARNING_CONTROL_MODEL_CLIENT_OPENAI_EXTRA_BODY_JSON must be a JSON object");
    }
    openAiExtraBody = parsed as Record<string, unknown>;
  }
  return {
    baseUrl,
    apiKey,
    model,
    transport,
    openAiExtraBody,
    timeoutMs: typeof env.LEARNING_CONTROL_MODEL_CLIENT_TIMEOUT_MS === "number"
      ? env.LEARNING_CONTROL_MODEL_CLIENT_TIMEOUT_MS
      : 7000,
    maxTokens: typeof env.LEARNING_CONTROL_MODEL_CLIENT_MAX_TOKENS === "number"
      ? env.LEARNING_CONTROL_MODEL_CLIENT_MAX_TOKENS
      : 300,
    temperature: typeof env.LEARNING_CONTROL_MODEL_CLIENT_TEMPERATURE === "number"
      ? env.LEARNING_CONTROL_MODEL_CLIENT_TEMPERATURE
      : 0.1,
  };
}

export function buildLiteLearningControlRuntimeProviders(
  env: Env,
  options?: LiteLearningControlRuntimeProviderBuilderOptions,
): LiteLearningControlRuntimeProviders {
  const httpClientConfig = buildLearningControlHttpClientConfig(env, options);
  const replayPromoteMemoryProvider = buildPromoteMemoryLearningControlReviewProvider({
    modelClientMode:
      options?.modelClientModes?.replayRepairReview?.promote_memory
      ?? (
        env.REPLAY_LEARNING_CONTROL_HTTP_MODEL_PROMOTE_MEMORY_PROVIDER_ENABLED
          ? "http"
          : "off"
      ),
    evidenceEnabled: env.REPLAY_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED,
    modelClientFactory: options?.modelClientFactory,
    httpClientConfig,
  });
  const workflowPromoteMemoryProvider = buildPromoteMemoryLearningControlReviewProvider({
    modelClientMode:
      options?.modelClientModes?.workflowProjection?.promote_memory
      ?? (
        env.WORKFLOW_LEARNING_CONTROL_HTTP_MODEL_PROMOTE_MEMORY_PROVIDER_ENABLED
          ? "http"
          : "off"
      ),
    evidenceEnabled: env.WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED,
    modelClientFactory: options?.modelClientFactory,
    httpClientConfig,
    builtin: {
      confidence: 0.85,
    },
    evidence: {
      confidence: 0.85,
    },
  });
  const toolsFormPatternProvider = buildFormPatternLearningControlReviewProvider({
    modelClientMode:
      options?.modelClientModes?.toolsFeedback?.form_pattern
      ?? (
        env.TOOLS_LEARNING_CONTROL_HTTP_MODEL_FORM_PATTERN_PROVIDER_ENABLED
          ? "http"
          : "off"
      ),
    evidenceEnabled: env.TOOLS_LEARNING_CONTROL_EVIDENCE_FORM_PATTERN_PROVIDER_ENABLED,
    modelClientFactory: options?.modelClientFactory,
    httpClientConfig,
  });

  return {
    ...(replayPromoteMemoryProvider
      ? {
          replayRepairReview: {
            promote_memory: replayPromoteMemoryProvider,
          },
        }
      : {}),
    ...(workflowPromoteMemoryProvider
      ? {
          workflowProjection: {
            promote_memory: workflowPromoteMemoryProvider,
          },
        }
      : {}),
    ...(toolsFormPatternProvider
      ? {
          toolsFeedback: {
            form_pattern: toolsFormPatternProvider,
          },
        }
      : {}),
  };
}
