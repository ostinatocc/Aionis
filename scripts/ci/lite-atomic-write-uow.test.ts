import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import stableStringify from "fast-json-stable-stringify";

import type { EmbeddingProvider } from "../../src/embeddings/types.ts";
import { createLearningKernel, type LearningKernelControlProviders } from "../../src/kernel/learning-kernel.ts";
import { createEvidenceFormPatternLearningControlReviewProvider } from "../../src/memory/learning-control-provider-evidence.ts";
import {
  createLiteExecutionStateStore,
  createLiteExecutionStateStoreFromDatabase,
} from "../../src/execution/state-store.ts";
import {
  createLiteExecutionTreeStore,
  createLiteExecutionTreeStoreFromDatabase,
} from "../../src/execution/tree-store.ts";
import { createExecutionTreeV1 } from "../../src/execution/tree.ts";
import { updateRuleState } from "../../src/memory/rules.ts";
import { selectTools, type DeferredToolsSelectDecision } from "../../src/memory/tools-select.ts";
import { buildAionisMemoryPacket } from "../../src/memory/product-output/memory-packet.ts";
import { createProductGuideService } from "../../src/product/guide-service.ts";
import { createProductMeasureService } from "../../src/product/measure-service.ts";
import { createProductObserveService } from "../../src/product/observe-service.ts";
import { ProductGuideRequest, ProductMeasureRequest } from "../../src/product/product-services.ts";
import { createProductToolFeedbackService } from "../../src/product/tool-feedback-service.ts";
import { createHandoffRouteService } from "../../src/routes/handoff.ts";
import { DEFERRED_PLANNING_TOOL_DECISION } from "../../src/routes/memory-context-runtime.ts";
import { createMemoryWriteRouteService } from "../../src/routes/memory-write.ts";
import { createLiteClaimLedgerStoreFromDatabase } from "../../src/store/lite-claim-ledger-store.ts";
import { createLiteLearningEpisodeLedgerAccess } from "../../src/store/lite-learning-episode-ledger.ts";
import { createLiteRecallStore } from "../../src/store/lite-recall-store.ts";
import {
  createLiteRuntimeDatabase,
  type LiteRuntimeDatabaseFaultInjector,
} from "../../src/store/lite-runtime-database.ts";
import { verifyLiteRuntimeDatabase } from "../../src/store/lite-runtime-data-operations.ts";
import {
  createLiteWriteStoreFromDatabase,
  createLiteWriteStore,
  type LiteWriteAnnSync,
} from "../../src/store/lite-write-store.ts";
import { createLiteSkillCandidateReviewStoreFromDatabase } from "../../src/store/lite-skill-candidate-review-store.ts";
import { createSqliteDatabase } from "../../src/store/sqlite.ts";
import { DeterministicEmbeddingProvider } from "./support/deterministic-embedding.ts";

function atomicEnv() {
  return {
    AIONIS_EDITION: "lite",
    APP_ENV: "test",
    MEMORY_TENANT_ID: "default",
    MEMORY_SCOPE: "default",
    LITE_LOCAL_ACTOR_ID: "local-user",
    MAX_TEXT_LEN: 20_000,
    PII_REDACTION: false,
    ALLOW_CROSS_SCOPE_EDGES: false,
    MEMORY_WRITE_REQUIRE_NODES: false,
    MEMORY_LIFECYCLE_RELATION_HTTP_MODEL_PROVIDER_ENABLED: false,
    WORKFLOW_LEARNING_CONTROL_EVIDENCE_PROMOTE_MEMORY_PROVIDER_ENABLED: false,
    AIONIS_INSPECT_BEFORE_USE_MODE: "off",
    AIONIS_ADMISSION_CANDIDATE_POLICY_MODE: "off",
    AIONIS_ADMISSION_CANDIDATE_POLICY_PROFILE_RULES_JSON: "[]",
    EXECUTION_TREE_DEFAULT_ENABLED: true,
    LITE_INLINE_EMBEDDING_TIMEOUT_MS: 1_000,
  } as any;
}

function openAtomicRuntime(
  dbPath: string,
  faultInjector?: LiteRuntimeDatabaseFaultInjector,
  options: {
    embedder?: EmbeddingProvider | null;
    annSync?: LiteWriteAnnSync | null;
    annProjectionEnabled?: boolean;
    learningControlProviders?: LearningKernelControlProviders;
  } = {},
) {
  const database = createLiteRuntimeDatabase(dbPath, { faultInjector });
  const writeStore = createLiteWriteStoreFromDatabase(database, {
    closeDatabaseOnClose: true,
    annSync: options.annSync ?? null,
    annProjectionEnabled: options.annProjectionEnabled,
  });
  const recallStore = createLiteRecallStore(dbPath);
  const claimStore = createLiteClaimLedgerStoreFromDatabase(database);
  const claimLedgerAccess = claimStore.createClaimLedgerAccess();
  const skillCandidateReviewStore = createLiteSkillCandidateReviewStoreFromDatabase(database);
  const skillCandidateReviewAccess = skillCandidateReviewStore.createSkillCandidateReviewAccess();
  const learningEpisodeLedgerAccess = createLiteLearningEpisodeLedgerAccess(database);
  const executionStateStore = createLiteExecutionStateStoreFromDatabase(database.db, {
    path: database.path,
    transaction: database.transaction,
  });
  const executionTreeStore = createLiteExecutionTreeStoreFromDatabase(database.db, {
    path: database.path,
    transaction: database.transaction,
  });
  const env = atomicEnv();
  const memoryWrite = createMemoryWriteRouteService({
    env,
    embedder: options.embedder ?? null,
    liteWriteStore: writeStore,
    executionStateStore,
    executionTreeStore,
  });
  const handoffStore = createHandoffRouteService({
    env,
    embedder: options.embedder ?? null,
    liteWriteStore: writeStore,
    executionStateStore,
    executionTreeStore,
  });
  const observe = createProductObserveService({
    defaultTenantId: env.MEMORY_TENANT_ID,
    defaultScope: env.MEMORY_SCOPE,
    memoryWrite,
    handoffStore,
    atomicWrite: writeStore,
    claimLedgerAccess,
  });
  const guide = createProductGuideService({
    env,
    liteWriteStore: writeStore,
    executionTreeStore,
    claimLedgerAccess,
    learningEpisodeLedgerAccess,
    memoryWrite,
  });
  const learningKernel = createLearningKernel({
    env,
    embedder: options.embedder ?? null,
    queryEmbedder: options.embedder ?? null,
    liteRecallAccess: recallStore.createRecallAccess(),
    liteWriteStore: writeStore,
    learningControlProviders: options.learningControlProviders,
  });
  const toolFeedback = createProductToolFeedbackService({
    env,
    liteWriteStore: writeStore,
    learningKernel,
    learningEpisodeLedgerAccess,
  } as any);
  const measure = createProductMeasureService({
    defaultTenantId: env.MEMORY_TENANT_ID,
    defaultScope: env.MEMORY_SCOPE,
    skillCandidateReviewAccess,
    runtimeEvidenceStore: writeStore,
    learningEpisodeLedgerAccess,
  });
  return {
    database,
    observe,
    guide,
    measure,
    toolFeedback,
    learningKernel,
    learningEpisodeLedgerAccess,
    memoryWrite,
    handoffStore,
    writeStore,
    claimLedgerAccess,
    learningEpisodeLedgerAccess,
    executionStateStore,
    executionTreeStore,
    async close() {
      try {
        await recallStore.close();
      } finally {
        await executionTreeStore.close();
        await executionStateStore.close();
        await skillCandidateReviewStore.close();
        await claimStore.close();
        await writeStore.close();
      }
    },
  };
}

function combinedObserveInput(operationId: string) {
  const observedAt = "2026-07-12T00:00:00.000Z";
  const stateId = `${operationId}:state`;
  const memoryStateId = `${operationId}:memory-state`;
  const baseState = {
    version: 1 as const,
    scope: "default",
    task_brief: "Prove observe UoW includes execution state and tree",
    current_stage: "review" as const,
    active_role: "review" as const,
    owned_files: [],
    modified_files: [],
    pending_validations: [],
    completed_validations: [],
    last_accepted_hypothesis: null,
    rejected_paths: [],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    reviewer_contract: null,
    resume_anchor: null,
    updated_at: observedAt,
  };
  const tree = createExecutionTreeV1({
    tree_id: `${operationId}:tree`,
    scope: "default",
    task_brief: "Prove observe UoW includes execution state and tree",
    at: observedAt,
  });
  return {
    operation_id: operationId,
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    producer_agent_id: "local-user",
    owner_agent_id: "local-user",
    input_text: "Atomic observe memory",
    auto_embed: false,
    nodes: [{
      client_id: `${operationId}:memory`,
      type: "event",
      title: "Prior atomic persistence workflow",
      text_summary: "The prior legacy atomic persistence workflow used the earlier transaction route.",
      confidence: 0.9,
      slots: {
        atomic_uow: true,
        execution_state_v1: {
          ...baseState,
          state_id: memoryStateId,
        },
      },
    }, {
      client_id: `${operationId}:prior-route`,
      type: "concept",
      title: "Prior legacy atomic persistence route for src/atomic.ts",
      text_summary: "The prior legacy atomic persistence workflow used src/atomic.ts and the earlier transaction route.",
      confidence: 0.9,
      slots: { lifecycle_state: "active", atomic_uow_prior_route: true },
    }],
    handoff: {
      handoff_kind: "task_handoff",
      anchor: `${operationId}:handoff`,
      title: "Atomic handoff",
      summary: "The later atomic persistence workflow for src/atomic.ts supersedes the prior legacy transaction route.",
      handoff_text: "Use the later atomic persistence workflow for src/atomic.ts and replace the prior legacy route.",
      target_files: ["src/atomic.ts"],
      confidence: 0.9,
      salience: 0.9,
      importance: 0.9,
      execution_tree_default_disabled: true,
      execution_state_v1: {
        ...baseState,
        state_id: stateId,
      },
      execution_transitions_v1: [{
        transition_id: `${operationId}:transition`,
        state_id: stateId,
        scope: "default",
        actor_role: "review",
        at: observedAt,
        type: "validation_added",
        validations: ["atomic-uow-check"],
      }],
      execution_tree_v1: tree,
      execution_tree_operations_v1: [{
        operation_id: `${operationId}:tree-operation`,
        tree_id: tree.tree_id,
        scope: tree.scope,
        actor_role: "review",
        at: observedAt,
        type: "grow",
        action: "persist the complete UoW",
        observation: "all mutation families are included",
        title: "Atomic UoW",
        tool_name: null,
        refs: [],
      }],
    },
    claims: [{
      contract_version: "aionis_claim_write_v1",
      client_id: `${operationId}:claim`,
      subject_key: "runtime:atomic-uow",
      predicate: "status",
      value: { status: "committed" },
      value_text: "committed",
      slot_key: "runtime:atomic-uow.status",
      claim_kind: "execution_fact",
      conflict_policy: "multi_value",
      authority: "advisory",
      confidence: 0.9,
      evidence_refs: [`observe://${operationId}`],
    }],
  };
}

function tableCounts(dbPath: string): Record<string, number> {
  const db = createSqliteDatabase(dbPath);
  try {
    const tables = [
      "lite_memory_commits",
      "lite_memory_nodes",
      "lite_claim_ledger_claims",
      "lite_claim_ledger_events",
      "lite_execution_states",
      "lite_execution_state_transitions",
      "lite_execution_trees",
      "lite_execution_tree_operations",
      "lite_product_guide_receipts",
      "lite_learning_episode_events",
      "lite_learning_exposure_items",
      "lite_runtime_write_operations",
    ];
    const counts = Object.fromEntries(tables.map((table) => {
      const row = db.prepare<{ count: number }>(`SELECT COUNT(*) AS count FROM ${table}`).get();
      return [table, Number(row.count)];
    }));
    const handoff = db.prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM lite_memory_nodes
      WHERE type = 'event' AND json_extract(slots_json, '$.summary_kind') = 'handoff'
    `).get();
    const stateRevision = db.prepare<{ revision: number | null }>(
      "SELECT MAX(revision) AS revision FROM lite_execution_states",
    ).get();
    const treeRevision = db.prepare<{ revision: number | null }>(
      "SELECT MAX(revision) AS revision FROM lite_execution_trees",
    ).get();
    const workflowObservedCount = db.prepare<{ observed_count: number | null }>(`
      SELECT MAX(CAST(json_extract(slots_json, '$.execution_native_v1.workflow_promotion.observed_count') AS INTEGER)) AS observed_count
      FROM lite_memory_nodes
      WHERE json_extract(slots_json, '$.execution_native_v1.execution_kind') = 'workflow_candidate'
    `).get();
    const lifecycleRelations = db.prepare<{ count: number }>(`
      SELECT COUNT(*) AS count
      FROM lite_memory_edges
      WHERE type IN ('supersedes', 'contradicts', 'invalidates')
    `).get();
    return {
      ...counts,
      handoff_nodes: Number(handoff.count),
      execution_state_max_revision: Number(stateRevision.revision ?? 0),
      execution_tree_max_revision: Number(treeRevision.revision ?? 0),
      workflow_projection_max_observed_count: Number(workflowObservedCount.observed_count ?? 0),
      same_observe_lifecycle_relation_count: Number(lifecycleRelations.count),
    };
  } finally {
    db.close();
  }
}

type GuideLearningAtomicCounts = Readonly<{
  guide_memory_commits: number;
  guide_memory_nodes: number;
  guide_receipts: number;
  learning_episode_events: number;
  learning_exposure_items: number;
  guide_operation_receipts: number;
}>;

function guideLearningAtomicCounts(
  dbPath: string,
  operationId: string,
): GuideLearningAtomicCounts {
  const db = createSqliteDatabase(dbPath);
  try {
    const count = (sql: string, ...params: unknown[]): number => {
      const row = db.prepare<{ count: number }>(sql).get(...params);
      return Number(row.count);
    };
    const guideNodeWhere = "json_type(slots_json, '$.guide_exposure_v1') = 'object'";
    return {
      guide_memory_commits: count(
        `SELECT COUNT(DISTINCT commit_id) AS count
         FROM lite_memory_nodes
         WHERE ${guideNodeWhere}`,
      ),
      guide_memory_nodes: count(
        `SELECT COUNT(*) AS count
         FROM lite_memory_nodes
         WHERE ${guideNodeWhere}`,
      ),
      guide_receipts: count("SELECT COUNT(*) AS count FROM lite_product_guide_receipts"),
      learning_episode_events: count(
        `SELECT COUNT(*) AS count
         FROM lite_learning_episode_events
         WHERE event_kind = 'exposure_committed' AND operation_id = ?`,
        operationId,
      ),
      learning_exposure_items: count(
        `SELECT COUNT(*) AS count
         FROM lite_learning_exposure_items AS item
         JOIN lite_learning_episode_events AS event
           ON event.tenant_id = item.tenant_id
          AND event.scope = item.scope
          AND event.event_id = item.event_id
         WHERE event.event_kind = 'exposure_committed' AND event.operation_id = ?`,
        operationId,
      ),
      guide_operation_receipts: count(
        `SELECT COUNT(*) AS count
         FROM lite_runtime_write_operations
         WHERE operation_kind = 'product_guide_v1' AND operation_id = ?`,
        operationId,
      ),
    };
  } finally {
    db.close();
  }
}

const ZERO_GUIDE_LEARNING_ATOMIC_COUNTS: GuideLearningAtomicCounts = {
  guide_memory_commits: 0,
  guide_memory_nodes: 0,
  guide_receipts: 0,
  learning_episode_events: 0,
  learning_exposure_items: 0,
  guide_operation_receipts: 0,
};

function protectedManualMeasureInput(operationId: string, label = "manual-measure-atomic") {
  return ProductMeasureRequest.parse({
    operation_id: operationId,
    tenant_id: "default",
    scope: "default",
    task: {
      task_id: `task:${label}`,
      run_id: `run:${label}`,
      task_signature: label,
      task_family: "manual_measurement_regression",
    },
    baseline: {
      label: `${label}:baseline`,
      continuity: {
        repeatedDiscoverySteps: 4,
        continuityGuidanceCorrect: false,
        recoveredStateFacts: 0,
        expectedStateFacts: 1,
        recoveredStateApplicable: true,
        verifiedFactsCarried: 0,
        verifiedFactsExpected: 1,
        verifiedFactsApplicable: true,
      },
      learning: {
        workflowReused: false,
        stableWorkflowReused: false,
        provisionalMemoriesWritten: 0,
        trustedPromotions: 0,
        weakEvidencePromoted: 0,
        counterEvidenceDemotions: 0,
      },
      forgetting: {
        contextItems: 1,
        usefulContextItems: 0,
        staleMemorySurfaced: 0,
        staleMemorySuppressed: 0,
        archivedMemoryRehydratedOnDemand: 0,
        unnecessaryRehydrations: 0,
        staleMemoryControlApplicable: false,
        rehydrationApplicable: false,
      },
      learning_control: {
        weakEvidenceBlocked: 0,
        authorityRequiresEvidence: true,
        blockedAuthorityVisible: true,
        unverifiedAuthorityApplied: 0,
      },
    },
    aionis: {
      label: `${label}:aionis`,
      continuity: {
        repeatedDiscoverySteps: 0,
        continuityGuidanceCorrect: true,
        recoveredStateFacts: 1,
        expectedStateFacts: 1,
        recoveredStateApplicable: true,
        verifiedFactsCarried: 1,
        verifiedFactsExpected: 1,
        verifiedFactsApplicable: true,
      },
      learning: {
        workflowReused: true,
        stableWorkflowReused: true,
        provisionalMemoriesWritten: 0,
        trustedPromotions: 1,
        weakEvidencePromoted: 0,
        counterEvidenceDemotions: 0,
      },
      forgetting: {
        contextItems: 1,
        usefulContextItems: 1,
        staleMemorySurfaced: 0,
        staleMemorySuppressed: 0,
        archivedMemoryRehydratedOnDemand: 0,
        unnecessaryRehydrations: 0,
        staleMemoryControlApplicable: false,
        rehydrationApplicable: false,
      },
      learning_control: {
        weakEvidenceBlocked: 0,
        authorityRequiresEvidence: true,
        blockedAuthorityVisible: true,
        unverifiedAuthorityApplied: 0,
      },
    },
    comparison: {
      mode: "baseline_vs_aionis",
      sufficient_evidence: true,
    },
    evidence_ids: ["caller-claimed-manual-evidence"],
  });
}

function measurementAtomicCounts(dbPath: string, operationId: string) {
  const db = createSqliteDatabase(dbPath);
  try {
    const count = (sql: string, ...params: unknown[]): number => Number(
      db.prepare<{ count: number }>(sql).get(...params).count,
    );
    const measurement = db.prepare<{
      measurement_id: string;
      baseline_episode_id: string | null;
      after_episode_id: string | null;
      record_sha256: string | null;
      created_at: string;
    }>(
      `SELECT measurement_id, baseline_episode_id, after_episode_id, record_sha256, created_at
       FROM lite_product_measurements LIMIT 1`,
    ).get() ?? null;
    return {
      measurement_count: count("SELECT COUNT(*) AS count FROM lite_product_measurements"),
      effect_event_count: count(
        "SELECT COUNT(*) AS count FROM lite_learning_episode_events WHERE event_kind = 'effect_measured'",
      ),
      operation_receipt_count: count(
        `SELECT COUNT(*) AS count FROM lite_runtime_write_operations
         WHERE operation_kind = 'product_measure_v1' AND operation_id = ?`,
        operationId,
      ),
      operation_authority_count: count(
        `SELECT COUNT(*) AS count FROM lite_runtime_write_operations
         WHERE operation_kind = 'product_measure_receipt_authority_v1' AND operation_id = ?`,
        operationId,
      ),
      measurement,
    };
  } finally {
    db.close();
  }
}

function atomicToolFeedbackContext(): Record<string, unknown> {
  return {
    agent_id: "local-user",
    task_kind: "atomic_tool_feedback",
    task_family: "atomic_tool_feedback",
    task_signature: "atomic-tool-feedback-uow",
    error_signature: "atomic-tool-feedback-partial-commit",
    workflow_signature: "workflow:atomic-tool-feedback-uow",
    contract_trust: "advisory",
    goal: "Persist one complete tool-learning feedback unit or none of it.",
    target_files: ["src/product/tool-feedback-service.ts"],
    next_action: "Keep tool feedback, episode attribution, and replay receipt atomic.",
    workflow_steps: [
      "Validate the protected guide decision.",
      "Persist the tool-learning unit of work.",
      "Replay the exact stored product result.",
    ],
    pattern_hints: ["atomic_tool_feedback"],
  };
}

async function seedAtomicToolFeedbackRules(
  runtime: ReturnType<typeof openAtomicRuntime>,
): Promise<string[]> {
  const seeded = await runtime.memoryWrite.commit({
    tenant_id: "default",
    scope: "default",
    actor: "local-user",
    input_text: "Seed two real rules so tool feedback writes aggregates, pattern, policy, and review state.",
    auto_embed: false,
    memory_lane: "shared",
    nodes: [0, 1].map((index) => ({
      client_id: `atomic-tool-feedback-rule-${index + 1}`,
      type: "rule",
      tier: "warm",
      title: `Atomic tool feedback rule ${index + 1}`,
      text_summary: "Prefer read for the atomic tool feedback integration context.",
      slots: {
        if: { task_kind: { $eq: "atomic_tool_feedback" } },
        then: { tool: { prefer: ["read"] } },
        exceptions: [],
        rule_scope: "global",
      },
    })),
    edges: [],
  });
  const ruleNodeIds = seeded.out.nodes.map((node) => node.id);
  assert.equal(ruleNodeIds.length, 2);
  await runtime.writeStore.withTx(async () => {
    for (const [index, ruleNodeId] of ruleNodeIds.entries()) {
      await updateRuleState({
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        rule_node_id: ruleNodeId,
        state: "active",
        input_text: `Activate atomic tool feedback rule ${index + 1}.`,
      }, "default", "default", { liteWriteStore: runtime.writeStore });
    }
  });
  return ruleNodeIds;
}

async function createAtomicProtectedToolGuide(
  runtime: ReturnType<typeof openAtomicRuntime>,
  args: { operationId: string; runId: string },
): Promise<Record<string, any>> {
  const context = atomicToolFeedbackContext();
  let deferredDecision: DeferredToolsSelectDecision | null = null;
  const tools = await selectTools({
    tenant_id: "default",
    scope: "default",
    run_id: args.runId,
    context,
    candidates: ["read", "bash"],
    include_shadow: false,
    rules_limit: 20,
    strict: true,
    reorder_candidates: false,
  }, "default", "default", {
    liteWriteStore: runtime.writeStore,
    persistDecision: false,
    onDecisionPrepared(decision) {
      deferredDecision = decision;
    },
  });
  assert.ok(deferredDecision);
  const packet = buildAionisMemoryPacket({
    tenant_id: "default",
    scope: "default",
    query: { source: "text", intent: "atomic protected tool feedback" },
    nodes: [],
  });
  const planningContext = {
    tenant_id: "default",
    scope: "default",
    recall: { aionis_memory_packet: packet },
    tools,
    [DEFERRED_PLANNING_TOOL_DECISION]: deferredDecision,
  };
  const result = await runtime.guide.execute(ProductGuideRequest.parse({
    operation_id: args.operationId,
    tenant_id: "default",
    scope: "default",
    run_id: args.runId,
    consumer_agent_id: "local-user",
    query_text: "Choose the safe tool for one atomic feedback transaction.",
    context,
    tool_candidates: ["read", "bash"],
    include_packets: true,
  }), {
    principal: null,
    planningContext: async () => planningContext,
    applyIdentity: (input) => input,
  });
  assert.equal(result.ok, true, JSON.stringify(result));
  const guide = result.body as Record<string, any>;
  assert.ok(guide.tool_selection);
  assert.equal(guide.tool_selection.run_id, args.runId);
  return guide;
}

type AtomicToolFeedbackSnapshot = Readonly<{
  commit_count: number;
  rule_feedback_rows: string;
  rule_aggregate_rows: string;
  decision_row: string;
  pattern_rows: string;
  policy_rows: string;
  feedback_event_rows: string;
  feedback_attribution_rows: string;
  write_operation_rows: string;
  projection_job_rows: string;
}>;

function atomicToolFeedbackSnapshot(args: {
  dbPath: string;
  ruleNodeIds: readonly string[];
  decisionId: string;
  operationId: string;
}): AtomicToolFeedbackSnapshot {
  const db = createSqliteDatabase(args.dbPath);
  try {
    const rows = (sql: string, ...params: unknown[]): string => stableStringify(
      db.prepare<Record<string, unknown>>(sql).all(...params),
    );
    const count = Number((db.prepare<{ count: number }>(
      "SELECT COUNT(*) AS count FROM lite_memory_commits",
    ).get()).count);
    const rulePlaceholders = args.ruleNodeIds.map(() => "?").join(", ");
    return {
      commit_count: count,
      rule_feedback_rows: rows(
        `SELECT scope, rule_node_id, run_id, outcome, source, decision_id, commit_id
         FROM lite_memory_rule_feedback
         WHERE decision_id = ?
         ORDER BY rule_node_id, id`,
        args.decisionId,
      ),
      rule_aggregate_rows: rows(
        `SELECT rule_node_id, positive_count, negative_count, commit_id, updated_at
         FROM lite_memory_rule_defs
         WHERE rule_node_id IN (${rulePlaceholders})
         ORDER BY rule_node_id`,
        ...args.ruleNodeIds,
      ),
      decision_row: rows(
        `SELECT id, scope, decision_kind, run_id, selected_tool, candidates_json,
                context_sha256, policy_sha256, source_rule_ids_json, metadata_json,
                commit_id, created_at
         FROM lite_memory_execution_decisions
         WHERE id = ?`,
        args.decisionId,
      ),
      pattern_rows: rows(
        `SELECT id, client_id, commit_id, slots_json, embedding_status,
                embedding_model, embedding_last_error
         FROM lite_memory_nodes
         WHERE json_extract(slots_json, '$.summary_kind') = 'pattern_anchor'
         ORDER BY id`,
      ),
      policy_rows: rows(
        `SELECT id, client_id, commit_id, slots_json, embedding_status,
                embedding_model, embedding_last_error
         FROM lite_memory_nodes
         WHERE json_extract(slots_json, '$.summary_kind') = 'policy_memory'
         ORDER BY id`,
      ),
      feedback_event_rows: rows(
        `SELECT event_id, episode_id, episode_sequence, event_kind, source_kind,
                source_id, source_sha256, event_sha256, payload_sha256, payload_json,
                item_set_sha256, source_commit_id, operation_id, run_id,
                collection_class, promotion_eligible, recorded_at
         FROM lite_learning_episode_events
         WHERE event_kind = 'feedback_attributed' AND operation_id = ?
         ORDER BY event_id`,
        args.operationId,
      ),
      feedback_attribution_rows: rows(
        `SELECT attribution.*
         FROM lite_learning_feedback_attributions AS attribution
         JOIN lite_learning_episode_events AS event
           ON event.tenant_id = attribution.tenant_id
          AND event.scope = attribution.scope
          AND event.event_id = attribution.event_id
         WHERE event.operation_id = ?
         ORDER BY attribution.subject_kind, attribution.subject_id`,
        args.operationId,
      ),
      write_operation_rows: rows(
        `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
                receipt_json, commit_id, created_at
         FROM lite_runtime_write_operations
         WHERE operation_id = ?
         ORDER BY operation_kind`,
        args.operationId,
      ),
      projection_job_rows: rows(
        `SELECT scope, node_id, job_kind, source_commit_id, status, generation,
                attempt_count, available_at, lease_owner, lease_expires_at,
                last_error, created_at, updated_at
         FROM lite_memory_projection_jobs
         ORDER BY scope, node_id, job_kind`,
      ),
    };
  } finally {
    db.close();
  }
}

test("a downstream claim conflict rolls back memory, handoff, execution, claims, and receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-atomic-domain-fault-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  try {
    const input = combinedObserveInput("observe-domain-fault");
    input.claims.push({
      ...input.claims[0],
      value: { status: "different" },
      value_text: "different",
    });
    const result = await runtime.observe.execute(input as any, { principal: null });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal((result.body as any).error, "claim_client_id_conflict");
  } finally {
    await runtime.close();
  }

  const counts = tableCounts(dbPath);
  for (const [table, count] of Object.entries(counts)) {
    assert.equal(count, 0, `${table} must remain empty after rollback and reopen`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a before-commit SQLite fault leaves no earlier mutation visible after reopen", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-atomic-sqlite-fault-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  let injected = false;
  const runtime = openAtomicRuntime(dbPath, (phase) => {
    if (phase === "before_commit" && !injected) {
      injected = true;
      throw new Error("injected before-commit fault");
    }
  });
  try {
    const result = await runtime.observe.execute(combinedObserveInput("observe-sqlite-fault") as any, { principal: null });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 500);
    assert.equal(injected, true);
  } finally {
    await runtime.close();
  }

  const counts = tableCounts(dbPath);
  for (const [table, count] of Object.entries(counts)) {
    assert.equal(count, 0, `${table} must remain empty after injected fault and reopen`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test("protected manual measure replays exactly without creating effect authority", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-manual-measure-atomic-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const operationId = "measure-manual-atomic-1";
  const runtime = openAtomicRuntime(dbPath);
  let first: Awaited<ReturnType<typeof runtime.measure.execute>>;
  try {
    const input = protectedManualMeasureInput(operationId);
    first = await runtime.measure.execute(input, { actorId: "local-user" });
    assert.equal(first.ok, true);
    assert.equal(first.statusCode, 200);
    assert.equal((first.body as any).operation_id, operationId);
    assert.equal((first.body as any).evidence_assessment.provenance, "manual_unverified");
    assert.equal((first.body as any).evidence_assessment.eligible_for_skill_export, false);

    const replay = await runtime.measure.execute(input, { actorId: "local-user" });
    assert.deepEqual(replay, first, "a protected retry must return the exact stored product result");

    const changed = protectedManualMeasureInput(operationId, "manual-measure-changed-request");
    const conflict = await runtime.measure.execute(changed, { actorId: "local-user" });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.body as any).error, "measure_operation_id_conflict");

    const primary = runtime.database.db.prepare(
      `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
              receipt_json, commit_id, created_at
       FROM lite_runtime_write_operations
       WHERE operation_kind = 'product_measure_v1' AND operation_id = ?`,
    ).get(operationId) as {
      tenant_id: string; scope: string; operation_kind: string; operation_id: string;
      request_sha256: string; receipt_json: string; commit_id: string | null; created_at: string;
    };
    const tamperedReceipt = JSON.parse(primary.receipt_json) as {
      body: { source_map: { internal_surfaces_used: string[] } };
    };
    tamperedReceipt.body.source_map.internal_surfaces_used.push("tampered_manual_surface");
    runtime.database.db.prepare(
      `UPDATE lite_runtime_write_operations SET receipt_json = ?
       WHERE operation_kind = 'product_measure_v1' AND operation_id = ?`,
    ).run(stableStringify(tamperedReceipt), operationId);
    const tamperedReplay = await runtime.measure.execute(input, { actorId: "local-user" });
    assert.equal(tamperedReplay.ok, false);
    assert.equal(tamperedReplay.statusCode, 500);
    assert.equal((tamperedReplay.body as any).error, "protected_measure_receipt_invalid");
    await assert.rejects(
      runtime.learningEpisodeLedgerAccess.verifyIntegrity(),
      /product_measure_receipt_authority/,
    );
    runtime.database.db.prepare(
      `UPDATE lite_runtime_write_operations SET receipt_json = ?
       WHERE operation_kind = 'product_measure_v1' AND operation_id = ?`,
    ).run(primary.receipt_json, operationId);
    await runtime.learningEpisodeLedgerAccess.verifyIntegrity();

    const root = runtime.database.db.prepare(
      `SELECT tenant_id, scope, operation_kind, operation_id, request_sha256,
              receipt_json, commit_id, created_at
       FROM lite_runtime_write_operations
       WHERE operation_kind = 'product_measure_receipt_authority_v1' AND operation_id = ?`,
    ).get(operationId) as Record<string, string | null>;
    runtime.database.db.prepare(
      `DELETE FROM lite_runtime_write_operations
       WHERE operation_kind = 'product_measure_receipt_authority_v1' AND operation_id = ?`,
    ).run(operationId);
    const missingRootReplay = await runtime.measure.execute(input, { actorId: "local-user" });
    assert.equal(missingRootReplay.ok, false);
    assert.equal(missingRootReplay.statusCode, 500);
    await assert.rejects(
      runtime.learningEpisodeLedgerAccess.verifyIntegrity(),
      /product_measure_receipt_authority/,
    );
    runtime.database.db.prepare(
      `INSERT INTO lite_runtime_write_operations
        (tenant_id, scope, operation_kind, operation_id, request_sha256,
         receipt_json, commit_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      root.tenant_id,
      root.scope,
      root.operation_kind,
      root.operation_id,
      root.request_sha256,
      root.receipt_json,
      root.commit_id,
      root.created_at,
    );
    await runtime.learningEpisodeLedgerAccess.verifyIntegrity();

    runtime.database.db.prepare(
      `DELETE FROM lite_runtime_write_operations
       WHERE operation_id = ? AND operation_kind IN (
         'product_measure_v1', 'product_measure_receipt_authority_v1'
       )`,
    ).run(operationId);
    const pairedDeletionReplay = await runtime.measure.execute(input, { actorId: "local-user" });
    assert.equal(pairedDeletionReplay.ok, false);
    assert.equal(pairedDeletionReplay.statusCode, 500);
    assert.equal((pairedDeletionReplay.body as any).error, "protected_measure_receipt_invalid");
    const pairedDeletionConflict = await runtime.measure.execute(changed, { actorId: "local-user" });
    assert.equal(pairedDeletionConflict.ok, false);
    assert.equal(pairedDeletionConflict.statusCode, 409);
    assert.equal((pairedDeletionConflict.body as any).error, "measure_operation_id_conflict");
    assert.equal(Number((runtime.database.db.prepare(
      "SELECT COUNT(*) AS count FROM lite_product_measurements",
    ).get() as { count: number }).count), 1);
    await assert.rejects(
      runtime.learningEpisodeLedgerAccess.verifyIntegrity(),
      /product_measure_receipt_authority/,
    );
    const restoreOperation = runtime.database.db.prepare(
      `INSERT INTO lite_runtime_write_operations
        (tenant_id, scope, operation_kind, operation_id, request_sha256,
         receipt_json, commit_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of [primary, root]) {
      restoreOperation.run(
        row.tenant_id,
        row.scope,
        row.operation_kind,
        row.operation_id,
        row.request_sha256,
        row.receipt_json,
        row.commit_id,
        row.created_at,
      );
    }
    await runtime.learningEpisodeLedgerAccess.verifyIntegrity();
  } finally {
    await runtime.close();
  }

  const snapshot = measurementAtomicCounts(dbPath, operationId);
  assert.equal(snapshot.measurement_count, 1);
  assert.equal(snapshot.operation_receipt_count, 1);
  assert.equal(snapshot.operation_authority_count, 1);
  assert.equal(snapshot.effect_event_count, 0);
  assert.ok(snapshot.measurement);
  assert.equal(snapshot.measurement.baseline_episode_id, null);
  assert.equal(snapshot.measurement.after_episode_id, null);
  assert.match(snapshot.measurement.record_sha256 ?? "", /^[0-9a-f]{64}$/u);
  const tamperDb = createSqliteDatabase(dbPath);
  try {
    tamperDb.prepare(
      "UPDATE lite_product_measurements SET created_at = ? WHERE measurement_id = ?",
    ).run("2000-01-01T00:00:00.000Z", snapshot.measurement.measurement_id);
  } finally {
    tamperDb.close();
  }
  const tamperedVerification = await verifyLiteRuntimeDatabase(dbPath);
  assert.equal(tamperedVerification.ok, false);
  assert.equal(tamperedVerification.integrity_findings.learning_episode_ledger_invalid, 1);
  const restoreDb = createSqliteDatabase(dbPath);
  try {
    restoreDb.prepare(
      "UPDATE lite_product_measurements SET created_at = ? WHERE measurement_id = ?",
    ).run(snapshot.measurement.created_at, snapshot.measurement.measurement_id);
  } finally {
    restoreDb.close();
  }
  assert.equal((await verifyLiteRuntimeDatabase(dbPath)).ok, true);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a before-commit fault rolls back manual measurement and replay receipt together", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-manual-measure-fault-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const operationId = "measure-manual-fault-1";
  let injected = false;
  const runtime = openAtomicRuntime(dbPath, (phase) => {
    if (phase === "before_commit" && !injected) {
      injected = true;
      throw new Error("injected manual measure before-commit fault");
    }
  });
  try {
    const failed = await runtime.measure.execute(
      protectedManualMeasureInput(operationId),
      { actorId: "local-user" },
    );
    assert.equal(injected, true);
    assert.equal(failed.ok, false);
    assert.equal(failed.statusCode, 500);
  } finally {
    await runtime.close();
  }

  const snapshot = measurementAtomicCounts(dbPath, operationId);
  assert.equal(snapshot.measurement_count, 0);
  assert.equal(snapshot.operation_receipt_count, 0);
  assert.equal(snapshot.operation_authority_count, 0);
  assert.equal(snapshot.effect_event_count, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("a receipt-authority root insert fault rolls back the complete protected measurement", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-manual-measure-root-fault-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const operationId = "measure-manual-root-fault-1";
  const runtime = openAtomicRuntime(dbPath);
  try {
    runtime.database.db.exec(`
      CREATE TRIGGER reject_product_measure_receipt_authority
      BEFORE INSERT ON lite_runtime_write_operations
      WHEN NEW.operation_kind = 'product_measure_receipt_authority_v1'
      BEGIN
        SELECT RAISE(ABORT, 'injected product measure receipt authority failure');
      END;
    `);
    const failed = await runtime.measure.execute(
      protectedManualMeasureInput(operationId),
      { actorId: "local-user" },
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.statusCode, 500);
  } finally {
    await runtime.close();
  }
  const snapshot = measurementAtomicCounts(dbPath, operationId);
  assert.equal(snapshot.measurement_count, 0);
  assert.equal(snapshot.operation_receipt_count, 0);
  assert.equal(snapshot.operation_authority_count, 0);
  assert.equal(snapshot.effect_event_count, 0);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("guide learning exposure rows commit atomically with memory and operation receipts", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-guide-learning-atomic-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const operationId = "guide-learning-atomic-1";
  let seededMemoryId = "";
  try {
    const seedRuntime = openAtomicRuntime(dbPath);
    try {
      const seeded = await seedRuntime.memoryWrite.commit({
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        input_text: "Seed one real prior memory for atomic guide learning evidence.",
        auto_embed: false,
        nodes: [{
          client_id: "guide-learning-atomic-prior-memory",
          type: "concept",
          tier: "warm",
          memory_lane: "shared",
          producer_agent_id: "local-user",
          owner_agent_id: "local-user",
          title: "Prior supported atomic guide memory",
          text_summary: "The guide learning unit of work must preserve this supported prior state.",
          confidence: 0.95,
          salience: 0.9,
          slots: { positive_attributed_use_count: 2 },
        }],
        edges: [],
      });
      const seededNode = seeded.out.nodes[0];
      assert.ok(seededNode);
      seededMemoryId = seededNode.id;
    } finally {
      await seedRuntime.close();
    }

    const memoryPacket = buildAionisMemoryPacket({
      tenant_id: "default",
      scope: "default",
      query: {
        source: "text",
        intent: "commit one atomic learning exposure",
      },
      nodes: [{
        id: seededMemoryId,
        type: "concept",
        tier: "warm",
        title: "Prior supported atomic guide memory",
        text_summary: "The guide learning unit of work must preserve this supported prior state.",
        slots: { positive_attributed_use_count: 2 },
        confidence: 0.95,
        salience: 0.9,
        created_at: "2026-07-14T00:00:00.000Z",
      }],
    });
    const guideInput = ProductGuideRequest.parse({
      operation_id: operationId,
      tenant_id: "default",
      scope: "default",
      run_id: "run-guide-learning-atomic-1",
      consumer_agent_id: "local-user",
      query_text: "Persist the protected guide response and its learning exposure atomically.",
      context: {
        task_family: "atomic_learning_uow",
        task_signature: "atomic-learning-uow-guide",
        repository_signature: "aionis-runtime-focused",
      },
    });
    const executeGuide = async (runtime: ReturnType<typeof openAtomicRuntime>) =>
      await runtime.guide.execute(guideInput, {
        principal: null,
        planningContext: async () => ({
          tenant_id: "default",
          scope: "default",
          recall: { aionis_memory_packet: memoryPacket },
        }),
        applyIdentity: (input) => input,
      });

    let injected = false;
    const faultRuntime = openAtomicRuntime(dbPath, (phase) => {
      if (phase === "before_commit" && !injected) {
        injected = true;
        throw new Error("injected guide learning before-commit fault");
      }
    });
    try {
      const failed = await executeGuide(faultRuntime);
      assert.equal(failed.ok, false);
      assert.equal(failed.statusCode, 500);
      assert.equal(injected, true);
    } finally {
      await faultRuntime.close();
    }
    assert.deepEqual(
      guideLearningAtomicCounts(dbPath, operationId),
      ZERO_GUIDE_LEARNING_ATOMIC_COUNTS,
      "the injected guide transaction must leave no guide, learning, or operation mutation",
    );

    let successBody: Record<string, unknown> | null = null;
    const healthyRuntime = openAtomicRuntime(dbPath);
    try {
      const succeeded = await executeGuide(healthyRuntime);
      assert.equal(succeeded.ok, true);
      assert.equal(succeeded.statusCode, 200);
      successBody = succeeded.body as Record<string, unknown>;
    } finally {
      await healthyRuntime.close();
    }

    assert.deepEqual(guideLearningAtomicCounts(dbPath, operationId), {
      guide_memory_commits: 1,
      guide_memory_nodes: 1,
      guide_receipts: 1,
      learning_episode_events: 1,
      learning_exposure_items: 1,
      guide_operation_receipts: 1,
    });

    const db = createSqliteDatabase(dbPath);
    try {
      const linkage = db.prepare<{
        guide_trace_id: string;
        guide_commit_id: string;
        operation_commit_id: string;
        episode_commit_id: string;
        operation_id: string;
        projection_complete: number;
        promotion_eligible: number;
        memory_id: string;
        prior_supported_use_count: number;
        learning_track: string;
        track_reason: string;
      }>(`
        SELECT guide.guide_trace_id,
               guide.commit_id AS guide_commit_id,
               operation.commit_id AS operation_commit_id,
               event.source_commit_id AS episode_commit_id,
               event.operation_id,
               event.projection_complete,
               event.promotion_eligible,
               item.memory_id,
               item.prior_supported_use_count,
               item.learning_track,
               item.track_reason
        FROM lite_runtime_write_operations AS operation
        JOIN lite_product_guide_receipts AS guide
          ON guide.tenant_id = operation.tenant_id
         AND guide.scope = operation.scope
         AND guide.commit_id = operation.commit_id
        JOIN lite_learning_episode_events AS event
          ON event.tenant_id = guide.tenant_id
         AND event.scope = guide.scope
         AND event.source_kind = 'guide_receipt'
         AND event.source_id = guide.guide_trace_id
        JOIN lite_learning_exposure_items AS item
          ON item.tenant_id = event.tenant_id
         AND item.scope = event.scope
         AND item.event_id = event.event_id
        WHERE operation.operation_kind = 'product_guide_v1'
          AND operation.operation_id = ?
      `).get(operationId);
      assert.ok(linkage);
      assert.equal(linkage.guide_trace_id, successBody?.guide_trace_id);
      assert.equal(linkage.guide_commit_id, linkage.operation_commit_id);
      assert.equal(linkage.guide_commit_id, linkage.episode_commit_id);
      assert.equal(linkage.operation_id, operationId);
      assert.equal(linkage.projection_complete, 1);
      assert.equal(linkage.promotion_eligible, 0);
      assert.equal(linkage.memory_id, seededMemoryId);
      assert.equal(linkage.prior_supported_use_count, 2);
      assert.equal(linkage.learning_track, "exploit");
      assert.equal(linkage.track_reason, "prior_supported");
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a before-commit tool feedback fault leaves no partial learning, episode, receipt, or projection state", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-tool-feedback-atomic-fault-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const guideOperationId = "guide-tool-feedback-atomic-fault-1";
  const feedbackOperationId = "feedback-tool-feedback-atomic-fault-1";
  const runId = "run-tool-feedback-atomic-fault-1";
  let ruleNodeIds: string[] = [];
  let guide: Record<string, any> | null = null;
  try {
    const seedRuntime = openAtomicRuntime(dbPath, undefined, {
      embedder: DeterministicEmbeddingProvider,
      annProjectionEnabled: true,
    });
    try {
      ruleNodeIds = await seedAtomicToolFeedbackRules(seedRuntime);
      guide = await createAtomicProtectedToolGuide(seedRuntime, {
        operationId: guideOperationId,
        runId,
      });
      assert.deepEqual(
        [...guide.tool_selection.source_rule_ids].sort(),
        [...ruleNodeIds].sort(),
      );
    } finally {
      await seedRuntime.close();
    }
    assert.ok(guide);
    const decisionId = String(guide.tool_selection.decision_id);
    const feedbackInput = {
      feedback_kind: "tool_selection",
      operation_id: feedbackOperationId,
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      consumer_agent_id: "local-user",
      guide_trace_id: guide.guide_trace_id,
      decision_id: decisionId,
      run_id: runId,
      selected_tool: guide.tool_selection.selected_tool,
      candidates: guide.tool_selection.candidates,
      outcome: "positive",
      context: atomicToolFeedbackContext(),
      include_shadow: false,
      rules_limit: 20,
      target: "tool",
      note: "The selected tool completed the protected atomic feedback workflow.",
      input_text: "The selected tool completed the protected atomic feedback workflow.",
    };
    const baseline = atomicToolFeedbackSnapshot({
      dbPath,
      ruleNodeIds,
      decisionId,
      operationId: feedbackOperationId,
    });

    let activeReviewTransaction: ReturnType<typeof openAtomicRuntime>["database"]["transaction"] | null = null;
    let reviewCalls = 0;
    const evidenceReviewProvider = createEvidenceFormPatternLearningControlReviewProvider({
      confidence: 0.89,
      reason: "Two independent rules support one durable atomic tool feedback pattern.",
    });
    const outsideTransactionLearningControlProviders: LearningKernelControlProviders = {
      toolsFeedback: {
        form_pattern: {
          async resolveReviewResult(args) {
            assert.ok(activeReviewTransaction, "the Runtime transaction runner must be available before review");
            assert.equal(
              activeReviewTransaction.inTransaction(),
              false,
              "tool feedback review must complete before the atomic SQLite transaction begins",
            );
            reviewCalls += 1;
            return await evidenceReviewProvider.resolveReviewResult(args);
          },
        },
      },
    };

    let injected = false;
    const faultPhases: string[] = [];
    const faultRuntime = openAtomicRuntime(dbPath, (phase) => {
      faultPhases.push(phase);
      if (phase === "before_commit" && !injected) {
        injected = true;
        throw new Error("injected tool feedback before-commit fault");
      }
    }, {
      embedder: DeterministicEmbeddingProvider,
      annProjectionEnabled: true,
      learningControlProviders: outsideTransactionLearningControlProviders,
    });
    activeReviewTransaction = faultRuntime.database.transaction;
    let kernelFailure: { method: string; error: unknown } | null = null;
    const faultKernel = faultRuntime.learningKernel as any;
    for (const method of [
      "prepareToolSelectionFeedback",
      "persistToolSelectionFeedback",
      "readToolRun",
      "finalizeToolSelectionFeedback",
    ]) {
      const realMethod = faultKernel[method].bind(faultKernel);
      faultKernel[method] = async (...args: unknown[]) => {
        try {
          return await realMethod(...args);
        } catch (error) {
          kernelFailure = { method, error };
          throw error;
        }
      };
    }
    let ledgerFailure: { method: string; error: unknown } | null = null;
    const faultLedger = faultRuntime.learningEpisodeLedgerAccess as any;
    for (const method of ["resolveFeedbackSource", "appendEpisodeEvent"]) {
      const realMethod = faultLedger[method].bind(faultLedger);
      faultLedger[method] = async (...args: unknown[]) => {
        try {
          return await realMethod(...args);
        } catch (error) {
          ledgerFailure = { method, error };
          throw error;
        }
      };
    }
    let failed: Awaited<ReturnType<typeof faultRuntime.toolFeedback.execute>>;
    try {
      failed = await faultRuntime.toolFeedback.execute(feedbackInput as any);
    } finally {
      await faultRuntime.close();
    }
    const afterFault = atomicToolFeedbackSnapshot({
      dbPath,
      ruleNodeIds,
      decisionId,
      operationId: feedbackOperationId,
    });
    assert.equal(
      injected,
      true,
      `tool feedback must reach before_commit: ${JSON.stringify({
        failed,
        faultPhases,
        kernelFailure: kernelFailure
          ? { method: kernelFailure.method, error: String(kernelFailure.error) }
          : null,
        ledgerFailure: ledgerFailure
          ? { method: ledgerFailure.method, error: String(ledgerFailure.error) }
          : null,
      })}`,
    );
    assert.equal(failed.ok, false);
    assert.equal(failed.statusCode, 500);
    assert.deepEqual(
      afterFault,
      baseline,
      "the failed tool feedback transaction must not leak any learning or projection prefix",
    );

    let healthyTransaction: ReturnType<typeof openAtomicRuntime>["database"]["transaction"] | null = null;
    let embeddingCalls = 0;
    const outsideTransactionEmbedder: EmbeddingProvider = {
      ...DeterministicEmbeddingProvider,
      name: "deterministic:atomic-tool-feedback",
      async embed(texts) {
        assert.ok(healthyTransaction, "the Runtime transaction runner must be available before embedding");
        assert.equal(
          healthyTransaction.inTransaction(),
          false,
          "tool feedback embedding must complete before the atomic SQLite transaction begins",
        );
        embeddingCalls += 1;
        return DeterministicEmbeddingProvider.embed(texts);
      },
    };
    const healthyRuntime = openAtomicRuntime(dbPath, undefined, {
      embedder: outsideTransactionEmbedder,
      annProjectionEnabled: true,
      learningControlProviders: outsideTransactionLearningControlProviders,
    });
    healthyTransaction = healthyRuntime.database.transaction;
    activeReviewTransaction = healthyRuntime.database.transaction;
    let succeeded: Awaited<ReturnType<typeof healthyRuntime.toolFeedback.execute>>;
    try {
      succeeded = await healthyRuntime.toolFeedback.execute(feedbackInput as any);
      assert.equal(succeeded.ok, true, JSON.stringify(succeeded));
      assert.equal(succeeded.statusCode, 200);
      const body = succeeded.body as Record<string, any>;
      assert.equal(body.operation_id, feedbackOperationId);
      assert.equal(body.feedback_result.decision_id, decisionId);
      assert.equal(body.feedback_result.updated_rules, 2);
      assert.ok(body.feedback_result.pattern_anchor);
      assert.ok(body.feedback_result.policy_memory);
      assert.equal(body.run_lifecycle.lifecycle.status, "feedback_linked");
      assert.equal(body.run_lifecycle.feedback.total, 2);
      assert.ok(embeddingCalls > 0, "the healthy path must exercise real embedding preparation");
      assert.ok(reviewCalls >= 2, "fault and healthy paths must exercise real evidence review preparation");

      const committed = atomicToolFeedbackSnapshot({
        dbPath,
        ruleNodeIds,
        decisionId,
        operationId: feedbackOperationId,
      });
      assert.ok(committed.commit_count > baseline.commit_count);
      assert.notEqual(committed.rule_feedback_rows, baseline.rule_feedback_rows);
      assert.notEqual(committed.rule_aggregate_rows, baseline.rule_aggregate_rows);
      assert.notEqual(committed.decision_row, baseline.decision_row);
      assert.notEqual(committed.pattern_rows, baseline.pattern_rows);
      assert.notEqual(committed.policy_rows, baseline.policy_rows);
      assert.notEqual(committed.feedback_event_rows, baseline.feedback_event_rows);
      assert.notEqual(committed.feedback_attribution_rows, baseline.feedback_attribution_rows);
      assert.notEqual(committed.write_operation_rows, baseline.write_operation_rows);
      assert.notEqual(committed.projection_job_rows, baseline.projection_job_rows);

      const replayCalls = {
        prepare: 0,
        persist: 0,
        read: 0,
        finalize: 0,
      };
      const replayKernel = healthyRuntime.learningKernel as any;
      replayKernel.prepareToolSelectionFeedback = async () => {
        replayCalls.prepare += 1;
        throw new Error("prepare must not run for an exact tool feedback replay");
      };
      replayKernel.persistToolSelectionFeedback = async () => {
        replayCalls.persist += 1;
        throw new Error("persist must not run for an exact tool feedback replay");
      };
      replayKernel.readToolRun = async () => {
        replayCalls.read += 1;
        throw new Error("run lifecycle reads must not run for an exact tool feedback replay");
      };
      replayKernel.finalizeToolSelectionFeedback = async () => {
        replayCalls.finalize += 1;
        throw new Error("finalize must not run for an exact tool feedback replay");
      };
      const embeddingCallsBeforeReplay = embeddingCalls;
      const reviewCallsBeforeReplay = reviewCalls;
      const replayed = await healthyRuntime.toolFeedback.execute(feedbackInput as any);
      assert.deepEqual(replayed, succeeded);
      assert.deepEqual(replayCalls, {
        prepare: 0,
        persist: 0,
        read: 0,
        finalize: 0,
      });
      assert.equal(embeddingCalls, embeddingCallsBeforeReplay);
      assert.equal(reviewCalls, reviewCallsBeforeReplay);
      assert.deepEqual(
        atomicToolFeedbackSnapshot({
          dbPath,
          ruleNodeIds,
          decisionId,
          operationId: feedbackOperationId,
        }),
        committed,
        "exact operation replay must not mutate any learning, episode, receipt, or projection row",
      );
    } finally {
      await healthyRuntime.close();
    }

    const db = createSqliteDatabase(dbPath);
    try {
      const attribution = db.prepare<Record<string, unknown>>(
        `SELECT attribution.*
         FROM lite_learning_feedback_attributions AS attribution
         JOIN lite_learning_episode_events AS event
           ON event.tenant_id = attribution.tenant_id
          AND event.scope = attribution.scope
          AND event.event_id = attribution.event_id
         WHERE event.operation_id = ?`,
      ).get(feedbackOperationId);
      assert.ok(attribution);
      assert.equal(attribution.subject_kind, "tool_decision");
      assert.equal(attribution.subject_id, decisionId);
      assert.equal(attribution.outcome, "positive");
      assert.equal(attribution.attribution_strength, "positive_attribution");
      assert.equal(attribution.evidence_class, "tool_decision");
      assert.equal(attribution.action_outcome, null);
      assert.equal(attribution.used_surface, null);
      assert.equal(attribution.exposure_action, null);
      assert.equal(attribution.boundary_outcome, "not_applicable");
      assert.equal(attribution.host_use_receipt_id, null);
      assert.equal(attribution.host_use_receipt_sha256, null);
      assert.equal(attribution.receipt_item_sha256, null);
      assert.equal(attribution.content_evidence_sha256, null);
      assert.equal(attribution.verifier_kind, null);
      assert.equal(attribution.verifier_version, null);
      assert.equal(attribution.verifier_config_sha256, null);
      assert.equal(attribution.verifier_status, null);
    } finally {
      db.close();
    }
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("observe operation receipt is stable across close/reopen and conflicts on content reuse", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-atomic-idempotency-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const input = combinedObserveInput("observe-stable-receipt");
  const firstRuntime = openAtomicRuntime(dbPath);
  const first = await firstRuntime.observe.execute(input as any, { principal: null });
  assert.equal(first.ok, true);
  assert.deepEqual((first.body as any).post_commit_projections, {
    semantic_commit: "committed",
    embedding: "not_requested",
    ann_sync: "not_requested",
  });
  let retryPrepareCalled = false;
  firstRuntime.memoryWrite.prepare = async () => {
    retryPrepareCalled = true;
    throw new Error("prepare must not run for a committed operation replay");
  };
  const sameProcessReplay = await firstRuntime.observe.execute(input as any, { principal: null });
  assert.deepEqual(sameProcessReplay, first);
  assert.equal(retryPrepareCalled, false);
  await firstRuntime.close();
  const afterFirst = tableCounts(dbPath);
  assert.equal(afterFirst.lite_memory_commits, 2);
  assert.ok(afterFirst.lite_memory_nodes >= 2);
  assert.equal(afterFirst.handoff_nodes, 1);
  assert.equal(afterFirst.lite_claim_ledger_claims, 1);
  assert.equal(afterFirst.lite_claim_ledger_events, 1);
  assert.equal(afterFirst.lite_runtime_write_operations, 1);
  assert.equal(afterFirst.lite_execution_states, 2);
  assert.equal(afterFirst.lite_execution_state_transitions, 1);
  assert.equal(afterFirst.execution_state_max_revision, 2);
  assert.ok(afterFirst.lite_execution_trees >= 1);
  assert.ok(afterFirst.lite_execution_tree_operations >= 1);
  assert.ok(afterFirst.execution_tree_max_revision >= 2);
  assert.ok(afterFirst.workflow_projection_max_observed_count >= 1);
  assert.ok(afterFirst.same_observe_lifecycle_relation_count >= 1);

  const reopened = openAtomicRuntime(dbPath);
  try {
    const replay = await reopened.observe.execute(input as any, { principal: null });
    assert.deepEqual(replay, first);
    assert.deepEqual(tableCounts(dbPath), afterFirst);

    const changed = combinedObserveInput("observe-stable-receipt");
    changed.nodes[0].text_summary = "Different content under the same operation id.";
    const conflict = await reopened.observe.execute(changed as any, { principal: null });
    assert.equal(conflict.ok, false);
    assert.equal(conflict.statusCode, 409);
    assert.equal((conflict.body as any).error, "observe_operation_id_conflict");
    assert.deepEqual(tableCounts(dbPath), afterFirst);
  } finally {
    await reopened.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("observe rejects nested memory and handoff identity overrides before any domain write", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-observe-nested-identity-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  try {
    const memoryConflict = await runtime.observe.execute({
      operation_id: "observe-nested-memory-identity",
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      memory: {
        tenant_id: "other-tenant",
        scope: "other-scope",
        actor: "other-actor",
        input_text: "must not cross the top-level observe boundary",
        auto_embed: false,
        nodes: [{
          client_id: "nested-memory-identity",
          type: "concept",
          title: "Nested identity override",
          text_summary: "This node must never be persisted.",
        }],
      },
      claims: [{
        contract_version: "aionis_claim_write_v1",
        client_id: "nested-memory-identity-claim",
        subject_key: "runtime:nested-identity",
        predicate: "status",
        value: { status: "rejected" },
        claim_kind: "execution_fact",
        conflict_policy: "multi_value",
        authority: "advisory",
        confidence: 0.9,
        evidence_refs: [],
      }],
    } as any, { principal: null });
    assert.equal(memoryConflict.ok, false);
    assert.equal(memoryConflict.statusCode, 400);
    assert.equal((memoryConflict.body as any).error, "observe_nested_identity_conflict");

    const handoffConflict = await runtime.observe.execute({
      operation_id: "observe-nested-handoff-identity",
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      handoff: {
        tenant_id: "other-tenant",
        scope: "other-scope",
        actor: "other-actor",
        handoff_kind: "task_handoff",
        anchor: "nested-handoff-identity",
        summary: "Nested handoff identity must not escape the observe boundary.",
        handoff_text: "Reject before persistence.",
      },
    } as any, { principal: null });
    assert.equal(handoffConflict.ok, false);
    assert.equal(handoffConflict.statusCode, 400);
    assert.equal((handoffConflict.body as any).error, "observe_nested_identity_conflict");
  } finally {
    await runtime.close();
  }

  for (const [table, count] of Object.entries(tableCounts(dbPath))) {
    assert.equal(count, 0, `${table} must remain empty after nested identity rejection`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test("observe rejects a stale execution state snapshot and rolls back memory, claims, and receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-observe-stale-state-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  const observedAt = "2026-07-12T01:00:00.000Z";
  const staleState = {
    version: 1 as const,
    state_id: "observe-stale-state",
    scope: "default",
    task_brief: "Reject stale state snapshots atomically",
    current_stage: "patch" as const,
    active_role: "patch" as const,
    owned_files: [],
    modified_files: [],
    pending_validations: [],
    completed_validations: [],
    last_accepted_hypothesis: null,
    rejected_paths: [],
    unresolved_blockers: [],
    rollback_notes: [],
    service_lifecycle_constraints: [],
    reviewer_contract: null,
    resume_anchor: null,
    updated_at: observedAt,
  };
  try {
    await runtime.writeStore.withTx(async () => {
      runtime.executionStateStore.initialize(staleState);
      runtime.executionStateStore.applyTransition({
        transition_id: "observe-stale-state:advance",
        state_id: staleState.state_id,
        scope: staleState.scope,
        actor_role: "review",
        at: "2026-07-12T01:01:00.000Z",
        type: "validation_added",
        validations: ["continuity advanced"],
        expected_revision: 1,
      });
    });
    const before = tableCounts(dbPath);
    const result = await runtime.observe.execute({
      operation_id: "observe-stale-state-write",
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "This write carries an obsolete execution snapshot.",
      auto_embed: false,
      nodes: [{
        client_id: "observe-stale-state-memory",
        type: "event",
        title: "Stale state overlay",
        text_summary: "The complete observe event must roll back.",
        slots: { execution_state_v1: staleState },
      }],
      claims: [{
        contract_version: "aionis_claim_write_v1",
        client_id: "observe-stale-state-claim",
        subject_key: "runtime:stale-state",
        predicate: "status",
        value: { status: "must-not-persist" },
        claim_kind: "execution_fact",
        conflict_policy: "multi_value",
        authority: "advisory",
        confidence: 0.9,
        evidence_refs: [],
      }],
    } as any, { principal: null });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal((result.body as any).error, "execution_state_snapshot_conflict");
    assert.deepEqual(tableCounts(dbPath), before);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("observe rejects a stale execution tree snapshot and rolls back the complete event", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-observe-stale-tree-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  const staleTree = createExecutionTreeV1({
    tree_id: "observe-stale-tree",
    scope: "default",
    task_brief: "Reject stale tree snapshots atomically",
    at: "2026-07-12T02:00:00.000Z",
  });
  try {
    await runtime.writeStore.withTx(async () => {
      runtime.executionTreeStore.initialize(staleTree);
      runtime.executionTreeStore.applyOperation({
        operation_id: "observe-stale-tree:advance",
        tree_id: staleTree.tree_id,
        scope: staleTree.scope,
        actor_role: "execute",
        at: "2026-07-12T02:01:00.000Z",
        type: "grow",
        action: "advance canonical tree",
        observation: "revision two",
        title: "Canonical advance",
        tool_name: null,
        refs: [],
        expected_revision: 1,
      });
    });
    const before = tableCounts(dbPath);
    const result = await runtime.observe.execute({
      operation_id: "observe-stale-tree-write",
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      input_text: "This write carries an obsolete execution tree snapshot.",
      auto_embed: false,
      nodes: [{
        client_id: "observe-stale-tree-memory",
        type: "event",
        title: "Stale tree overlay",
        text_summary: "The complete observe event must roll back.",
        slots: { execution_tree_v1: staleTree, execution_tree_disabled: true },
      }],
    } as any, { principal: null });
    assert.equal(result.ok, false);
    assert.equal(result.statusCode, 409);
    assert.equal((result.body as any).error, "execution_tree_snapshot_conflict");
    assert.deepEqual(tableCounts(dbPath), before);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("direct handoff builds its receipt inside the transaction so receipt failure rolls back memory", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-handoff-receipt-atomic-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  const tree = createExecutionTreeV1({
    tree_id: "handoff-receipt-atomic-tree",
    scope: "default",
    task_brief: "Receipt failure must roll back the handoff",
    at: "2026-07-12T03:00:00.000Z",
  });
  const originalGet = runtime.executionTreeStore.get.bind(runtime.executionTreeStore);
  runtime.executionTreeStore.get = () => {
    throw new Error("injected handoff receipt read failure");
  };
  try {
    await assert.rejects(
      runtime.handoffStore.store({
        tenant_id: "default",
        scope: "default",
        actor: "local-user",
        handoff_kind: "task_handoff",
        anchor: "handoff-receipt-atomic",
        summary: "The response receipt is part of the atomic handoff event.",
        handoff_text: "Roll back if the receipt cannot be constructed.",
        execution_tree_default_disabled: true,
        execution_tree_v1: tree,
      } as any),
      /injected handoff receipt read failure/,
    );
  } finally {
    runtime.executionTreeStore.get = originalGet;
    await runtime.close();
  }
  for (const [table, count] of Object.entries(tableCounts(dbPath))) {
    assert.equal(count, 0, `${table} must remain empty after handoff receipt rollback`);
  }
  fs.rmSync(directory, { recursive: true, force: true });
});

test("operation receipts cannot be inserted outside the shared Runtime transaction", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-operation-receipt-boundary-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const writeStore = createLiteWriteStore(dbPath);
  try {
    await assert.rejects(
      writeStore.insertWriteOperation({
        tenantId: "default",
        scope: "default",
        operationKind: "product_observe_v1",
        operationId: "outside-transaction",
        requestSha256: "a".repeat(64),
        receiptJson: "{}",
        commitId: null,
      }),
      /must be inserted inside the shared Runtime transaction/,
    );
    assert.equal(await writeStore.getWriteOperation({
      tenantId: "default",
      scope: "default",
      operationKind: "product_observe_v1",
      operationId: "outside-transaction",
    }), null);
  } finally {
    await writeStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("a prepared projection is rejected when another write advances its commit base", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-projection-stale-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const runtime = openAtomicRuntime(dbPath);
  try {
    const writeBody = (clientId: string) => ({
      tenant_id: "default",
      scope: "default",
      actor: "local-user",
      auto_embed: false,
      input_text: clientId,
      nodes: [{
        client_id: clientId,
        type: "concept",
        title: clientId,
        text_summary: `prepared projection ${clientId}`,
      }],
    });
    const firstPlan = await runtime.memoryWrite.prepare(writeBody("projection-first"));
    const stalePlan = await runtime.memoryWrite.prepare(writeBody("projection-stale"));
    await runtime.writeStore.withTx(() => runtime.memoryWrite.persist(firstPlan));
    await assert.rejects(
      runtime.writeStore.withTx(() => runtime.memoryWrite.persist(stalePlan)),
      (error: unknown) => {
        assert.equal((error as { statusCode?: number }).statusCode, 409);
        assert.equal((error as { code?: string }).code, "write_projection_stale");
        return true;
      },
    );
  } finally {
    await runtime.close();
  }
  const counts = tableCounts(dbPath);
  assert.equal(counts.lite_memory_commits, 1);
  assert.equal(counts.lite_memory_nodes, 1);
  fs.rmSync(directory, { recursive: true, force: true });
});

test("failing post-commit embedding and ANN keep semantic observe success and immutable receipt", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-post-commit-failure-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  let embedCalls = 0;
  let annCalls = 0;
  const runtime = openAtomicRuntime(dbPath, undefined, {
    embedder: {
      name: "failing:test",
      dim: 1536,
      async embed() {
        embedCalls += 1;
        throw new Error("injected embedding failure");
      },
    },
    annSync: {
      async syncNode() {
        annCalls += 1;
        throw new Error("injected ANN sync failure");
      },
      async deleteNode() {
        annCalls += 1;
        throw new Error("injected ANN delete failure");
      },
    },
  });
  const input = combinedObserveInput("observe-post-commit-failure");
  input.auto_embed = true;
  try {
    const first = await runtime.observe.execute(input as any, { principal: null });
    assert.equal(first.ok, true);
    assert.deepEqual((first.body as any).post_commit_projections, {
      semantic_commit: "committed",
      embedding: "scheduled",
      ann_sync: "scheduled",
    });
    assert.ok(embedCalls > 0);
    assert.ok(annCalls > 0);
    const replay = await runtime.observe.execute(input as any, { principal: null });
    assert.deepEqual(replay, first);
    assert.equal(tableCounts(dbPath).lite_runtime_write_operations, 1);
  } finally {
    await runtime.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

test("route services reject execution stores from a different transaction runner", async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aionis-uow-identity-"));
  const dbPath = path.join(directory, "runtime.sqlite");
  const writeStore = createLiteWriteStore(dbPath);
  const stateStore = createLiteExecutionStateStore(dbPath);
  const treeStore = createLiteExecutionTreeStore(dbPath);
  const claimDatabase = createLiteRuntimeDatabase(path.join(directory, "claims.sqlite"));
  const claimStore = createLiteClaimLedgerStoreFromDatabase(claimDatabase, { closeDatabaseOnClose: true });
  const claimLedgerAccess = claimStore.createClaimLedgerAccess();
  try {
    assert.throws(
      () => createMemoryWriteRouteService({
        env: atomicEnv(),
        embedder: null,
        liteWriteStore: writeStore,
        executionStateStore: stateStore,
      }),
      /must share the Lite write transaction runner/,
    );
    assert.throws(
      () => createHandoffRouteService({
        env: atomicEnv(),
        embedder: null,
        liteWriteStore: writeStore,
        executionTreeStore: treeStore,
      }),
      /must share the Lite write transaction runner/,
    );
    assert.throws(
      () => createProductObserveService({
        defaultTenantId: "default",
        defaultScope: "default",
        atomicWrite: writeStore,
        memoryWrite: null,
        handoffStore: null,
        claimLedgerAccess,
      }),
      /claim ledger must share the atomic write transaction runner/,
    );
  } finally {
    await claimStore.close();
    await treeStore.close();
    await stateStore.close();
    await writeStore.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
