export const EMBEDDING_SOURCE_TEXT_CHANGED_PENDING_REASON = "embedding_source_text_changed";

export type NodeEmbeddingAuthorityFields = Readonly<{
  embedding_vector_json: unknown;
  embedding_model: string | null;
  embedding_status: "pending" | "ready" | "failed";
  embedding_last_error: string | null;
}>;

/**
 * Embeddings are projections of authority text, not independent authority.
 * A text-summary change must therefore make the old vector unservable in the
 * same transaction that records the authority mutation.
 */
export function nodeEmbeddingAuthorityFieldsAfterTextUpdate(args: {
  beforeTextSummary: string | null;
  afterTextSummary: string | null;
  current: NodeEmbeddingAuthorityFields;
}): NodeEmbeddingAuthorityFields {
  if (args.beforeTextSummary === args.afterTextSummary) return args.current;
  return {
    embedding_vector_json: null,
    embedding_model: null,
    embedding_status: "pending",
    embedding_last_error: EMBEDDING_SOURCE_TEXT_CHANGED_PENDING_REASON,
  };
}

export function authorityNodeEmbeddingText(args: {
  textSummary: string | null;
  title: string | null;
}): string {
  return args.textSummary?.trim() || args.title?.trim() || "";
}
