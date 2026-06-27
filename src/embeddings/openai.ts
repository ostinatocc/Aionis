import type { EmbeddingProvider } from "./types.js";
import { createEmbedJsonPoster, type EmbedHttpConfig } from "./http.js";

type OpenAIEmbeddingProviderOptions = {
  apiKey: string;
  model: string;
  dim: number;
  batchSize: number;
  baseUrl: string;
  dimensions?: number;
  encodingFormat?: "float";
  providerLabel?: string;
  http: EmbedHttpConfig;
};

export function createOpenAIEmbeddingProvider(opts: OpenAIEmbeddingProviderOptions): EmbeddingProvider {
  const { apiKey, model, dim, batchSize, baseUrl, dimensions, encodingFormat, providerLabel, http } = opts;
  const poster = createEmbedJsonPoster(http);
  const endpoint = `${baseUrl.trim().replace(/\/+$/, "")}/embeddings`;
  return {
    name: `${providerLabel ?? "openai"}:${model}`,
    dim,
    async embed(texts: string[]): Promise<number[][]> {
      const out: number[][] = [];
      for (let i = 0; i < texts.length; i += batchSize) {
        const chunk = texts.slice(i, i + batchSize);
        const body: Record<string, unknown> = { model, input: chunk };
        if (dimensions !== undefined) body.dimensions = dimensions;
        if (encodingFormat !== undefined) body.encoding_format = encodingFormat;
        const json = await poster.postJson<any>(
          endpoint,
          { authorization: `Bearer ${apiKey}` },
          body,
        );
        const data = Array.isArray(json?.data) ? json.data : [];
        // Expect the API to preserve order by index; we sort defensively.
        data.sort((a: any, b: any) => (a.index ?? 0) - (b.index ?? 0));
        for (const item of data) {
          const emb = item?.embedding;
          if (!Array.isArray(emb) || emb.length !== dim) {
            throw new Error(`unexpected embedding dim from OpenAI: got ${Array.isArray(emb) ? emb.length : "non-array"}`);
          }
          out.push(emb as number[]);
        }
      }
      if (out.length !== texts.length) {
        throw new Error(`OpenAI embeddings returned ${out.length} vectors for ${texts.length} inputs`);
      }
      return out;
    },
  };
}
