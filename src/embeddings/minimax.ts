import type { EmbeddingProvider } from "./types.js";
import { createEmbedJsonPoster, type EmbedHttpConfig } from "./http.js";

type MinimaxEmbeddingProviderOptions = {
  apiKey: string;
  groupId?: string;
  model: string;
  endpointUrl: string;
  embedType: "db" | "query";
  dim: number;
  http: EmbedHttpConfig;
};

type MinimaxEmbeddingResponse = {
  vectors?: number[][];
  base_resp?: {
    status_code?: number;
    status_msg?: string;
  };
};

export class MinimaxEmbeddingApiError extends Error {
  readonly statusCode: number;
  readonly statusMessage: string | null;
  readonly baseResp: Record<string, unknown>;

  constructor(baseResp: Record<string, unknown>) {
    const statusCode = Number(baseResp.status_code);
    const statusMessage = typeof baseResp.status_msg === "string" ? baseResp.status_msg : null;
    super(`MiniMax embeddings API returned status_code=${Number.isFinite(statusCode) ? statusCode : "unknown"}${statusMessage ? ` status_msg=${statusMessage}` : ""}`);
    this.name = "MinimaxEmbeddingApiError";
    this.statusCode = Number.isFinite(statusCode) ? statusCode : -1;
    this.statusMessage = statusMessage;
    this.baseResp = baseResp;
  }
}

export function createMinimaxEmbeddingProvider(opts: MinimaxEmbeddingProviderOptions): EmbeddingProvider {
  const { apiKey, groupId, model, endpointUrl, embedType, dim, http } = opts;
  const poster = createEmbedJsonPoster(http);

  return {
    name: `minimax:${model}:${embedType}`,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      if (texts.length === 0) return [];

      const url = new URL(endpointUrl);
      if (groupId?.trim()) {
        url.searchParams.set("GroupId", groupId.trim());
      }

      const json = await poster.postJson<MinimaxEmbeddingResponse>(
        url.toString(),
        {
          authorization: `Bearer ${apiKey}`,
        },
        { model, type: embedType, texts },
      );
      const status = json.base_resp?.status_code ?? -1;
      if (status !== 0) {
        throw new MinimaxEmbeddingApiError(json.base_resp ?? {});
      }

      const vectors = json.vectors;
      if (!Array.isArray(vectors) || vectors.length !== texts.length) {
        throw new Error(
          `MiniMax embeddings returned ${Array.isArray(vectors) ? vectors.length : "non-array"} vectors for ${texts.length} texts`,
        );
      }

      for (const v of vectors) {
        if (!Array.isArray(v) || v.length !== dim) {
          throw new Error(`MiniMax embedding dim mismatch: expected ${dim}, got ${Array.isArray(v) ? v.length : "non-array"}`);
        }
      }

      return vectors;
    },
  };
}
