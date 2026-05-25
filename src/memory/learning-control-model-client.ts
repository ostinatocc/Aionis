import type { LearningControlReviewResolver } from "./learning-control-model-provider.js";
import type {
  MemoryFormPatternSemanticReviewPacket,
  MemoryFormPatternSemanticReviewResult,
  MemoryPromoteSemanticReviewPacket,
  MemoryPromoteSemanticReviewResult,
} from "./schemas.js";

export type LearningControlModelClientOperation = "promote_memory" | "form_pattern";
export type LearningControlModelClientMode = "off" | "builtin" | "http" | "custom";
export type LearningControlHttpModelClientTransport =
  | "openai_chat_completions_v1"
  | "anthropic_messages_v1";

export type LearningControlHttpModelClientConfig = {
  baseUrl: string;
  apiKey: string;
  model: string;
  timeoutMs: number;
  maxTokens: number;
  temperature: number;
  transport?: LearningControlHttpModelClientTransport;
  openAiExtraBody?: Record<string, unknown>;
};

export type LearningControlModelClient = {
  reviewPromoteMemory?: LearningControlReviewResolver<
    MemoryPromoteSemanticReviewPacket,
    MemoryPromoteSemanticReviewResult
  >;
  reviewFormPattern?: LearningControlReviewResolver<
    MemoryFormPatternSemanticReviewPacket,
    MemoryFormPatternSemanticReviewResult
  >;
};

export type LearningControlModelClientFactoryRequest = {
  operation: LearningControlModelClientOperation;
  mode: LearningControlModelClientMode;
  confidence?: number;
  reason?: string;
};

export type LearningControlModelClientFactory = (
  args: LearningControlModelClientFactoryRequest,
) => LearningControlModelClient | undefined;
