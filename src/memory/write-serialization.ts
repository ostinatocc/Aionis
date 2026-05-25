import { buildAionisUri } from "./uri.js";
import type { PreparedWrite, WriteResult } from "./write.js";

export function buildWriteDiff(
  prepared: PreparedWrite,
  piiRedaction: boolean,
): Record<string, unknown> {
  return {
    redaction: piiRedaction ? prepared.redaction_meta : {},
    nodes: prepared.nodes.map((node) => ({
      id: node.id,
      client_id: node.client_id,
      type: node.type,
      title: node.title,
      memory_lane: node.memory_lane,
      producer_agent_id: node.producer_agent_id ?? null,
      owner_agent_id: node.owner_agent_id ?? null,
      owner_team_id: node.owner_team_id ?? null,
    })),
    edges: prepared.edges.map((edge) => ({
      id: edge.id,
      type: edge.type,
      src_id: edge.src_id,
      dst_id: edge.dst_id,
    })),
  };
}

export function buildWriteResult(
  prepared: PreparedWrite,
  commitId: string,
  commitHash: string,
): WriteResult {
  return {
    tenant_id: prepared.tenant_id,
    scope: prepared.scope_public,
    commit_id: commitId,
    commit_uri: buildAionisUri({
      tenant_id: prepared.tenant_id,
      scope: prepared.scope_public,
      type: "commit",
      id: commitId,
    }),
    commit_hash: commitHash,
    nodes: prepared.nodes.map((node) => ({
      id: node.id,
      uri: buildAionisUri({
        tenant_id: prepared.tenant_id,
        scope: prepared.scope_public,
        type: node.type,
        id: node.id,
      }),
      client_id: node.client_id,
      type: node.type,
    })),
    edges: prepared.edges.map((edge) => ({
      id: edge.id,
      uri: buildAionisUri({
        tenant_id: prepared.tenant_id,
        scope: prepared.scope_public,
        type: "edge",
        id: edge.id,
      }),
      type: edge.type,
      src_id: edge.src_id,
      dst_id: edge.dst_id,
    })),
    ...(prepared.distillation ? { distillation: prepared.distillation } : {}),
  };
}
