import type { RecallEdgeRow, RecallNodeRow } from "../store/recall-access.js";
import type { MemoryRecallInput } from "./schemas.js";
import { pickSlotsPreview } from "./recall-debug-layer-helpers.js";
import { AIONIS_URI_NODE_TYPES, buildAionisUri } from "./uri.js";

const URI_NODE_TYPES = new Set<string>(AIONIS_URI_NODE_TYPES);

export type RecallTenancy = {
  tenant_id: string;
  scope: string;
};

export type RecallNodeDTO = {
  id: string;
  uri?: string;
  type: string;
  title: string | null;
  text_summary: string | null;
  topic_state?: string | null;
  member_count?: number | null;
  slots?: unknown;
  slots_preview?: Record<string, unknown> | null;
  raw_ref?: string | null;
  evidence_ref?: string | null;
  embedding_status?: string;
  embedding_model?: string | null;
  memory_lane?: "private" | "shared";
  producer_agent_id?: string | null;
  owner_agent_id?: string | null;
  owner_team_id?: string | null;
  created_at?: string;
  updated_at?: string;
  last_activated?: string | null;
  salience?: number;
  importance?: number;
  confidence?: number;
  commit_id?: string | null;
};

export type RecallEdgeDTO = {
  id: string;
  uri: string;
  from_id: string;
  to_id: string;
  type: string;
  weight: number;
  commit_id?: string | null;
  commit_uri?: string | null;
};

export function createRecallUriBuilders(tenancy: RecallTenancy) {
  const buildNodeUri = (id: string, type: string): string | null => {
    if (!URI_NODE_TYPES.has(type)) return null;
    return buildAionisUri({
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      type,
      id,
    });
  };

  const buildEdgeUri = (id: string): string =>
    buildAionisUri({
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      type: "edge",
      id,
    });

  const buildCommitUri = (id: string | null | undefined): string | null => {
    const commitId = String(id ?? "").trim();
    if (!commitId) return null;
    return buildAionisUri({
      tenant_id: tenancy.tenant_id,
      scope: tenancy.scope,
      type: "commit",
      id: commitId,
    });
  };

  return { buildNodeUri, buildEdgeUri, buildCommitUri };
}

export function toRecallNodeDto(
  node: RecallNodeRow,
  parsed: MemoryRecallInput,
  buildNodeUri: (id: string, type: string) => string | null,
): RecallNodeDTO {
  const dto: RecallNodeDTO = {
    id: node.id,
    type: node.type,
    title: node.title,
    text_summary: node.text_summary,
  };
  const uri = buildNodeUri(node.id, node.type);
  if (uri) dto.uri = uri;

  if (node.type === "topic") {
    dto.topic_state = node.topic_state;
    dto.member_count = node.member_count;
  }

  if (parsed.include_slots) {
    dto.slots = node.slots ?? null;
  } else if (parsed.include_slots_preview) {
    dto.slots_preview = pickSlotsPreview(node.slots, parsed.slots_preview_keys);
  }

  if (parsed.include_meta) {
    dto.raw_ref = node.raw_ref;
    dto.evidence_ref = node.evidence_ref;
    dto.embedding_status = node.embedding_status;
    dto.embedding_model = node.embedding_model;
    dto.memory_lane = node.memory_lane;
    dto.producer_agent_id = node.producer_agent_id;
    dto.owner_agent_id = node.owner_agent_id;
    dto.owner_team_id = node.owner_team_id;
    dto.created_at = node.created_at;
    dto.updated_at = node.updated_at;
    dto.last_activated = node.last_activated;
    dto.salience = node.salience;
    dto.importance = node.importance;
    dto.confidence = node.confidence;
    dto.commit_id = node.commit_id;
  }

  return dto;
}

export function toRecallEdgeDto(
  edge: RecallEdgeRow,
  includeMeta: boolean,
  buildEdgeUri: (id: string) => string,
  buildCommitUri: (id: string | null | undefined) => string | null,
): RecallEdgeDTO {
  const dto: RecallEdgeDTO = {
    id: edge.id,
    uri: buildEdgeUri(edge.id),
    from_id: edge.src_id,
    to_id: edge.dst_id,
    type: edge.type,
    weight: edge.weight,
  };
  if (includeMeta) {
    dto.commit_id = edge.commit_id;
    dto.commit_uri = buildCommitUri(edge.commit_id);
  }
  return dto;
}
