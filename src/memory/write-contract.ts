import type { WriteDistillationSummary } from "./write-distillation.js";

export type WriteResult = {
  tenant_id?: string;
  scope?: string;
  commit_id: string;
  commit_uri?: string;
  commit_hash: string;
  nodes: Array<{ id: string; uri?: string; client_id?: string; type: string }>;
  edges: Array<{ id: string; uri?: string; type: string; src_id: string; dst_id: string }>;
  recallable_node_count?: number;
  edge_count?: number;
  embedding_backfill?:
    | { completed_inline: true; attempted_nodes: number; updated_nodes: number }
    | { failed_inline: true; attempted_nodes: number; failed_nodes: number; error?: string };
  warnings?: Array<{ code: string; message: string; details?: Record<string, unknown> }>;
  distillation?: WriteDistillationSummary;
};

export type PreparedNode = {
  id: string;
  client_id?: string;
  scope: string;
  type: string;
  tier?: "hot" | "warm" | "cold" | "archive";
  memory_lane: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  title?: string;
  text_summary?: string;
  slots: Record<string, unknown>;
  raw_ref?: string;
  evidence_ref?: string;
  embedding?: number[];
  embedding_model?: string;
  embed_text?: string;
  salience?: number;
  importance?: number;
  confidence?: number;
};

export type PreparedEdge = {
  id: string;
  scope: string;
  type: string;
  src_id: string;
  dst_id: string;
  weight?: number;
  confidence?: number;
  decay_rate?: number;
  metadata?: Record<string, unknown>;
};

export type PreparedWrite = {
  tenant_id: string;
  scope_public: string;
  scope: string;
  actor: string;
  memory_lane_default: "private" | "shared";
  producer_agent_id?: string;
  owner_agent_id?: string;
  owner_team_id?: string;
  parent_commit_id: string | null;
  input_sha256: string;
  model_version: string | null;
  prompt_version: string | null;
  redaction_meta: Record<string, number>;
  auto_embed_effective: boolean;
  force_reembed: boolean;
  nodes: PreparedNode[];
  edges: PreparedEdge[];
  distillation?: WriteDistillationSummary;
};
