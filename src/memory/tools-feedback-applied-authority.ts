import type {
  LiteExecutionDecisionRow,
  LiteRuleDefSyncRow,
  LiteRuleFeedbackRow,
  LiteWriteStore,
} from "../store/lite-write-store.js";
import type { WriteExistingNodeState } from "../store/write-access.js";
import {
  materializeAppliedAuthorityRow,
  normalizeAppliedAuthorityRow,
  type CanonicalAuthorityMutationVerificationV2,
  type CanonicalAuthorityTableMutationV2,
} from "../store/write-commit-authority.js";
import { sha256Hex } from "../util/crypto.js";
import { assertAuthorityWriteReceipts } from "./authority-write-guard.js";
import {
  runAppliedAuthorityMutationV2,
  type AppliedAuthorityMutationResult,
} from "./applied-authority-mutation.js";
import {
  assertPreparedPolicyMemoryFeedbackCurrent,
  assertPreparedPolicyMemorySnapshotCurrent,
  sealPolicyAuthoritySlots,
} from "./policy-memory.js";
import { SELF_COMMIT_REFERENCE } from "./write-serialization.js";
import {
  authorityNodeEmbeddingText,
  EMBEDDING_SOURCE_TEXT_CHANGED_PENDING_REASON,
  nodeEmbeddingAuthorityFieldsAfterTextUpdate,
} from "./node-embedding-freshness.js";
import type { PreparedNode, PreparedWrite } from "./write-contract.js";
import type { PreparedToolSelectionFeedback } from "./tools-feedback-contract.js";
import { assertPreparedToolsDecisionPatternAnchorCurrent } from "./tools-pattern-anchor.js";

type CanonicalAuthorityRow = Record<string, unknown> & { commit_id: string | null };

type ToolFeedbackAuthorityValue = Readonly<{
  decision: LiteExecutionDecisionRow;
}>;

export type AppliedToolFeedbackAuthorityResult = AppliedAuthorityMutationResult<ToolFeedbackAuthorityValue>;

type ToolFeedbackNodeOverlay = Readonly<{
  slots: Record<string, unknown>;
  textSummary: string;
  salience: number;
  importance: number;
  confidence: number;
}>;

type ToolFeedbackNodeInsertSource = Readonly<{
  preparedWrite: PreparedWrite;
  node: PreparedNode;
}>;

type ToolFeedbackNodePlan = Readonly<{
  identity: { scope: string; id: string };
  operation: "insert" | "update";
  before: CanonicalAuthorityRow | null;
  after: CanonicalAuthorityRow;
  insertSource: ToolFeedbackNodeInsertSource | null;
}>;

function parsePersistedJson(value: string | null): unknown | null {
  if (value === null) return null;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

function decisionAuthorityRow(row: LiteExecutionDecisionRow): CanonicalAuthorityRow {
  return {
    id: row.id,
    scope: row.scope,
    decision_kind: row.decision_kind,
    run_id: row.run_id,
    selected_tool: row.selected_tool,
    candidates_json: row.candidates_json,
    context_sha256: row.context_sha256,
    policy_sha256: row.policy_sha256,
    source_rule_ids_json: row.source_rule_ids,
    metadata_json: row.metadata_json,
    commit_id: row.commit_id,
    created_at: row.created_at,
  };
}

function preparedDecisionAfter(prepared: PreparedToolSelectionFeedback): CanonicalAuthorityRow {
  const row = prepared.decision.after;
  return {
    id: row.id,
    scope: row.scope,
    decision_kind: "tools_select",
    run_id: row.run_id,
    selected_tool: row.selected_tool,
    candidates_json: row.candidates_json,
    context_sha256: row.context_sha256,
    policy_sha256: row.policy_sha256,
    source_rule_ids_json: row.source_rule_ids,
    metadata_json: row.metadata_json,
    commit_id: SELF_COMMIT_REFERENCE,
    created_at: row.created_at,
  };
}

function ruleFeedbackAuthorityRow(row: LiteRuleFeedbackRow): CanonicalAuthorityRow {
  return {
    id: row.id,
    scope: row.scope,
    rule_node_id: row.rule_node_id,
    run_id: row.run_id,
    outcome: row.outcome,
    note: row.note,
    source: row.source,
    decision_id: row.decision_id,
    commit_id: row.commit_id,
    created_at: row.created_at,
  };
}

function preparedRuleFeedbackAfter(
  prepared: PreparedToolSelectionFeedback,
  feedback: PreparedToolSelectionFeedback["rule_feedback"][number],
): CanonicalAuthorityRow {
  return {
    id: feedback.id,
    scope: prepared.scope_key,
    rule_node_id: feedback.rule_node_id,
    run_id: prepared.parsed.run_id ?? null,
    outcome: prepared.parsed.outcome,
    note: prepared.note,
    source: "tools_feedback",
    decision_id: prepared.decision.after.id,
    commit_id: SELF_COMMIT_REFERENCE,
    created_at: prepared.feedback_created_at,
  };
}

function ruleDefAuthorityRow(row: LiteRuleDefSyncRow): CanonicalAuthorityRow {
  return {
    rule_node_id: row.rule_node_id,
    scope: row.scope,
    state: row.state,
    if_json: row.if_json,
    then_json: row.then_json,
    exceptions_json: row.exceptions_json,
    rule_scope: row.rule_scope,
    target_agent_id: row.target_agent_id,
    target_team_id: row.target_team_id,
    positive_count: row.positive_count,
    negative_count: row.negative_count,
    commit_id: row.commit_id,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function ruleDefAfter(
  before: CanonicalAuthorityRow,
  outcome: "positive" | "negative" | "neutral",
  appliedAt: string,
): CanonicalAuthorityRow {
  return {
    ...before,
    positive_count: Number(before.positive_count) + (outcome === "positive" ? 1 : 0),
    negative_count: Number(before.negative_count) + (outcome === "negative" ? 1 : 0),
    commit_id: SELF_COMMIT_REFERENCE,
    updated_at: appliedAt,
  };
}

function existingNodeAuthorityRow(row: WriteExistingNodeState): CanonicalAuthorityRow {
  return {
    id: row.id,
    scope: row.scope,
    client_id: row.clientId,
    type: row.type,
    tier: row.tier,
    title: row.title,
    text_summary: row.textSummary,
    slots_json: parsePersistedJson(row.slotsJson),
    raw_ref: row.rawRef,
    evidence_ref: row.evidenceRef,
    embedding_vector_json: parsePersistedJson(row.embeddingVector),
    embedding_model: row.embeddingModel,
    memory_lane: row.memoryLane,
    producer_agent_id: row.producerAgentId,
    owner_agent_id: row.ownerAgentId,
    owner_team_id: row.ownerTeamId,
    embedding_status: row.embeddingStatus,
    embedding_last_error: row.embeddingLastError,
    salience: row.salience,
    importance: row.importance,
    confidence: row.confidence,
    redaction_version: row.redactionVersion,
    commit_id: row.commitId,
    created_at: row.createdAt,
  };
}

function preparedNodeAuthorityRow(args: {
  preparedWrite: PreparedWrite;
  node: PreparedNode;
  appliedAt: string;
}): CanonicalAuthorityRow {
  const { preparedWrite, node } = args;
  if (node.embedding && node.embedding.length !== 1536) {
    throw new Error(`tool_feedback_prepared_node_embedding_dimension_invalid:${node.id}`);
  }
  const embedPlanned = preparedWrite.auto_embed_effective
    && !node.embedding
    && typeof node.embed_text === "string"
    && node.embed_text.trim().length > 0;
  const embeddingStatus = node.embedding ? "ready" : embedPlanned ? "pending" : "failed";
  const embeddingLastError = node.embedding
    ? null
    : embedPlanned
      ? null
      : preparedWrite.auto_embed_effective
        ? "no_embed_text"
        : "auto_embed_disabled_or_no_provider";
  return {
    id: node.id,
    scope: node.scope,
    client_id: node.client_id ?? null,
    type: node.type,
    tier: node.tier ?? "hot",
    title: node.title ?? null,
    text_summary: node.text_summary ?? null,
    slots_json: node.slots,
    raw_ref: node.raw_ref ?? null,
    evidence_ref: node.evidence_ref ?? null,
    embedding_vector_json: node.embedding ?? null,
    embedding_model: node.embedding
      ? (node.embedding_model?.trim() ? node.embedding_model.trim() : "client")
      : null,
    memory_lane: node.memory_lane,
    producer_agent_id: node.producer_agent_id ?? null,
    owner_agent_id: node.owner_agent_id ?? null,
    owner_team_id: node.owner_team_id ?? null,
    embedding_status: embeddingStatus,
    embedding_last_error: embeddingLastError,
    salience: node.salience ?? 0.5,
    importance: node.importance ?? 0.5,
    confidence: node.confidence ?? 0.5,
    redaction_version: 1,
    commit_id: SELF_COMMIT_REFERENCE,
    created_at: args.appliedAt,
  };
}

function authorityMutation(args: {
  table: string;
  identity: Record<string, unknown>;
  operation: "insert" | "update";
  before: CanonicalAuthorityRow | null;
  requested?: Record<string, unknown>;
  after: CanonicalAuthorityRow;
}): CanonicalAuthorityTableMutationV2 {
  return args;
}

function collectPreparedNodeWrite(args: {
  preparedWrite: PreparedWrite | null;
  scope: string;
  inserts: Map<string, ToolFeedbackNodeInsertSource>;
}): void {
  const preparedWrite = args.preparedWrite;
  if (!preparedWrite) return;
  if (preparedWrite.scope !== args.scope || preparedWrite.edges.length !== 0) {
    throw new Error("tool_feedback_embedded_write_contract_invalid");
  }
  for (const node of preparedWrite.nodes) {
    if (node.scope !== args.scope || args.inserts.has(node.id)) {
      throw new Error(`tool_feedback_embedded_node_identity_invalid:${node.id}`);
    }
    args.inserts.set(node.id, { preparedWrite, node });
  }
}

async function buildNodePlans(args: {
  prepared: PreparedToolSelectionFeedback;
  store: LiteWriteStore;
  appliedAt: string;
}): Promise<ToolFeedbackNodePlan[]> {
  const { prepared, store, appliedAt } = args;
  if (prepared.pattern) {
    await assertPreparedToolsDecisionPatternAnchorCurrent(prepared.pattern, store);
  }
  if (prepared.policy_snapshot) {
    await assertPreparedPolicyMemorySnapshotCurrent(prepared.policy_snapshot, store);
  }
  if (prepared.policy_feedback) {
    await assertPreparedPolicyMemoryFeedbackCurrent(prepared.policy_feedback, store);
  }

  const inserts = new Map<string, ToolFeedbackNodeInsertSource>();
  collectPreparedNodeWrite({
    preparedWrite: prepared.pattern?.prepared_write ?? null,
    scope: prepared.scope_key,
    inserts,
  });
  collectPreparedNodeWrite({
    preparedWrite: prepared.policy_snapshot?.prepared_write ?? null,
    scope: prepared.scope_key,
    inserts,
  });

  const overlays = new Map<string, ToolFeedbackNodeOverlay>();
  const policyNodeIds = new Set<string>();
  if (prepared.pattern?.update) {
    overlays.set(prepared.pattern.update.id, {
      slots: prepared.pattern.update.slots,
      textSummary: prepared.pattern.update.text_summary,
      salience: prepared.pattern.update.salience,
      importance: prepared.pattern.update.importance,
      confidence: prepared.pattern.update.confidence,
    });
  }
  if (prepared.policy_snapshot) {
    policyNodeIds.add(prepared.policy_snapshot.result.node_id);
    if (prepared.policy_snapshot.update) {
      overlays.set(prepared.policy_snapshot.update.id, {
        slots: prepared.policy_snapshot.update.slots,
        textSummary: prepared.policy_snapshot.update.text_summary,
        salience: prepared.policy_snapshot.update.salience,
        importance: prepared.policy_snapshot.update.importance,
        confidence: prepared.policy_snapshot.update.confidence,
      });
    }
  }
  for (const update of prepared.policy_feedback?.updates ?? []) {
    policyNodeIds.add(update.id);
    overlays.set(update.id, {
      slots: update.slots,
      textSummary: update.text_summary,
      salience: update.salience,
      importance: update.importance,
      confidence: update.confidence,
    });
  }

  const nodeIds = Array.from(new Set([...inserts.keys(), ...overlays.keys()])).sort();
  const existing = await store.nodeStatesByIds(prepared.scope_key, nodeIds);
  const plans: ToolFeedbackNodePlan[] = [];
  for (const id of nodeIds) {
    const insertSource = inserts.get(id) ?? null;
    const existingState = existing.get(id) ?? null;
    if (insertSource && existingState) {
      throw new Error(`tool_feedback_embedded_node_prepare_conflict:${id}`);
    }
    if (!insertSource && !existingState) {
      throw new Error(`tool_feedback_embedded_node_missing:${id}`);
    }
    const before = existingState ? existingNodeAuthorityRow(existingState) : null;
    let after = insertSource
      ? preparedNodeAuthorityRow({ ...insertSource, appliedAt })
      : { ...before! };
    const overlay = overlays.get(id);
    if (overlay) {
      const beforeTextSummary = typeof after.text_summary === "string" ? after.text_summary : null;
      after = {
        ...after,
        slots_json: overlay.slots,
        text_summary: overlay.textSummary,
        ...nodeEmbeddingAuthorityFieldsAfterTextUpdate({
          beforeTextSummary,
          afterTextSummary: overlay.textSummary,
          current: {
            embedding_vector_json: after.embedding_vector_json,
            embedding_model: typeof after.embedding_model === "string" ? after.embedding_model : null,
            embedding_status: after.embedding_status as "pending" | "ready" | "failed",
            embedding_last_error: typeof after.embedding_last_error === "string"
              ? after.embedding_last_error
              : null,
          },
        }),
        salience: overlay.salience,
        importance: overlay.importance,
        confidence: overlay.confidence,
      };
    }
    if (policyNodeIds.has(id)) {
      after = {
        ...after,
        slots_json: sealPolicyAuthoritySlots({
          scope: prepared.scope_key,
          id,
          clientId: typeof after.client_id === "string" ? after.client_id : null,
          slots: after.slots_json as Record<string, unknown>,
          issuedAt: appliedAt,
        }),
      };
    }
    after = { ...after, commit_id: SELF_COMMIT_REFERENCE };
    plans.push({
      identity: { scope: prepared.scope_key, id },
      operation: insertSource ? "insert" : "update",
      before,
      after,
      insertSource,
    });
  }
  return plans;
}

async function insertPreparedNodeProjection(args: {
  store: LiteWriteStore;
  source: ToolFeedbackNodeInsertSource;
  after: CanonicalAuthorityRow;
  commitId: string;
}): Promise<void> {
  const { preparedWrite, node } = args.source;
  const embedText = args.after.embedding_last_error === EMBEDDING_SOURCE_TEXT_CHANGED_PENDING_REASON
    ? authorityNodeEmbeddingText({
        textSummary: typeof args.after.text_summary === "string" ? args.after.text_summary : null,
        title: typeof args.after.title === "string" ? args.after.title : null,
      })
    : typeof node.embed_text === "string" ? node.embed_text.trim() : "";
  if (!preparedWrite.auto_embed_effective
    || args.after.embedding_status !== "pending"
    || !embedText) return;
  const providerName = preparedWrite.embedding_provider_name?.trim() ?? "";
  const providerDim = preparedWrite.embedding_provider_dim;
  if (!providerName || !Number.isInteger(providerDim) || Number(providerDim) <= 0) {
    throw new Error("durable embedding projection requires a bound provider name and dimension");
  }
  await args.store.enqueueEmbeddingProjection({
    scope: preparedWrite.scope,
    nodeId: node.id,
    sourceCommitId: args.commitId,
    payload: {
      v: 1,
      tenant_id: preparedWrite.tenant_id,
      scope: preparedWrite.scope_public,
      scope_key: preparedWrite.scope,
      commit_id: args.commitId,
      node_id: node.id,
      embed_text: embedText,
      embed_text_sha256: sha256Hex(embedText),
      provider_name: providerName,
      provider_dim: Number(providerDim),
      force_reembed: preparedWrite.force_reembed,
      recovery_origin: "semantic_commit",
    },
  });
}

async function applyNodePlan(args: {
  store: LiteWriteStore;
  plan: ToolFeedbackNodePlan;
  commitId: string;
}): Promise<void> {
  const after = materializeAppliedAuthorityRow(
    "lite_memory_nodes",
    args.plan.after,
    args.commitId,
  );
  const slots = after.slots_json as Record<string, unknown>;
  assertAuthorityWriteReceipts([{
    id: String(after.id),
    client_id: typeof after.client_id === "string" ? after.client_id : undefined,
    scope: String(after.scope),
    type: String(after.type),
    slots,
  }]);
  if (args.plan.operation === "insert") {
    await args.store.insertNode({
      id: String(after.id),
      scope: String(after.scope),
      clientId: typeof after.client_id === "string" ? after.client_id : null,
      type: String(after.type),
      tier: String(after.tier),
      title: typeof after.title === "string" ? after.title : null,
      textSummary: typeof after.text_summary === "string" ? after.text_summary : null,
      slotsJson: JSON.stringify(slots),
      rawRef: typeof after.raw_ref === "string" ? after.raw_ref : null,
      evidenceRef: typeof after.evidence_ref === "string" ? after.evidence_ref : null,
      embeddingVector: after.embedding_vector_json === null
        ? null
        : JSON.stringify(after.embedding_vector_json),
      embeddingModel: typeof after.embedding_model === "string" ? after.embedding_model : null,
      memoryLane: after.memory_lane as "private" | "shared",
      producerAgentId: typeof after.producer_agent_id === "string" ? after.producer_agent_id : null,
      ownerAgentId: typeof after.owner_agent_id === "string" ? after.owner_agent_id : null,
      ownerTeamId: typeof after.owner_team_id === "string" ? after.owner_team_id : null,
      embeddingStatus: after.embedding_status as "pending" | "ready" | "failed",
      embeddingLastError: typeof after.embedding_last_error === "string" ? after.embedding_last_error : null,
      salience: Number(after.salience),
      importance: Number(after.importance),
      confidence: Number(after.confidence),
      redactionVersion: Number(after.redaction_version),
      commitId: args.commitId,
      createdAt: String(after.created_at),
    });
    if (!args.plan.insertSource) throw new Error("tool_feedback_node_insert_source_missing");
    await insertPreparedNodeProjection({
      store: args.store,
      source: args.plan.insertSource,
      after,
      commitId: args.commitId,
    });
    return;
  }
  const updated = await args.store.updateNodeAnchorState({
    scope: String(after.scope),
    id: String(after.id),
    slots,
    textSummary: typeof after.text_summary === "string" ? after.text_summary : null,
    salience: Number(after.salience),
    importance: Number(after.importance),
    confidence: Number(after.confidence),
    tier: String(after.tier),
    commitId: args.commitId,
  });
  if (!updated) throw new Error(`tool_feedback_node_update_failed:${String(after.id)}`);
}

function verification(
  table: string,
  identity: Record<string, unknown>,
  after: CanonicalAuthorityRow,
  commitId: string,
): CanonicalAuthorityMutationVerificationV2 {
  return {
    table,
    identity,
    after: normalizeAppliedAuthorityRow(table, after, commitId),
  };
}

export async function persistToolFeedbackAppliedAuthority(args: {
  prepared: PreparedToolSelectionFeedback;
  store: LiteWriteStore;
  assertPreparedCurrent(): Promise<void>;
}): Promise<AppliedToolFeedbackAuthorityResult> {
  const { prepared, store } = args;
  return await runAppliedAuthorityMutationV2({
    store,
    scope: prepared.scope_key,
    inputSha256: prepared.input_sha256,
    actor: prepared.actor,
    expectedHeadRevision: prepared.expected_head_revision,
    expectedHeadCommitId: prepared.expected_head_commit_id,
    async plan({ appliedAt }) {
      await args.assertPreparedCurrent();

      const decisionBefore = await store.getExecutionDecision({
        scope: prepared.scope_key,
        id: prepared.decision.after.id,
      });
      const decisionAfter = preparedDecisionAfter(prepared);
      const decisionMutation = authorityMutation({
        table: "lite_memory_execution_decisions",
        identity: { scope: prepared.scope_key, id: prepared.decision.after.id },
        operation: prepared.decision.create ? "insert" : "update",
        before: decisionBefore ? decisionAuthorityRow(decisionBefore) : null,
        requested: {
          tool_feedback: {
            decision_id: prepared.decision.after.id,
            decision_link_mode: prepared.decision.decision_link_mode,
            run_id: prepared.parsed.run_id ?? null,
            outcome: prepared.parsed.outcome,
            selected_tool: prepared.selected_tool,
            candidates: prepared.normalized_candidates,
            rule_node_ids: prepared.source_rule_ids,
            target: prepared.parsed.target,
            include_shadow: prepared.parsed.include_shadow,
          },
        },
        after: decisionAfter,
      });

      const ruleFeedbackMutations: CanonicalAuthorityTableMutationV2[] = [];
      for (const feedback of prepared.rule_feedback) {
        const existing = await store.getRuleFeedback(prepared.scope_key, feedback.id);
        if (existing) throw new Error(`tool_feedback_row_prepare_conflict:${feedback.id}`);
        ruleFeedbackMutations.push(authorityMutation({
          table: "lite_memory_rule_feedback",
          identity: { scope: prepared.scope_key, id: feedback.id },
          operation: "insert",
          before: null,
          after: preparedRuleFeedbackAfter(prepared, feedback),
        }));
      }

      const ruleDefMutations: CanonicalAuthorityTableMutationV2[] = [];
      for (const ruleNodeId of prepared.source_rule_ids) {
        const current = await store.getRuleDef(prepared.scope_key, ruleNodeId);
        if (!current) throw new Error(`tool_feedback_rule_def_missing:${ruleNodeId}`);
        const before = ruleDefAuthorityRow(current);
        ruleDefMutations.push(authorityMutation({
          table: "lite_memory_rule_defs",
          identity: { scope: prepared.scope_key, rule_node_id: ruleNodeId },
          operation: "update",
          before,
          after: ruleDefAfter(before, prepared.parsed.outcome, appliedAt),
        }));
      }

      const nodePlans = await buildNodePlans({ prepared, store, appliedAt });
      const nodeMutations = nodePlans.map((node) => authorityMutation({
        table: "lite_memory_nodes",
        identity: node.identity,
        operation: node.operation,
        before: node.before,
        after: node.after,
      }));
      const mutations = [
        decisionMutation,
        ...ruleFeedbackMutations,
        ...ruleDefMutations,
        ...nodeMutations,
      ];

      return {
        status: "mutate" as const,
        authorityKind: "tool_feedback",
        mutations,
        async apply({ commitId }) {
          const materializedDecision = materializeAppliedAuthorityRow(
            "lite_memory_execution_decisions",
            decisionAfter,
            commitId,
          );
          if (prepared.decision.create) {
            await store.insertExecutionDecision({
              id: String(materializedDecision.id),
              scope: String(materializedDecision.scope),
              decisionKind: "tools_select",
              runId: typeof materializedDecision.run_id === "string" ? materializedDecision.run_id : null,
              selectedTool: typeof materializedDecision.selected_tool === "string"
                ? materializedDecision.selected_tool
                : null,
              candidatesJson: materializedDecision.candidates_json as unknown[],
              contextSha256: String(materializedDecision.context_sha256),
              policySha256: String(materializedDecision.policy_sha256),
              sourceRuleIds: materializedDecision.source_rule_ids_json as string[],
              metadataJson: materializedDecision.metadata_json as Record<string, unknown>,
              commitId,
              createdAt: String(materializedDecision.created_at),
            });
          } else {
            const linked = await store.updateExecutionDecisionLink({
              scope: prepared.scope_key,
              id: prepared.decision.after.id,
              runId: typeof materializedDecision.run_id === "string" ? materializedDecision.run_id : null,
              commitId,
            });
            if (!linked) throw new Error("tool_feedback_decision_update_failed");
          }

          for (const feedback of prepared.rule_feedback) {
            const after = materializeAppliedAuthorityRow(
              "lite_memory_rule_feedback",
              preparedRuleFeedbackAfter(prepared, feedback),
              commitId,
            );
            await store.insertRuleFeedback({
              id: String(after.id),
              scope: String(after.scope),
              ruleNodeId: String(after.rule_node_id),
              runId: typeof after.run_id === "string" ? after.run_id : null,
              outcome: after.outcome as "positive" | "negative" | "neutral",
              note: typeof after.note === "string" ? after.note : null,
              source: "tools_feedback",
              decisionId: String(after.decision_id),
              commitId,
              createdAt: String(after.created_at),
            });
          }
          await store.updateRuleFeedbackAggregates({
            scope: prepared.scope_key,
            outcome: prepared.parsed.outcome,
            ruleNodeIds: prepared.source_rule_ids,
            commitId,
            updatedAt: appliedAt,
          });
          for (const node of nodePlans) {
            await applyNodePlan({ store, plan: node, commitId });
          }

          const decision = await store.getExecutionDecision({
            scope: prepared.scope_key,
            id: prepared.decision.after.id,
          });
          if (!decision) throw new Error("tool_feedback_decision_read_after_missing");
          return { decision };
        },
        async verify({ commitId }) {
          const verified: CanonicalAuthorityMutationVerificationV2[] = [];
          const decision = await store.getExecutionDecision({
            scope: prepared.scope_key,
            id: prepared.decision.after.id,
          });
          if (!decision) throw new Error("tool_feedback_decision_verify_missing");
          verified.push(verification(
            "lite_memory_execution_decisions",
            { scope: prepared.scope_key, id: prepared.decision.after.id },
            decisionAuthorityRow(decision),
            commitId,
          ));
          for (const feedback of prepared.rule_feedback) {
            const row = await store.getRuleFeedback(prepared.scope_key, feedback.id);
            if (!row) throw new Error(`tool_feedback_row_verify_missing:${feedback.id}`);
            verified.push(verification(
              "lite_memory_rule_feedback",
              { scope: prepared.scope_key, id: feedback.id },
              ruleFeedbackAuthorityRow(row),
              commitId,
            ));
          }
          for (const ruleNodeId of prepared.source_rule_ids) {
            const row = await store.getRuleDef(prepared.scope_key, ruleNodeId);
            if (!row) throw new Error(`tool_feedback_rule_def_verify_missing:${ruleNodeId}`);
            verified.push(verification(
              "lite_memory_rule_defs",
              { scope: prepared.scope_key, rule_node_id: ruleNodeId },
              ruleDefAuthorityRow(row),
              commitId,
            ));
          }
          const nodeStates = await store.nodeStatesByIds(
            prepared.scope_key,
            nodePlans.map((node) => String(node.identity.id)),
          );
          for (const node of nodePlans) {
            const id = String(node.identity.id);
            const row = nodeStates.get(id);
            if (!row) throw new Error(`tool_feedback_node_verify_missing:${id}`);
            verified.push(verification(
              "lite_memory_nodes",
              node.identity,
              existingNodeAuthorityRow(row),
              commitId,
            ));
          }
          return verified;
        },
      };
    },
  });
}
