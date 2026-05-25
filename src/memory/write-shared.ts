import { badRequest } from "../util/http.js";
import { DEFAULT_ASSOCIATIVE_LINKING_CONFIG } from "./associative-linking-config.js";

type WriteScopedNode = {
  id: string;
  scope: string;
  client_id?: string;
  type: string;
  title?: string;
  text_summary?: string;
};

type WriteScopedEdge = {
  id: string;
  scope: string;
  src_id: string;
  dst_id: string;
};

export function resolveWriteScope(reqScope: string | undefined, defaultScope: string): string {
  return (reqScope && reqScope.trim()) || defaultScope;
}

export function resolveWriteRefId(
  value: { id?: string; client_id?: string },
  clientIdToId: Map<string, string>,
): string {
  if (value.id) return value.id;
  if (value.client_id) {
    const key = value.client_id.trim();
    const out = clientIdToId.get(key);
    if (!out) throw new Error(`unknown client_id reference: ${value.client_id}`);
    return out;
  }
  throw new Error("missing id/client_id");
}

export function selectAssociativeLinkSourceNodeIds(nodes: WriteScopedNode[]): string[] {
  const allowed = new Set<string>(DEFAULT_ASSOCIATIVE_LINKING_CONFIG.source_node_types);
  const ids: string[] = [];
  for (const node of nodes) {
    if (!allowed.has(node.type)) continue;
    ids.push(node.id);
    if (ids.length >= DEFAULT_ASSOCIATIVE_LINKING_CONFIG.max_source_node_ids) break;
  }
  return ids;
}

export function nodeEmbedText(node: WriteScopedNode, fallbackEventText: string | undefined): string | null {
  const title = node.title?.trim();
  const summary = node.text_summary?.trim();
  if (node.type === "event" || node.type === "evidence") return summary ?? title ?? fallbackEventText ?? null;
  if (node.type === "entity" || node.type === "topic" || node.type === "concept") return title ?? summary ?? null;
  if (node.type === "rule") return summary ?? title ?? null;
  return summary ?? title ?? null;
}

export function assertSingleScopeWrite(
  scope: string,
  scopePublic: string,
  nodes: WriteScopedNode[],
  edges: WriteScopedEdge[],
): void {
  const crossScopeNode = nodes.find((node) => node.scope !== scope);
  if (crossScopeNode) {
    badRequest("cross_scope_node_not_allowed", "write batch cannot override node scope", {
      request_scope: scopePublic,
      request_scope_key: scope,
      node_id: crossScopeNode.id,
      client_id: crossScopeNode.client_id ?? null,
      node_scope_key: crossScopeNode.scope,
    });
  }
  const crossScopeEdge = edges.find((edge) => edge.scope !== scope);
  if (crossScopeEdge) {
    badRequest("cross_scope_edge_not_allowed", "write batch cannot override edge scope", {
      request_scope: scopePublic,
      request_scope_key: scope,
      edge_id: crossScopeEdge.id,
      edge_scope_key: crossScopeEdge.scope,
      src_id: crossScopeEdge.src_id,
      dst_id: crossScopeEdge.dst_id,
    });
  }
}
