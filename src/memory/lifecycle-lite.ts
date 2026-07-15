import stableStringify from "fast-json-stable-stringify";
import { sha256Hex } from "../util/crypto.js";
import { normalizeText } from "../util/normalize.js";
import { redactPII } from "../util/redaction.js";
import { badRequest } from "../util/http.js";
import { computeFeedbackUpdatedNodeState, mergeNodeFeedbackLearningControlSlots } from "./node-feedback-state.js";
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

function canonicalStrings(values: string[]): string[] {
  return uniqStrings(values).sort((left, right) =>
    Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"))
  );
}

function normalizeMaybeRedact(input: string | undefined, opts: LifecycleOptions): string | undefined {
  if (!input) return input;
  const normalized = normalizeText(input, opts.maxTextLen);
  if (!opts.piiRedaction) return normalized;
  return redactPII(normalized).text;
}

function nonNegativeInt(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(0, Math.trunc(parsed)) : 0;
}

function stringList(values: string[] | null | undefined): string[] {
  return canonicalStrings(
    (values ?? []).map((value) => value.trim()).filter((value) => value.length > 0),
  ).slice(0, 32);
}

type UnusedExposureLearningControlStat = {
  memory_id: string;
  repeated_without_positive_attribution: boolean;
  exposure_count: number;
  positive_attributed_use_count: number;
};

export type ApplyUnusedExposureLearningControlLiteArgs = {
  tenant_id?: string | null;
  scope?: string | null;
  actor?: string | null;
  consumer_team_id?: string | null;
  run_id?: string | null;
  guide_trace_id?: string | null;
  reason?: string | null;
  input_sha256?: string | null;
  recorded_at?: string | null;
  job_id?: string | null;
  source_episode_id?: string | null;
  source_feedback_event_id?: string | null;
  evidence_cutoff_event_row_id?: number | null;
  memory_stats: UnusedExposureLearningControlStat[];
};

async function resolveLifecycleNodes(args: {
  liteWriteStore: LifecycleLiteStore;
  scope: string;
  actor: string;
  consumerTeamId?: string | null;
  requestedNodeIds: string[];
  requestedClientIds: string[];
}) {
  const { liteWriteStore, scope, actor, consumerTeamId, requestedNodeIds, requestedClientIds } = args;
  const foundById = new Map<string, LiteFindNodeRow>();
  const resolvedByClient: Array<{ client_id: string; node_id: string }> = [];
  const missingClientIds: string[] = [];

  for (const nodeId of requestedNodeIds) {
    const { rows } = await liteWriteStore.findNodes({
      scope,
      id: nodeId,
      consumerAgentId: actor,
      consumerTeamId: consumerTeamId ?? null,
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
      consumerTeamId: consumerTeamId ?? null,
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
  const consumerTeamId = parsed.consumer_team_id ?? null;
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
    consumerTeamId,
    requestedNodeIds,
    requestedClientIds,
  });

  if (resolvedNodeIds.length === 0) {
    badRequest("rehydrate_no_resolved_nodes", "No valid node_ids/client_ids resolved under this scope");
  }

  const movableRows: LiteFindNodeRow[] = [];
  const unchangedIds: string[] = [];
  for (const row of foundRows) {
    const fromRank = MEMORY_TIER_RANK[(row.tier as MemoryTierName) ?? "archive"] ?? MEMORY_TIER_RANK.archive;
    const toRank = MEMORY_TIER_RANK[parsed.target_tier];
    if (fromRank < toRank) movableRows.push(row);
    else unchangedIds.push(row.id);
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
        unchanged_nodes: unchangedIds.length,
        missing_node_ids: missingNodeIds,
        missing_client_ids: missingClientIds,
        moved_ids: [] as string[],
        unchanged_ids: unchangedIds,
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
    unchanged_ids: unchangedIds,
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
      unchanged_nodes: unchangedIds.length,
      missing_node_ids: missingNodeIds,
      missing_client_ids: missingClientIds,
      moved_ids: movableRows.map((row) => row.id),
      unchanged_ids: unchangedIds,
    },
  };
}

export async function applyUnusedExposureLearningControlLite(
  liteWriteStore: LifecycleLiteStore,
  input: ApplyUnusedExposureLearningControlLiteArgs,
  defaultScope: string,
  defaultTenantId: string,
  opts: LifecycleOptions,
) {
  const tenancy = resolveTenantScope(
    { scope: input.scope ?? undefined, tenant_id: input.tenant_id ?? undefined },
    { defaultScope, defaultTenantId },
  );
  const scope = tenancy.scope_key;
  const actor = input.actor ?? opts.defaultActor;
  const consumerTeamId = input.consumer_team_id ?? null;
  const startedAt = input.recorded_at ?? new Date().toISOString();
  const reason =
    normalizeMaybeRedact(input.reason ?? undefined, opts)
    ?? "Repeated guide exposure without positive host attribution crossed the inspect-before-use learning control gate.";
  const inputSha = input.input_sha256 ?? sha256Hex(stableStringify({
    job: "unused_exposure_feedback_learning_control",
    scope,
    actor,
    guide_trace_id: input.guide_trace_id ?? null,
    run_id: input.run_id ?? null,
    reason,
    memory_stats: input.memory_stats,
  }));
  const candidateStats = input.memory_stats.filter((entry) =>
    entry.repeated_without_positive_attribution
    && entry.memory_id
    && nonNegativeInt(entry.exposure_count) >= 2
    && nonNegativeInt(entry.positive_attributed_use_count) === 0
  );
  const requestedNodeIds = uniqStrings(candidateStats.map((entry) => entry.memory_id.toLowerCase()));
  const statById = new Map(candidateStats.map((entry) => [entry.memory_id.toLowerCase(), entry]));
  const { resolvedNodeIds, foundRows, missingNodeIds } = await resolveLifecycleNodes({
    liteWriteStore,
    scope,
    actor,
    consumerTeamId,
    requestedNodeIds,
    requestedClientIds: [],
  });
  const skippedPositive: string[] = [];
  const rowsToUpdate: LiteFindNodeRow[] = [];
  for (const row of foundRows) {
    const stat = statById.get(row.id);
    if (!stat) continue;
    const slots = row.slots ?? {};
    if (
      nonNegativeInt(slots.positive_attributed_use_count) > 0
      || nonNegativeInt(slots.feedback_positive) > 0
      || nonNegativeInt(stat.positive_attributed_use_count) > 0
    ) {
      skippedPositive.push(row.id);
      continue;
    }
    rowsToUpdate.push(row);
  }

  const parent = await liteWriteStore.latestCommit(scope);
  const diff = {
    job: "feedback_learning_control_inspect_before_use",
    learning_control_job_id: input.job_id ?? null,
    source_episode_id: input.source_episode_id ?? null,
    source_feedback_event_id: input.source_feedback_event_id ?? null,
    evidence_cutoff_event_row_id: input.evidence_cutoff_event_row_id ?? null,
    started_at: startedAt,
    scope,
    actor,
    run_id: input.run_id ?? null,
    guide_trace_id: input.guide_trace_id ?? null,
    reason,
    requested_node_ids: requestedNodeIds,
    resolved_node_ids: resolvedNodeIds,
    applied_node_ids: rowsToUpdate.map((row) => row.id),
    skipped_positive_attribution_memory_ids: skippedPositive,
    missing_node_ids: missingNodeIds,
    evidence_source: "repeated_unused_without_positive_attribution",
  };
  const diffJson = stableStringify(diff);
  const diffSha = sha256Hex(diffJson);
  const commitHash = sha256Hex(stableStringify({
    parentHash: parent?.commit_hash ?? "",
    inputSha,
    diffSha,
    scope,
    actor,
    kind: "feedback_learning_control_inspect_before_use",
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

  for (const row of rowsToUpdate) {
    const stat = statById.get(row.id);
    const nextSlots = mergeNodeFeedbackLearningControlSlots({
      slots: row.slots ?? {},
      posture: "inspect_before_use",
      source: "repeated_unused_without_positive_attribution",
      timestamp: startedAt,
      run_id: input.run_id ?? null,
      guide_trace_id: input.guide_trace_id ?? null,
      reason,
      input_sha256: inputSha,
      exposure_count: stat?.exposure_count ?? null,
      positive_attributed_use_count: stat?.positive_attributed_use_count ?? null,
    });
    const lifecycle = resolveNodeLifecycleSignals({
      type: row.type,
      tier: row.tier,
      title: row.title,
      text_summary: row.text_summary,
      slots: nextSlots,
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
      slots: lifecycle.slots,
      textSummary: row.text_summary,
      salience: lifecycle.salience,
      importance: lifecycle.importance,
      confidence: lifecycle.confidence,
      commitId,
    });
  }

  return {
    contract_version: "aionis_feedback_learning_control_persistence_v1",
    mode: "inspect_before_use_persistence",
    posture: "inspect_before_use",
    memory_state_mutation: rowsToUpdate.length > 0,
    authority_mutation: false,
    changed_count: rowsToUpdate.length,
    changed_memory_ids: rowsToUpdate.map((row) => row.id),
    skipped_positive_attribution_memory_ids: skippedPositive,
    missing_node_ids: missingNodeIds,
    commit_id: commitId,
    commit_hash: commitHash,
    reason: rowsToUpdate.length > 0
      ? "Repeated exposure without positive host attribution persisted an inspect-before-use memory posture."
      : skippedPositive.length > 0
        ? "Positive host attribution blocked repeated-unused learning control persistence."
        : "No repeated-unused-without-positive memory crossed the persistence gate.",
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
  const consumerTeamId = parsed.consumer_team_id ?? null;
  const startedAt = parsed.feedback_recorded_at ?? new Date().toISOString();
  const reason = normalizeMaybeRedact(parsed.reason, opts) ?? null;
  const inputText = normalizeMaybeRedact(parsed.input_text, opts);
  const inputSha = parsed.input_sha256 ?? sha256Hex(inputText ?? "");

  const requestedNodeIds = uniqStrings((parsed.node_ids ?? []).map((id) => id.toLowerCase()));
  const requestedClientIds = uniqStrings((parsed.client_ids ?? []).map((id) => id.trim()).filter((id) => id.length > 0));
  const { resolvedNodeIds, resolvedByClient, missingClientIds, missingNodeIds, foundRows } = await resolveLifecycleNodes({
    liteWriteStore,
    scope,
    actor,
    consumerTeamId,
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

  const runtimeSignalRefs = stringList(parsed.runtime_signal_refs ?? null);
  const verifierStatus = parsed.verifier_status === "unknown"
    ? null
    : parsed.verifier_status ?? null;
  const boundaryIgnoredIds = canonicalStrings(parsed.boundary_ignored_memory_ids ?? []);
  const boundaryIgnoredMemoryIds = new Set(boundaryIgnoredIds);
  const feedbackSubjects = [...foundRows]
    .sort((left, right) => Buffer.compare(Buffer.from(left.id, "utf8"), Buffer.from(right.id, "utf8")))
    .map((row) => ({
      memory_id: row.id,
      boundary_ignored: boundaryIgnoredMemoryIds.has(row.id),
    }));
  const parent = await liteWriteStore.latestCommit(scope);
  const diff = {
    job: "nodes_activate",
    started_at: startedAt,
    scope,
    actor,
    run_id: parsed.run_id ?? null,
    guide_trace_id: parsed.guide_trace_id ?? null,
    learning_episode_id: parsed.learning_episode_id ?? null,
    feedback_operation_id: parsed.feedback_operation_id ?? null,
    outcome: parsed.outcome,
    activate: parsed.activate,
    feedback: {
      used_surface: parsed.used_surface ?? null,
      verifier_status: verifierStatus,
      tool_status: parsed.tool_status ?? null,
      runtime_signal_refs: runtimeSignalRefs,
      boundary_ignored_memory_ids: boundaryIgnoredIds,
      verified_host_receipt: parsed.verified_host_receipt ?? false,
      subjects: feedbackSubjects,
    },
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

  const feedbackAttributions: Array<Record<string, unknown>> = [];
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
        used_surface: parsed.used_surface ?? null,
        verifier_status: verifierStatus,
        tool_status: parsed.tool_status ?? null,
        runtime_signal_refs: runtimeSignalRefs,
        boundary_ignored: boundaryIgnoredMemoryIds.has(row.id),
        verified_host_receipt: parsed.verified_host_receipt ?? false,
      },
    });
    const nextSlots: Record<string, unknown> = {
      ...nextState.slots,
      last_feedback_guide_trace_id: parsed.guide_trace_id ?? null,
      last_feedback_episode_id: parsed.learning_episode_id ?? null,
      last_feedback_operation_id: parsed.feedback_operation_id ?? null,
    };
    if (parsed.activate) {
      nextSlots.last_activated_at = startedAt;
    }
    feedbackAttributions.push({
      memory_id: row.id,
      guide_trace_id: parsed.guide_trace_id ?? null,
      learning_episode_id: parsed.learning_episode_id ?? null,
      feedback_operation_id: parsed.feedback_operation_id ?? null,
      run_id: parsed.run_id ?? null,
      outcome: parsed.outcome,
      used_surface: parsed.used_surface ?? null,
      verifier_status: verifierStatus,
      tool_status: parsed.tool_status ?? null,
      runtime_signal_refs: runtimeSignalRefs,
      attribution_strength: typeof nextSlots.last_feedback_attribution_strength === "string"
        ? nextSlots.last_feedback_attribution_strength
        : null,
      boundary_outcome: boundaryIgnoredMemoryIds.has(row.id) ? "boundary_ignored" : "aligned",
      feedback_positive: nonNegativeInt(nextSlots.feedback_positive),
      feedback_negative: nonNegativeInt(nextSlots.feedback_negative),
      weak_counter_signal_count: nonNegativeInt(nextSlots.weak_counter_signal_count),
      strong_counter_signal_count: nonNegativeInt(nextSlots.strong_counter_signal_count),
    });
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
      guide_trace_id: parsed.guide_trace_id ?? null,
      learning_episode_id: parsed.learning_episode_id ?? null,
      feedback_operation_id: parsed.feedback_operation_id ?? null,
      outcome: parsed.outcome,
      activate: parsed.activate,
      feedback_attributions: feedbackAttributions,
    },
  };
}
