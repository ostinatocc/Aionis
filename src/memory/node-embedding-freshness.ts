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

export type NodeAuthorityStateV2 = {
  id: string;
  scope: string;
  client_id: string | null;
  type: string;
  tier: string;
  title: string | null;
  text_summary: string | null;
  slots_json: unknown;
  raw_ref: string | null;
  evidence_ref: string | null;
  embedding_vector_json: unknown;
  embedding_model: string | null;
  memory_lane: "private" | "shared";
  producer_agent_id: string | null;
  owner_agent_id: string | null;
  owner_team_id: string | null;
  embedding_status: "pending" | "ready" | "failed";
  embedding_last_error: string | null;
  salience: number;
  importance: number;
  confidence: number;
  redaction_version: number;
  commit_id: string;
  created_at: string;
};

export type NodeAuthorityPatchV2 = {
  id: string;
  tier?: string;
  slots: Record<string, unknown>;
  textSummary: string | null;
  salience: number;
  importance: number;
  confidence: number;
};

/** Pure full-row projection shared by authority writers and integrity replayers. */
export function nodeAuthorityStateAfterPatchV2(args: {
  before: NodeAuthorityStateV2;
  patch: NodeAuthorityPatchV2;
}): NodeAuthorityStateV2 {
  return {
    ...args.before,
    ...(args.patch.tier ? { tier: args.patch.tier } : {}),
    slots_json: args.patch.slots,
    text_summary: args.patch.textSummary,
    ...nodeEmbeddingAuthorityFieldsAfterTextUpdate({
      beforeTextSummary: args.before.text_summary,
      afterTextSummary: args.patch.textSummary,
      current: {
        embedding_vector_json: args.before.embedding_vector_json,
        embedding_model: args.before.embedding_model,
        embedding_status: args.before.embedding_status,
        embedding_last_error: args.before.embedding_last_error,
      },
    }),
    salience: args.patch.salience,
    importance: args.patch.importance,
    confidence: args.patch.confidence,
    commit_id: "$self",
  };
}
