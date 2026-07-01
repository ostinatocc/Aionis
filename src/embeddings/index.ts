import { z } from "zod";
import { createMinimaxEmbeddingProvider } from "./minimax.js";
import { createOpenAIEmbeddingProvider } from "./openai.js";
import type { EmbeddingProvider } from "./types.js";
import type { EmbedHttpConfig } from "./http.js";

const ProviderEnvSchema = z.object({
  EMBEDDING_PROVIDER: z.enum(["none", "openai", "minimax", "dashscope"]).default("none"),
  OPENAI_API_KEY: z.string().optional(),
  OPENAI_EMBED_BASE_URL: z.string().default("https://api.openai.com/v1"),
  OPENAI_EMBEDDING_MODEL: z.string().default("text-embedding-3-small"),
  OPENAI_EMBED_DIMENSIONS: z.coerce.number().int().positive().optional(),
  OPENAI_EMBED_BATCH_SIZE: z.coerce.number().int().positive().max(256).default(32),
  EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),

  DASHSCOPE_API_KEY: z.string().optional(),
  DASHSCOPE_EMBED_BASE_URL: z.string().default("https://dashscope.aliyuncs.com/compatible-mode/v1"),
  DASHSCOPE_EMBEDDING_MODEL: z.string().default("text-embedding-v4"),
  DASHSCOPE_EMBED_BATCH_SIZE: z.coerce.number().int().positive().max(10).default(10),

  MINIMAX_API_KEY: z.string().optional(),
  MINIMAX_GROUP_ID: z.string().optional(),
  MINIMAX_EMBED_MODEL: z.string().default("embo-01"),
  MINIMAX_EMBED_TYPE: z.enum(["db", "query"]).optional(),
  MINIMAX_EMBED_DB_TYPE: z.enum(["db", "query"]).optional(),
  MINIMAX_EMBED_QUERY_TYPE: z.enum(["db", "query"]).optional(),
  MINIMAX_EMBED_ENDPOINT: z.string().default("https://api.minimax.chat/v1/embeddings"),

  // Embedding HTTP hardening
  EMBED_HTTP_TIMEOUT_MS: z.coerce.number().int().positive().default(10_000),
  EMBED_HTTP_MAX_RETRIES: z.coerce.number().int().min(0).max(10).default(2),
  EMBED_HTTP_BASE_DELAY_MS: z.coerce.number().int().positive().default(250),
  EMBED_HTTP_MAX_DELAY_MS: z.coerce.number().int().positive().default(5_000),
  EMBED_HTTP_MAX_CONCURRENCY: z.coerce.number().int().positive().max(128).default(8),
});

export type EmbeddingProviderBundle = {
  write: EmbeddingProvider | null;
  query: EmbeddingProvider | null;
};

export function createEmbeddingProvidersFromEnv(env: Record<string, string | undefined>): EmbeddingProviderBundle {
  const parsed = ProviderEnvSchema.parse(env);

  if (parsed.EMBEDDING_DIM !== 1536) {
    throw new Error(`EMBEDDING_DIM must be 1536; got ${parsed.EMBEDDING_DIM}`);
  }

  if (parsed.EMBEDDING_PROVIDER === "none") return { write: null, query: null };

  const httpCfg: EmbedHttpConfig = {
    timeoutMs: parsed.EMBED_HTTP_TIMEOUT_MS,
    maxRetries: parsed.EMBED_HTTP_MAX_RETRIES,
    baseDelayMs: parsed.EMBED_HTTP_BASE_DELAY_MS,
    maxDelayMs: parsed.EMBED_HTTP_MAX_DELAY_MS,
    maxConcurrency: parsed.EMBED_HTTP_MAX_CONCURRENCY,
  };

  if (parsed.EMBEDDING_PROVIDER === "minimax") {
    if (!parsed.MINIMAX_API_KEY) throw new Error("EMBEDDING_PROVIDER=minimax requires MINIMAX_API_KEY");
    const writeType = parsed.MINIMAX_EMBED_DB_TYPE ?? parsed.MINIMAX_EMBED_TYPE ?? "db";
    const queryType = parsed.MINIMAX_EMBED_QUERY_TYPE ?? parsed.MINIMAX_EMBED_TYPE ?? "query";
    return {
      write: createMinimaxEmbeddingProvider({
        apiKey: parsed.MINIMAX_API_KEY,
        groupId: parsed.MINIMAX_GROUP_ID,
        model: parsed.MINIMAX_EMBED_MODEL,
        endpointUrl: parsed.MINIMAX_EMBED_ENDPOINT,
        embedType: writeType,
        dim: parsed.EMBEDDING_DIM,
        http: httpCfg,
      }),
      query: createMinimaxEmbeddingProvider({
        apiKey: parsed.MINIMAX_API_KEY,
        groupId: parsed.MINIMAX_GROUP_ID,
        model: parsed.MINIMAX_EMBED_MODEL,
        endpointUrl: parsed.MINIMAX_EMBED_ENDPOINT,
        embedType: queryType,
        dim: parsed.EMBEDDING_DIM,
        http: httpCfg,
      }),
    };
  }

  if (parsed.EMBEDDING_PROVIDER === "dashscope") {
    if (!parsed.DASHSCOPE_API_KEY) throw new Error("EMBEDDING_PROVIDER=dashscope requires DASHSCOPE_API_KEY");
    const provider = createOpenAIEmbeddingProvider({
      apiKey: parsed.DASHSCOPE_API_KEY,
      baseUrl: parsed.DASHSCOPE_EMBED_BASE_URL,
      model: parsed.DASHSCOPE_EMBEDDING_MODEL,
      dim: parsed.EMBEDDING_DIM,
      dimensions: parsed.EMBEDDING_DIM,
      encodingFormat: "float",
      batchSize: parsed.DASHSCOPE_EMBED_BATCH_SIZE,
      providerLabel: "dashscope",
      http: httpCfg,
    });
    return { write: provider, query: provider };
  }

  if (!parsed.OPENAI_API_KEY) {
    throw new Error("EMBEDDING_PROVIDER=openai requires OPENAI_API_KEY");
  }
  const provider = createOpenAIEmbeddingProvider({
    apiKey: parsed.OPENAI_API_KEY,
    baseUrl: parsed.OPENAI_EMBED_BASE_URL,
    model: parsed.OPENAI_EMBEDDING_MODEL,
    dim: parsed.EMBEDDING_DIM,
    dimensions: openAiEmbeddingDimensions(parsed.OPENAI_EMBEDDING_MODEL, parsed.OPENAI_EMBED_DIMENSIONS, parsed.EMBEDDING_DIM),
    batchSize: parsed.OPENAI_EMBED_BATCH_SIZE,
    http: httpCfg,
  });
  return { write: provider, query: provider };
}

function openAiEmbeddingDimensions(model: string, configured: number | undefined, dim: number): number | undefined {
  if (configured !== undefined) return configured;
  const normalized = model.trim().toLowerCase();
  if (normalized === "text-embedding-3-small" || normalized === "text-embedding-3-large") return dim;
  if (normalized.endsWith("/text-embedding-3-small") || normalized.endsWith("/text-embedding-3-large")) return dim;
  return undefined;
}

export function createEmbeddingProviderFromEnv(env: Record<string, string | undefined>): EmbeddingProvider | null {
  return createEmbeddingProvidersFromEnv(env).write;
}
