import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { normalizeText } from "../util/normalize.js";
import { redactPII } from "../util/redaction.js";
import { badRequest } from "../util/http.js";
import { computeFeedbackUpdatedNodeState } from "./node-feedback-state.js";
import { MEMORY_TIER_RANK, type MemoryTierName } from "./evolution-operators.js";
import { resolveNodeLifecycleSignals } from "./lifecycle-signals.js";
import { MemoryArchiveRehydrateRequest, MemoryNodesActivateRequest } from "./schemas.js";
import { resolveTenantScope } from "./tenant.js";
import type { LiteFindNodeRow, LiteWriteStore } from "../store/lite-write-store.js";

type LifecycleLiteStore = Pick<LiteWriteStore, "findNodes" | "latestCommit" | "insertCommit" | "updateNodeAnchorState">;

type LifecycleOptions = {
  maxTextLen: number;
  piiRedaction: boolean;
  defaultActor: string;
};

function uniqStrings(values: string[]): string[] {
  return Array.from(new Set(values));
}

function normalizeMaybeRedact(input: string | undefined, opts: LifecycleOptions): string | undefined {
  if (!input) return input;
  const normalized = normalizeText(input, opts.maxTextLen);
  if (!opts.piiRedaction) return normalized;
  return redactPII(normalized).text;
}

async function resolveLifecycleNodes(args: {
  liteWriteStore: LifecycleLiteStore;
  scope: string;
  actor: string;
  requestedNodeIds: string[];
  requestedClientIds: string[];
}) {
  const { liteWriteStore, scope, actor, requestedNodeIds, requestedClientIds } = args;
  const foundById = new Map<string, LiteFindNodeRow>();
  const resolvedByClient: Array<{ client_id: string; node_id: string }> = [];
  const missingClientIds: string[] = [];

  for (const nodeId of requestedNodeIds) {
    const { rows } = await liteWriteStore.findNodes({
      scope,
      id: nodeId,
      consumerAgentId: actor,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const row = rows[0];
    if (row) foundById.set(row.id, row);
  }

  for (const clientId of requestedClientIds) {
    const { rows } = await liteWriteStore.findNodes({
      scope,
      clientId,
      consumerAgentId: actor,
      consumerTeamId: null,
      limit: 1,
      offset: 0,
    });
    const row = rows[0];
    if (!row) {
      missingClientIds.push(clientId);
      continue;
    }
    resolvedByClient.push({ client_id: clientId, node_id: row.id });
    foundById.set(row.id, row);
  }

  const resolvedNodeIds = uniqStrings([
    ...requestedNodeIds,
    ...resolvedByClient.map((row) => row.node_id),
  ]);
  const missingNodeIds = resolvedNodeIds.filter((id) => !foundById.has(id));

  return {
    resolvedNodeIds,
    resolvedByClient,
    missingClientIds,
    missingNodeIds,
    foundRows: resolvedNodeIds.map((id) => foundById.get(id)).filter((row): row is LiteFindNodeRow => !!row),
  };
}

export async function rehydrateArchiveNodesLite(
  liteWriteStore: LifecycleLiteStore,
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  opts: LifecycleOptions,
) {
  const parsed = MemoryArchiveRehydrateRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope, defaultTenantId },
  );
  const scope = tenancy.scope_key;
  const actor = parsed.actor ?? opts.defaultActor;
  const startedAt = new Date().toISOString();
  const reason = normalizeMaybeRedact(parsed.reason, opts) ?? null;
  const inputText = normalizeMaybeRedact(parsed.input_text, opts);
  const inputSha = parsed.input_sha256 ?? sha256Hex(inputText ?? "");

  const requestedNodeIds = uniqStrings((parsed.node_ids ?? []).map((id) => id.toLowerCase()));
  const requestedClientIds = uniqStrings((parsed.client_ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
  const { resolvedNodeIds, resolvedByClient, missingClientIds, missingNodeIds, foundRows } = await resolveLifecycleNodes({
    liteWriteStore,
    scope,
    actor,
    requestedNodeIds,
    requestedClientIds,
  });

  if (resolvedNodeIds.length === 0) {
    badRequest("rehydrate_no_resolved_nodes", "No valid node_ids/client_ids resolved under this scope");
  }

  const movableRows: LiteFindNodeRow[] = [];
  const noopIds: string[] = [];
  for (const row of foundRows) {
    const fromRank = MEMORY_TIER_RANK[(row.tier as MemoryTierName) ?? "archive"] ?? MEMORY_TIER_RANK.archive;
    const toRank = MEMORY_TIER_RANK[parsed.target_tier];
    if (fromRank < toRank) movableRows.push(row);
    else noopIds.push(row.id);
  }

  if (movableRows.length === 0) {
    return {
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
      target_tier: parsed.target_tier,
      commit_id: null as string | null,
      commit_hash: null as string | null,
      rehydrated: {
        requested_node_ids: requestedNodeIds.length,
        requested_client_ids: requestedClientIds.length,
        resolved_node_ids: resolvedNodeIds.length,
        found_nodes: foundRows.length,
        moved_nodes: 0,
        noop_nodes: noopIds.length,
        missing_node_ids: missingNodeIds,
        missing_client_ids: missingClientIds,
        moved_ids: [] as string[],
        noop_ids: noopIds,
      },
    };
  }

  const parent = await liteWriteStore.latestCommit(scope);
  const diff = {
    job: "archive_rehydrate",
    started_at: startedAt,
    scope,
    actor,
    target_tier: parsed.target_tier,
    reason,
    requested: {
      node_ids: requestedNodeIds,
      client_ids: requestedClientIds,
    },
    resolved_by_client: resolvedByClient,
    moved_ids: movableRows.map((row) => row.id),
    noop_ids: noopIds,
    missing_node_ids: missingNodeIds,
    missing_client_ids: missingClientIds,
  };
  const diffJson = stableStringify(diff);
  const diffSha = sha256Hex(diffJson);
  const commitHash = sha256Hex(stableStringify({
    parentHash: parent?.commit_hash ?? "",
    inputSha,
    diffSha,
    scope,
    actor,
    kind: "archive_rehydrate",
  }));
  const commitId = await liteWriteStore.insertCommit({
    scope,
    parentCommitId: parent?.id ?? null,
    inputSha256: inputSha,
    diffJson,
    actor,
    modelVersion: null,
    promptVersion: null,
    commitHash,
  });

  for (const row of movableRows) {
    const lifecycle = resolveNodeLifecycleSignals({
      type: row.type,
      tier: parsed.target_tier,
      title: row.title,
      text_summary: row.text_summary,
      slots: {
        ...row.slots,
        last_rehydrated_at: startedAt,
        last_rehydrated_job: "archive_rehydrate",
        last_rehydrated_from_tier: row.tier,
        last_rehydrated_to_tier: parsed.target_tier,
        last_rehydrated_reason: reason,
        last_rehydrated_input_sha256: inputSha,
      },
      salience: row.salience,
      importance: row.importance,
      confidence: row.confidence,
      raw_ref: row.raw_ref ?? null,
      evidence_ref: row.evidence_ref ?? null,
      reference_time: startedAt,
    });
    await liteWriteStore.updateNodeAnchorState({
      scope,
      id: row.id,
      tier: parsed.target_tier,
      slots: lifecycle.slots,
      textSummary: row.text_summary,
      salience: lifecycle.salience,
      importance: lifecycle.importance,
      confidence: lifecycle.confidence,
      commitId,
    });
  }

  return {
    scope: tenancy.scope,
    tenant_id: tenancy.tenant_id,
    target_tier: parsed.target_tier,
    commit_id: commitId,
    commit_hash: commitHash,
    rehydrated: {
      requested_node_ids: requestedNodeIds.length,
      requested_client_ids: requestedClientIds.length,
      resolved_node_ids: resolvedNodeIds.length,
      found_nodes: foundRows.length,
      moved_nodes: movableRows.length,
      noop_nodes: noopIds.length,
      missing_node_ids: missingNodeIds,
      missing_client_ids: missingClientIds,
      moved_ids: movableRows.map((row) => row.id),
      noop_ids: noopIds,
    },
  };
}

export async function activateMemoryNodesLite(
  liteWriteStore: LifecycleLiteStore,
  body: unknown,
  defaultScope: string,
  defaultTenantId: string,
  opts: LifecycleOptions,
) {
  const parsed = MemoryNodesActivateRequest.parse(body);
  const tenancy = resolveTenantScope(
    { scope: parsed.scope, tenant_id: parsed.tenant_id },
    { defaultScope, defaultTenantId },
  );
  const scope = tenancy.scope_key;
  const actor = parsed.actor ?? opts.defaultActor;
  const startedAt = new Date().toISOString();
  const reason = normalizeMaybeRedact(parsed.reason, opts) ?? null;
  const inputText = normalizeMaybeRedact(parsed.input_text, opts);
  const inputSha = parsed.input_sha256 ?? sha256Hex(inputText ?? "");

  const requestedNodeIds = uniqStrings((parsed.node_ids ?? []).map((id) => id.toLowerCase()));
  const requestedClientIds = uniqStrings((parsed.client_ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
  const { resolvedNodeIds, resolvedByClient, missingClientIds, missingNodeIds, foundRows } = await resolveLifecycleNodes({
    liteWriteStore,
    scope,
    actor,
    requestedNodeIds,
    requestedClientIds,
  });

  if (resolvedNodeIds.length === 0) {
    badRequest("nodes_activate_no_resolved_nodes", "No valid node_ids/client_ids resolved under this scope");
  }

  if (foundRows.length === 0) {
    return {
      scope: tenancy.scope,
      tenant_id: tenancy.tenant_id,
      commit_id: null as string | null,
      commit_hash: null as string | null,
      activated: {
        requested_node_ids: requestedNodeIds.length,
        requested_client_ids: requestedClientIds.length,
        resolved_node_ids: resolvedNodeIds.length,
        found_nodes: 0,
        updated_nodes: 0,
        missing_node_ids: missingNodeIds,
        missing_client_ids: missingClientIds,
        updated_ids: [] as string[],
      },
    };
  }

  const parent = await liteWriteStore.latestCommit(scope);
  const diff = {
    job: "nodes_activate",
    started_at: startedAt,
    scope,
    actor,
    run_id: parsed.run_id ?? null,
    outcome: parsed.outcome,
    activate: parsed.activate,
    reason,
    requested: {
      node_ids: requestedNodeIds,
      client_ids: requestedClientIds,
    },
    resolved_by_client: resolvedByClient,
    found_node_ids: foundRows.map((row) => row.id),
    missing_node_ids: missingNodeIds,
    missing_client_ids: missingClientIds,
  };
  const diffJson = stableStringify(diff);
  const diffSha = sha256Hex(diffJson);
  const commitHash = sha256Hex(stableStringify({
    parentHash: parent?.commit_hash ?? "",
    inputSha,
    diffSha,
    scope,
    actor,
    kind: "nodes_activate",
  }));
  const commitId = await liteWriteStore.insertCommit({
    scope,
    parentCommitId: parent?.id ?? null,
    inputSha256: inputSha,
    diffJson,
    actor,
    modelVersion: null,
    promptVersion: null,
    commitHash,
  });

  for (const row of foundRows) {
    const nextState = computeFeedbackUpdatedNodeState({
      node: row,
      feedback: {
        outcome: parsed.outcome,
        run_id: parsed.run_id ?? null,
        reason,
        input_sha256: inputSha,
        source: "nodes_activate",
        timestamp: startedAt,
      },
    });
    const nextSlots: Record<string, unknown> = {
      ...nextState.slots,
    };
    if (parsed.activate) {
      nextSlots.last_activated_at = startedAt;
    }
    const lifecycle = resolveNodeLifecycleSignals({
      type: row.type,
      tier: row.tier,
      title: row.title,
      text_summary: row.text_summary,
      slots: nextSlots,
      salience: nextState.salience,
      importance: nextState.importance,
      confidence: nextState.confidence,
      raw_ref: row.raw_ref ?? null,
      evidence_ref: row.evidence_ref ?? null,
      reference_time: startedAt,
    });
    await liteWriteStore.updateNodeAnchorState({
      scope,
      id: row.id,
      slots: lifecycle.slots,
      textSummary: row.text_summary,
      salience: lifecycle.salience,
      importance: lifecycle.importance,
      confidence: lifecycle.confidence,
      commitId,
    });
  }

  return {
    scope: tenancy.scope,
    tenant_id: tenancy.tenant_id,
    commit_id: commitId,
    commit_hash: commitHash,
    activated: {
      requested_node_ids: requestedNodeIds.length,
      requested_client_ids: requestedClientIds.length,
      resolved_node_ids: resolvedNodeIds.length,
      found_nodes: foundRows.length,
      updated_nodes: foundRows.length,
      missing_node_ids: missingNodeIds,
      missing_client_ids: missingClientIds,
      updated_ids: foundRows.map((row) => row.id),
      outcome: parsed.outcome,
      activate: parsed.activate,
    },
  };
}
