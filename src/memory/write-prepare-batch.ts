import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { normalizeText } from "../util/normalize.js";
import { redactJsonStrings, redactPII } from "../util/redaction.js";
import { stableUuid } from "../util/uuid.js";
import { badRequest } from "../util/http.js";
import type { MemoryWriteInput } from "./schemas.js";
import { toTenantScopeKey } from "./tenant.js";
import {
  enrichPreparedNodeLifecycle,
  normalizeExecutionNativeSlots,
  restoreStableSystemSlots,
} from "./write-execution-native.js";
import {
  resolveWriteRefId,
  resolveWriteScope,
} from "./write-shared.js";
import type { PreparedEdge, PreparedNode } from "./write.js";

type PrepareBatchTenancy = {
  tenant_id: string;
  scope: string;
  scope_key: string;
};

type PrepareBatchOptions = {
  maxTextLen: number;
  piiRedaction: boolean;
};

type SeenPreparedNodeRef = {
  index: number;
  scope: string;
  client_id?: string;
};

export type PreparedWriteBatch = {
  inputText: string | undefined;
  redactionMeta: Record<string, number>;
  defaultLane: "private" | "shared";
  defaultProducerAgentId?: string;
  defaultOwnerAgentId?: string;
  defaultOwnerTeamId?: string;
  nodes: PreparedNode[];
  edges: PreparedEdge[];
  seenNodeIds: Map<string, SeenPreparedNodeRef>;
};

function stableNodeIdFromClientId(scope: string, clientId: string): string {
  return stableUuid(`${scope}:node:${clientId.trim()}`);
}

export function prepareWriteBatch(
  parsed: MemoryWriteInput,
  tenancy: PrepareBatchTenancy,
  defaultTenantId: string,
  opts: PrepareBatchOptions,
): PreparedWriteBatch {
  const redactionMeta: Record<string, number> = {};
  const bump = (counts: Record<string, number>) => {
    for (const [key, value] of Object.entries(counts)) redactionMeta[key] = (redactionMeta[key] ?? 0) + value;
  };

  const normalizeMaybeRedact = (value: string | undefined): string | undefined => {
    if (!value) return value;
    const normalized = normalizeText(value, opts.maxTextLen);
    if (!opts.piiRedaction) return normalized;
    const redacted = redactPII(normalized);
    bump(redacted.counts);
    return redacted.text;
  };

  const normalizeId = (value: string | undefined): string | undefined => {
    if (!value) return undefined;
    const normalized = value.trim();
    return normalized.length > 0 ? normalized : undefined;
  };

  const defaultLane = parsed.memory_lane ?? "private";
  const defaultProducerAgentId = normalizeId(parsed.producer_agent_id);
  const defaultOwnerAgentId = normalizeId(parsed.owner_agent_id);
  const defaultOwnerTeamId = normalizeId(parsed.owner_team_id);

  const inputText = normalizeMaybeRedact(parsed.input_text);
  if (parsed.input_text && (!inputText || inputText.length === 0)) {
    throw new Error("input_text becomes empty after normalization; provide non-whitespace content");
  }

  const clientIdToId = new Map<string, string>();
  const seenClientIds = new Map<string, SeenPreparedNodeRef>();
  const seenNodeIds = new Map<string, SeenPreparedNodeRef>();
  const nodes: PreparedNode[] = [];

  for (const [index, node] of parsed.nodes.entries()) {
    const nodeScopePublic = resolveWriteScope(node.scope, tenancy.scope);
    const nodeScope = toTenantScopeKey(nodeScopePublic, tenancy.tenant_id, defaultTenantId);
    const client_id = node.client_id?.trim();
    if (node.client_id && (!client_id || client_id.length === 0)) {
      throw new Error("client_id becomes empty after trimming; provide a non-whitespace client_id");
    }
    if (client_id) {
      const prior = seenClientIds.get(client_id);
      if (prior) {
        badRequest("duplicate_client_id_in_batch", "write batch contains duplicate client_id", {
          client_id,
          first_index: prior.index,
          duplicate_index: index,
          first_scope_key: prior.scope,
          duplicate_scope_key: nodeScope,
        });
      }
    }

    const expectedId = client_id ? stableNodeIdFromClientId(nodeScope, client_id) : null;
    if (node.id && expectedId && node.id !== expectedId) {
      throw new Error(`client_id/id mismatch: scope=${nodeScope} client_id=${client_id} id=${node.id} expected_id=${expectedId}`);
    }

    const id = node.id ?? (expectedId ?? stableUuid(`${nodeScope}:node:${sha256Hex(stableStringify(node))}`));
    const priorId = seenNodeIds.get(id);
    if (priorId) {
      badRequest("duplicate_node_id_in_batch", "write batch contains duplicate node id", {
        node_id: id,
        first_index: priorId.index,
        duplicate_index: index,
        first_scope_key: priorId.scope,
        duplicate_scope_key: nodeScope,
        first_client_id: priorId.client_id ?? null,
        duplicate_client_id: client_id ?? null,
      });
    }
    if (client_id) {
      seenClientIds.set(client_id, { index, scope: nodeScope, client_id });
      clientIdToId.set(client_id, id);
    }
    seenNodeIds.set(id, { index, scope: nodeScope, client_id });

    const title = normalizeMaybeRedact(node.title);
    const text_summary = normalizeMaybeRedact(node.text_summary);
    const embedding_model = normalizeMaybeRedact((node as { embedding_model?: string }).embedding_model);
    let slots = node.slots ?? {};
    if (opts.piiRedaction) {
      const redacted = redactJsonStrings(slots);
      slots = restoreStableSystemSlots(slots, (redacted.value ?? {}) as Record<string, unknown>);
      bump(redacted.counts);
    }
    slots = normalizeExecutionNativeSlots(node.type, slots, title ?? null, text_summary ?? null);

    const lane = node.memory_lane ?? defaultLane;
    const producerAgentId = normalizeId(node.producer_agent_id) ?? defaultProducerAgentId;
    const ownerAgentId = normalizeId(node.owner_agent_id) ?? defaultOwnerAgentId ?? producerAgentId;
    const ownerTeamId = normalizeId(node.owner_team_id) ?? defaultOwnerTeamId;

    nodes.push(enrichPreparedNodeLifecycle({
      ...node,
      client_id,
      id,
      scope: nodeScope,
      memory_lane: lane,
      producer_agent_id: producerAgentId,
      owner_agent_id: ownerAgentId,
      owner_team_id: ownerTeamId,
      title,
      text_summary,
      embedding_model,
      slots,
    }));
  }

  for (const node of nodes) {
    if (node.type !== "rule") continue;
    if (node.memory_lane !== "private") continue;
    if (node.owner_agent_id || node.owner_team_id) continue;
    badRequest("invalid_private_rule_owner", "private rule requires owner_agent_id or owner_team_id", {
      node_id: node.id,
      client_id: node.client_id ?? null,
      memory_lane: node.memory_lane,
      type: node.type,
    });
  }

  const edges: PreparedEdge[] = parsed.edges.map((edge) => {
    const edgeScopePublic = resolveWriteScope(edge.scope, tenancy.scope);
    const edgeScope = toTenantScopeKey(edgeScopePublic, tenancy.tenant_id, defaultTenantId);
    const id =
      edge.id ??
      stableUuid(
        `${edgeScope}:edge:${inputText ?? parsed.input_sha256 ?? "noinput"}:${edge.type}:${edge.src.id ?? edge.src.client_id}:${edge.dst.id ?? edge.dst.client_id}`,
      );
    const src_id = resolveWriteRefId(edge.src, clientIdToId);
    const dst_id = resolveWriteRefId(edge.dst, clientIdToId);
    return { ...edge, id, scope: edgeScope, src_id, dst_id };
  });

  return {
    inputText,
    redactionMeta,
    defaultLane,
    defaultProducerAgentId,
    defaultOwnerAgentId,
    defaultOwnerTeamId,
    nodes,
    edges,
    seenNodeIds,
  };
}
