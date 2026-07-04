import type {
  LearningControlHttpModelClientConfig,
  LearningControlHttpModelClientTransport,
  LearningControlModelClient,
} from "./learning-control-model-client.js";
import {
  buildFormPatternAnthropicHttpPromptContract,
  buildFormPatternHttpPromptContract,
  buildPromoteMemoryAnthropicHttpPromptContract,
  buildPromoteMemoryHttpPromptContract,
  LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION,
  LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION,
} from "./learning-control-model-client-http-contract.js";
import {
  MemoryFormPatternSemanticReviewResultSchema,
  MemoryPromoteSemanticReviewResultSchema,
} from "./schemas.js";
import {
  extractAnthropicMessageText,
  extractChatCompletionText,
  extractJsonValueFromText,
} from "./http-model-json.js";

function inferLearningControlHttpTransport(
  config: LearningControlHttpModelClientConfig,
): LearningControlHttpModelClientTransport {
  if (config.transport) return config.transport;
  const baseUrl = config.baseUrl.trim().toLowerCase();
  if (baseUrl.includes("/anthropic")) {
    return LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION;
  }
  return LEARNING_CONTROL_HTTP_OPENAI_TRANSPORT_CONTRACT_VERSION;
}

async function postLearningControlReviewJson(args: {
  config: LearningControlHttpModelClientConfig;
  systemPrompt: string;
  userPayload: Record<string, unknown>;
}): Promise<unknown> {
  const baseUrl = args.config.baseUrl.trim().replace(/\/+$/, "");
  const apiKey = args.config.apiKey.trim();
  const model = args.config.model.trim();
  if (!baseUrl || !apiKey || !model) return null;
  const transport = inferLearningControlHttpTransport(args.config);
  const maxTokens =
    transport === LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION
      ? Math.max(args.config.maxTokens, 1200)
      : args.config.maxTokens;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), args.config.timeoutMs);
  try {
    const response =
      transport === LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION
        ? await fetch(`${baseUrl}/v1/messages`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-api-key": apiKey,
              "anthropic-version": "2023-06-01",
            },
            body: JSON.stringify({
              model,
              max_tokens: maxTokens,
              system: args.systemPrompt,
              messages: [
                {
                  role: "user",
                  content: [
                    {
                      type: "text",
                      text: JSON.stringify(args.userPayload, null, 2),
                    },
                  ],
                },
              ],
            }),
            signal: controller.signal,
          })
        : await fetch(`${baseUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${apiKey}`,
            },
            body: JSON.stringify({
              model,
              temperature: args.config.temperature,
              max_tokens: maxTokens,
              ...(args.config.openAiExtraBody ?? {}),
              messages: [
                { role: "system", content: args.systemPrompt },
                { role: "user", content: JSON.stringify(args.userPayload, null, 2) },
              ],
            }),
            signal: controller.signal,
          });
    if (!response.ok) return null;
    const payload = await response.json().catch(() => null);
    const content =
      transport === LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION
        ? extractAnthropicMessageText(payload)
        : extractChatCompletionText(payload);
    if (!content) return null;
    return extractJsonValueFromText(content);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export function createHttpPromoteMemoryLearningControlModelClient(
  config: LearningControlHttpModelClientConfig,
): LearningControlModelClient {
  return {
    reviewPromoteMemory: async ({ reviewPacket, suppliedReviewResult }) => {
      if (suppliedReviewResult) return suppliedReviewResult;
      const contract =
        inferLearningControlHttpTransport(config) === LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION
          ? buildPromoteMemoryAnthropicHttpPromptContract(reviewPacket)
          : buildPromoteMemoryHttpPromptContract(reviewPacket);
      const parsed = await postLearningControlReviewJson({
        config,
        systemPrompt: contract.system_prompt,
        userPayload: contract.user_payload,
      });
      if (parsed == null) return null;
      const result = MemoryPromoteSemanticReviewResultSchema.safeParse(parsed);
      return result.success ? result.data : null;
    },
  };
}

export function createHttpFormPatternLearningControlModelClient(
  config: LearningControlHttpModelClientConfig,
): LearningControlModelClient {
  return {
    reviewFormPattern: async ({ reviewPacket, suppliedReviewResult }) => {
      if (suppliedReviewResult) return suppliedReviewResult;
      const contract =
        inferLearningControlHttpTransport(config) === LEARNING_CONTROL_HTTP_ANTHROPIC_TRANSPORT_CONTRACT_VERSION
          ? buildFormPatternAnthropicHttpPromptContract(reviewPacket)
          : buildFormPatternHttpPromptContract(reviewPacket);
      const parsed = await postLearningControlReviewJson({
        config,
        systemPrompt: contract.system_prompt,
        userPayload: contract.user_payload,
      });
      if (parsed == null) return null;
      const result = MemoryFormPatternSemanticReviewResultSchema.safeParse(parsed);
      return result.success ? result.data : null;
    },
  };
}
