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

function asObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function extractJsonValueFromText(raw: string): unknown {
  const text = raw.trim();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    // continue
  }
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text);
  if (fenced?.[1]) {
    try {
      return JSON.parse(fenced[1].trim());
    } catch {
      // continue
    }
  }
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first >= 0 && last > first) {
    try {
      return JSON.parse(text.slice(first, last + 1));
    } catch {
      return null;
    }
  }
  if (/^null$/i.test(text)) return null;
  return null;
}

function extractChatCompletionText(payload: unknown): string | null {
  const root = asObject(payload);
  if (!root) return null;
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first = asObject(choices[0]);
  if (!first) return null;
  const msg = asObject(first.message);
  if (!msg) return null;
  const content = msg.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const fragments = content
      .map((item) => {
        const obj = asObject(item);
        if (!obj) return "";
        const text = obj.text;
        return typeof text === "string" ? text : "";
      })
      .filter((v) => v.length > 0);
    if (fragments.length > 0) return fragments.join("\n");
  }
  return null;
}

function extractAnthropicMessageText(payload: unknown): string | null {
  const root = asObject(payload);
  if (!root) return null;
  const content = Array.isArray(root.content) ? root.content : [];
  const fragments = content
    .map((item) => {
      const obj = asObject(item);
      if (!obj) return "";
      const text = obj.text;
      return typeof text === "string" ? text : "";
    })
    .filter((v) => v.length > 0);
  if (fragments.length > 0) return fragments.join("\n");
  return null;
}

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
